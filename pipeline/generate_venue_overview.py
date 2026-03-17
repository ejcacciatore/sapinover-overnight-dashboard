"""
generate_venue_overview.py - Three-Venue Overnight Session Overview
====================================================================
Reads raw data from all three ATS venues (BlueOcean, Bruce, Moon),
fetches Prior Close from yfinance, enriches with Symbol Master metadata,
calculates overnight indication (VWAP vs Prior Close), and outputs a
growing JSON file for the Session Overview dashboard.

Usage:
    python generate_venue_overview.py                # Process today's data
    python generate_venue_overview.py --date 2026-03-02  # Specific date
    python generate_venue_overview.py --dry-run       # Show what would be processed

Output:
    BlueOcean/venue_overview.json (append-only, grows daily)

Sapinover LLC | Overnight Trading Research Platform
"""

import os
import sys
import json
import glob
import time
import argparse
import numpy as np
import pandas as pd
import yfinance as yf
import requests as _requests
from datetime import datetime, date, timedelta

# =============================================================================
# CONSTANTS
# =============================================================================

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
BLUEOCEAN_DIR = os.path.join(BASE_DIR, "BlueOcean")
SYMBOL_MASTER_PATH = os.path.join(BLUEOCEAN_DIR, "BlueOcean_Symbol_Master.csv")
OUTPUT_JSON_PATH = os.path.join(BLUEOCEAN_DIR, "venue_overview.json")

MASTER_PARQUET_PATH = os.path.join(BLUEOCEAN_DIR, "BlueOcean_Master_Historical.parquet")

INSTITUTIONAL_MIN_NOTIONAL = 50_000
TOP_TICKERS_COUNT = 100
DIRECTION_BINS = [-500, -200, -100, -50, -25, 0, 25, 50, 100, 200, 500]
HISTORICAL_LOOKBACK_DAYS = 20

# yfinance batching
YF_BATCH_SIZE = 500
YF_BATCH_DELAY = 2  # seconds between batches

# FMP (Financial Modeling Prep) fallback - free tier: 250 calls/day
FMP_API_KEY = os.environ.get("FMP_API_KEY", "")

# Venue anonymization for public-facing JSON output (FINRA 2241 / venue anonymity)
# Internal code uses descriptive names; JSON keys use generic identifiers
VENUE_ANON = {
    "boats": "venue1",
    "bruce": "venue2",
    "moon":  "venue3",
}
OVERLAP_ANON = {
    "boatsBruce": "v1v2",
    "boatsMoon":  "v1v3",
    "bruceMoon":  "v2v3",
    "boatsOnly":  "v1Only",
    "bruceOnly":  "v2Only",
    "moonOnly":   "v3Only",
}

SCAN_DIRS = [
    BASE_DIR,
    os.path.join(BASE_DIR, "2025-09"),
    os.path.join(BASE_DIR, "2025-11"),
    os.path.join(BASE_DIR, "2025-12"),
    os.path.join(BASE_DIR, "2026-01"),
    os.path.join(BASE_DIR, "2026-02"),
    os.path.join(BASE_DIR, "2026-03"),
]


# =============================================================================
# TICKER NORMALIZATION
# =============================================================================

def convert_ticker_yf(ticker):
    """Convert ticker to yfinance format."""
    if not isinstance(ticker, str):
        return str(ticker)
    ticker = ticker.strip().upper()
    replacements = {
        "BF.A": "BF-A", "BF.B": "BF-B",
        "BRK.A": "BRK-A", "BRK.B": "BRK-B",
    }
    return replacements.get(ticker, ticker.replace(".", "-") if "." in ticker else ticker)


# =============================================================================
# FILE DISCOVERY
# =============================================================================

def find_todays_files(target_date):
    """Locate BOATS xlsx, Bruce csv, Moon csv for a given date.
    Returns dict: {'boats': path|None, 'bruce': path|None, 'moon': path|None}
    """
    ds_compact = target_date.strftime("%Y%m%d")     # 20260302
    ds_dashed = target_date.strftime("%Y-%m-%d")     # 2026-03-02
    month_dir = os.path.join(BASE_DIR, target_date.strftime("%Y-%m"))

    search_dirs = [BASE_DIR, month_dir] if os.path.isdir(month_dir) else [BASE_DIR]
    # Also check all SCAN_DIRS
    for sd in SCAN_DIRS:
        if os.path.isdir(sd) and sd not in search_dirs:
            search_dirs.append(sd)

    result = {"boats": None, "bruce": None, "moon": None}

    for d in search_dirs:
        # BOATS: prefer xlsx over csv
        xlsx = os.path.join(d, f"Market_Data_Statistics_{ds_compact}.xlsx")
        csv = os.path.join(d, f"Market_Data_Statistics_{ds_compact}.csv")
        if os.path.exists(xlsx) and result["boats"] is None:
            result["boats"] = xlsx
        elif os.path.exists(csv) and result["boats"] is None:
            result["boats"] = csv

        # Bruce
        bruce = os.path.join(d, f"{ds_dashed}_Bruce_DailyActivity.csv")
        if os.path.exists(bruce) and result["bruce"] is None:
            result["bruce"] = bruce

        # Moon (two naming conventions)
        moon_new = os.path.join(d, f"MOON_ATS_MostActive_{ds_dashed}.csv")
        moon_old = os.path.join(d, f"MOON_ATS_{ds_compact}.csv")
        if os.path.exists(moon_new) and result["moon"] is None:
            result["moon"] = moon_new
        elif os.path.exists(moon_old) and result["moon"] is None:
            result["moon"] = moon_old

    return result


# =============================================================================
# VENUE PARSERS (adapted from combine_feb_data.py)
# =============================================================================

def parse_boats(filepath, trade_date_str):
    """Parse BOATS xlsx/csv. Standardize columns, apply institutional filter."""
    if filepath.endswith(".csv"):
        df = pd.read_csv(filepath)
    else:
        df = pd.read_excel(filepath)

    col_map = {
        "Symbol": "Symbol",
        "Average Spread": "Average_Spread",
        "Average Bid Size": "Avg_Bid_Size",
        "Average Offer Size": "Avg_Offer_Size",
        "Notional": "Notional",
        "Executions": "Trades",
        "Volume": "Volume",
        "Open": "Open", "Hi": "High", "Lo": "Low", "Close": "Close",
    }
    if "VWAP" in df.columns:
        col_map["VWAP"] = "VWAP"

    df = df.rename(columns=col_map)

    # Clean numeric columns
    num_cols = ["Notional", "Average_Spread", "Open", "High", "Low",
                "Close", "Volume", "Trades", "Avg_Bid_Size", "Avg_Offer_Size"]
    if "VWAP" in df.columns:
        num_cols.append("VWAP")
    for col in num_cols:
        if col in df.columns:
            df[col] = (df[col].astype(str)
                       .str.replace("$", "", regex=False)
                       .str.replace(",", "", regex=False)
                       .str.strip())
            df[col] = pd.to_numeric(df[col], errors="coerce")

    # Institutional filter
    df = df[(df["Notional"] >= INSTITUTIONAL_MIN_NOTIONAL) & (df["Volume"] > 0)].copy()

    # Derive VWAP from Notional / Volume (same as main pipeline)
    if "VWAP" not in df.columns or df["VWAP"].isna().all():
        df["VWAP"] = df["Notional"] / df["Volume"]

    df["Trade_Date"] = trade_date_str
    df["Venue"] = "boats"
    return df


def parse_bruce(filepath, trade_date_str):
    """Parse Bruce CSV. Standardize columns, apply institutional filter."""
    df = pd.read_csv(filepath)

    col_map = {
        "Symbol": "Symbol",
        "AvgSpread": "Average_Spread",
        "AvgBidSize": "Avg_Bid_Size",
        "AvgOfferSize": "Avg_Offer_Size",
        "Notional": "Notional",
        "Trades": "Trades",
        "Volume": "Volume",
        "VWAP": "VWAP",
        "Open": "Open", "High": "High", "Low": "Low", "Close": "Close",
    }
    df = df.rename(columns=col_map)

    num_cols = ["Average_Spread", "Notional", "Open", "High", "Low",
                "Close", "VWAP", "Volume", "Trades", "Avg_Bid_Size", "Avg_Offer_Size"]
    for col in num_cols:
        if col in df.columns:
            df[col] = (df[col].astype(str)
                       .str.replace("$", "", regex=False)
                       .str.replace(",", "", regex=False)
                       .str.replace("N/A", "", regex=False)
                       .str.strip())
            df[col] = pd.to_numeric(df[col], errors="coerce")

    if "RefDate" in df.columns:
        df = df.drop(columns=["RefDate"])

    # Institutional filter
    df = df[(df["Notional"] >= INSTITUTIONAL_MIN_NOTIONAL) & (df["Volume"] > 0)].copy()

    df["Trade_Date"] = trade_date_str
    df["Venue"] = "bruce"
    return df


def parse_moon(filepath, trade_date_str):
    """Parse Moon CSV. Derive VWAP from $ Volume / Share Volume."""
    df = pd.read_csv(filepath)

    col_map = {}
    if "$ Vol" in df.columns:
        col_map["$ Vol"] = "Notional"
        col_map["Share Vol"] = "Volume"
    elif "$ Volume" in df.columns:
        col_map["$ Volume"] = "Notional"
        col_map["Share Volume"] = "Volume"

    col_map.update({
        "Symbol": "Symbol",
        "Price": "Close",
        "% Change": "Pct_Change",
        "Trades": "Trades",
    })
    df = df.rename(columns=col_map)

    num_cols = ["Notional", "Volume", "Trades", "Close", "Pct_Change"]
    for col in num_cols:
        if col in df.columns:
            df[col] = (df[col].astype(str)
                       .str.replace("$", "", regex=False)
                       .str.replace(",", "", regex=False)
                       .str.strip())
            df[col] = pd.to_numeric(df[col], errors="coerce")

    # Derive VWAP from dollar volume / share volume
    df["VWAP"] = np.where(df["Volume"] > 0, df["Notional"] / df["Volume"], np.nan)

    # Moon is already curated (most active), no institutional filter needed
    df = df[df["Volume"] > 0].copy()

    df["Trade_Date"] = trade_date_str
    df["Venue"] = "moon"
    return df


# =============================================================================
# MARKET DATA
# =============================================================================

def _yf_batch_download(yf_symbols, start_date, end_date, target_str, sym_map):
    """Download a single batch of symbols from yfinance.
    Returns dict {original_symbol: prior_close_price}.
    """
    prior_closes = {}
    try:
        data = yf.download(
            yf_symbols,
            start=start_date.strftime("%Y-%m-%d"),
            end=end_date.strftime("%Y-%m-%d"),
            progress=False,
            threads=True,
        )
    except Exception as e:
        print(f"    Batch failed: {e}")
        return prior_closes

    if data.empty:
        return prior_closes

    # Extract Close data - handle both single and multi-symbol returns
    # Newer yfinance may use MultiIndex columns even for single symbols
    if isinstance(data.columns, pd.MultiIndex):
        close_data = data.get("Close", pd.DataFrame())
    elif "Close" in data.columns:
        close_data = data[["Close"]].rename(columns={"Close": yf_symbols[0]})
    else:
        return prior_closes

    if close_data.empty:
        return prior_closes

    mask = close_data.index < pd.Timestamp(target_str)
    if not mask.any():
        return prior_closes

    last_row = close_data.loc[mask].iloc[-1]
    for orig, yf_t in sym_map.items():
        if yf_t in last_row.index:
            val = last_row[yf_t]
            try:
                fval = float(val)
                if not np.isnan(fval):
                    prior_closes[orig] = fval
            except (ValueError, TypeError):
                pass

    return prior_closes


def _fmp_fetch_prior_close(symbols, trade_date):
    """Fallback: fetch prior close from Financial Modeling Prep.
    Uses batch quote endpoint (up to 300 symbols per call).
    Returns dict {symbol: prior_close_price}.
    """
    if not FMP_API_KEY:
        print("  FMP fallback: no API key (set FMP_API_KEY env var)")
        return {}

    prior_closes = {}
    batch_size = 300  # FMP batch limit
    batches = [symbols[i:i+batch_size] for i in range(0, len(symbols), batch_size)]
    print(f"  FMP fallback: fetching {len(symbols)} symbols in {len(batches)} batches...")

    for batch in batches:
        tickers = ",".join(batch)
        url = f"https://financialmodelingprep.com/api/v3/quote/{tickers}?apikey={FMP_API_KEY}"
        try:
            resp = _requests.get(url, timeout=30)
            if resp.status_code == 200:
                quotes = resp.json()
                for q in quotes:
                    sym = q.get("symbol", "")
                    prev_close = q.get("previousClose")
                    if sym and prev_close and prev_close > 0:
                        prior_closes[sym] = float(prev_close)
            elif resp.status_code == 429:
                print(f"    FMP rate limited, stopping fallback")
                break
            else:
                print(f"    FMP error {resp.status_code}")
        except Exception as e:
            print(f"    FMP request failed: {e}")
        time.sleep(0.5)  # Respect FMP rate limits

    print(f"  FMP fallback: got {len(prior_closes)} prices")
    return prior_closes


def fetch_prior_close(symbols, trade_date):
    """Fetch prior day's closing price for all symbols.

    Strategy:
    1. yfinance in batches of 500 with 2s delay between batches
    2. If any symbols still missing, fall back to FMP (Financial Modeling Prep)

    Returns dict {symbol: prior_close_price}.
    """
    if not symbols:
        return {}

    # Normalize tickers for yfinance
    sym_map = {s: convert_ticker_yf(s) for s in symbols}
    yf_symbols = list(set(sym_map.values()))

    end_date = trade_date + timedelta(days=1)
    start_date = trade_date - timedelta(days=10)
    target_str = trade_date.strftime("%Y-%m-%d")

    print(f"  Fetching prior close for {len(yf_symbols):,} symbols...")

    # Step 1: yfinance in batches
    prior_closes = {}
    batches = [yf_symbols[i:i+YF_BATCH_SIZE]
               for i in range(0, len(yf_symbols), YF_BATCH_SIZE)]

    for i, batch in enumerate(batches):
        if i > 0:
            time.sleep(YF_BATCH_DELAY)
        batch_result = _yf_batch_download(batch, start_date, end_date, target_str, sym_map)
        prior_closes.update(batch_result)
        pct = len(prior_closes) / len(symbols) * 100
        print(f"    Batch {i+1}/{len(batches)}: +{len(batch_result)}, "
              f"total {len(prior_closes)}/{len(symbols)} ({pct:.0f}%)")

    # Step 2: FMP fallback for missing symbols
    missing = [s for s in symbols if s not in prior_closes]
    if missing and FMP_API_KEY:
        fmp_result = _fmp_fetch_prior_close(missing, trade_date)
        prior_closes.update(fmp_result)

    print(f"  Got prior close for {len(prior_closes):,} / {len(symbols):,} symbols")
    return prior_closes


def fetch_trade_date_prices(symbols, trade_date):
    """Fetch Open and Close on trade_date itself (Next_Open / Next_Close).

    For ATS sessions on date D, the 'next' regular-session prices are:
      Next_Open  = Open  on D (ATS runs pre-market, market opens on D)
      Next_Close = Close on D

    Returns two dicts: {symbol: open_price}, {symbol: close_price}
    """
    if not symbols:
        return {}, {}

    sym_map = {s: convert_ticker_yf(s) for s in symbols}
    yf_symbols = list(set(sym_map.values()))

    # Download trade_date to trade_date+2 (need +2 to capture the trade_date row)
    start_str = trade_date.strftime("%Y-%m-%d")
    end_str = (trade_date + timedelta(days=2)).strftime("%Y-%m-%d")

    print(f"  Fetching trade-date Open/Close for {len(yf_symbols):,} symbols...")

    next_opens = {}
    next_closes = {}

    batches = [yf_symbols[i:i + YF_BATCH_SIZE]
               for i in range(0, len(yf_symbols), YF_BATCH_SIZE)]

    for i, batch in enumerate(batches):
        if i > 0:
            time.sleep(YF_BATCH_DELAY)
        try:
            data = yf.download(batch, start=start_str, end=end_str,
                               progress=False, threads=True)
        except Exception as e:
            print(f"    Batch {i + 1} failed: {e}")
            continue

        if data.empty:
            continue

        # Extract Open and Close
        if isinstance(data.columns, pd.MultiIndex):
            open_data = data.get("Open", pd.DataFrame())
            close_data = data.get("Close", pd.DataFrame())
        elif "Open" in data.columns and "Close" in data.columns:
            open_data = data[["Open"]].rename(columns={"Open": batch[0]})
            close_data = data[["Close"]].rename(columns={"Close": batch[0]})
        else:
            continue

        # Find rows matching trade_date
        target_ts = pd.Timestamp(trade_date)
        for df_prices, out_dict in [(open_data, next_opens), (close_data, next_closes)]:
            if df_prices.empty:
                continue
            mask = df_prices.index == target_ts
            if not mask.any():
                # Try matching just the date portion
                mask = df_prices.index.normalize() == target_ts
            if not mask.any():
                continue
            row = df_prices.loc[mask].iloc[0]
            for orig, yf_t in sym_map.items():
                if yf_t in row.index:
                    try:
                        fval = float(row[yf_t])
                        if not np.isnan(fval):
                            out_dict[orig] = fval
                    except (ValueError, TypeError):
                        pass

        pct = len(next_opens) / max(len(symbols), 1) * 100
        print(f"    Batch {i + 1}/{len(batches)}: "
              f"{len(next_opens)} opens, {len(next_closes)} closes ({pct:.0f}%)")

    print(f"  Got trade-date prices: {len(next_opens):,} opens, "
          f"{len(next_closes):,} closes / {len(symbols):,} symbols")
    return next_opens, next_closes


# =============================================================================
# ENRICHMENT
# =============================================================================

def load_symbol_master():
    """Load the Symbol Master CSV for metadata enrichment."""
    if not os.path.exists(SYMBOL_MASTER_PATH):
        print(f"  WARNING: Symbol Master not found at {SYMBOL_MASTER_PATH}")
        return pd.DataFrame()

    sm = pd.read_csv(SYMBOL_MASTER_PATH)
    print(f"  Symbol Master loaded: {len(sm):,} symbols")
    return sm


def enrich_with_metadata(df, symbol_master):
    """Left join Symbol Master metadata onto venue data."""
    if symbol_master.empty:
        df["Sector"] = "Unknown"
        df["Company_Name"] = ""
        df["Market_Cap"] = np.nan
        df["Asset_Type"] = "Stock"
        return df

    meta_cols = ["Symbol"]
    for col in ["Sector", "Industry", "Market_Cap", "Asset_Type", "Company_Name", "ETF_Category"]:
        if col in symbol_master.columns:
            meta_cols.append(col)

    sm_subset = symbol_master[meta_cols].drop_duplicates(subset="Symbol", keep="last")
    df = df.merge(sm_subset, on="Symbol", how="left")

    # Fill missing sectors
    df["Sector"] = df["Sector"].fillna("Unknown")
    df["Company_Name"] = df["Company_Name"].fillna("")
    df["Asset_Type"] = df["Asset_Type"].fillna("Stock")

    return df


def calculate_overnight_indication(df, prior_closes, next_opens=None, next_closes=None):
    """Calculate indication, refGap, and totalGap in bps.

    Indication = (VWAP - Prior_Close) / Prior_Close * 10000
    refGap     = (Next_Open - Prior_Close) / Prior_Close * 10000
    totalGap   = (Next_Close - Prior_Close) / Prior_Close * 10000

    Handles venues without VWAP gracefully.
    """
    df["Prior_Close"] = df["Symbol"].map(prior_closes)
    df["Next_Open"] = df["Symbol"].map(next_opens or {})
    df["Next_Close"] = df["Symbol"].map(next_closes or {})

    # Ensure VWAP column exists (some BOATS files lack it)
    if "VWAP" not in df.columns:
        df["VWAP"] = np.nan

    # Calculate indication where both VWAP and Prior_Close exist
    mask = df["VWAP"].notna() & df["Prior_Close"].notna() & (df["Prior_Close"] > 0)
    df["Indication_bps"] = np.where(
        mask,
        (df["VWAP"] - df["Prior_Close"]) / df["Prior_Close"] * 10000,
        np.nan
    )

    # Reference gap: (Next_Open - Prior_Close) / Prior_Close * 10000
    mask_rg = df["Next_Open"].notna() & df["Prior_Close"].notna() & (df["Prior_Close"] > 0)
    df["Ref_Gap_bps"] = np.where(
        mask_rg,
        (df["Next_Open"] - df["Prior_Close"]) / df["Prior_Close"] * 10000,
        np.nan
    )

    # Total gap: (Next_Close - Prior_Close) / Prior_Close * 10000
    mask_tg = df["Next_Close"].notna() & df["Prior_Close"].notna() & (df["Prior_Close"] > 0)
    df["Total_Gap_bps"] = np.where(
        mask_tg,
        (df["Next_Close"] - df["Prior_Close"]) / df["Prior_Close"] * 10000,
        np.nan
    )

    # Flag direction
    df["Direction"] = np.where(df["Indication_bps"] > 0, "UP", "DOWN")
    df.loc[df["Indication_bps"].isna(), "Direction"] = None

    return df


# =============================================================================
# HISTORICAL AVERAGES (from Master Parquet)
# =============================================================================

def load_historical_averages(target_date, lookback=HISTORICAL_LOOKBACK_DAYS):
    """Compute per-symbol average notional/volume from the last N trading days
    in the master parquet. Also returns venue-level daily averages.

    Returns:
        sym_avgs: dict {symbol: {avgNotional, avgVolume, daysTraded}}
        venue_avgs: dict {dailyNotional, dailyVolume, dailySymbols, tradingDays}
    """
    if not os.path.exists(MASTER_PARQUET_PATH):
        print(f"  WARNING: Master parquet not found at {MASTER_PARQUET_PATH}")
        return {}, {}

    try:
        pq = pd.read_parquet(MASTER_PARQUET_PATH,
                             columns=["Symbol", "Trade_Date", "Notional", "Volume"])
    except Exception as e:
        print(f"  WARNING: Failed to read master parquet: {e}")
        return {}, {}

    target_ts = pd.Timestamp(target_date)

    # Get the last N trading days BEFORE the target date
    all_dates = sorted(pq["Trade_Date"].unique())
    prior_dates = [d for d in all_dates if d < target_ts]

    if len(prior_dates) == 0:
        print(f"  WARNING: No historical dates before {target_date}")
        return {}, {}

    window_dates = prior_dates[-lookback:]
    window = pq[pq["Trade_Date"].isin(window_dates)].copy()

    actual_days = len(window_dates)
    print(f"  Historical window: {actual_days} days "
          f"({window_dates[0].strftime('%Y-%m-%d')} to {window_dates[-1].strftime('%Y-%m-%d')})")
    print(f"  Window rows: {len(window):,}, symbols: {window['Symbol'].nunique():,}")

    # Per-symbol averages
    sym_stats = window.groupby("Symbol").agg(
        avgNotional=("Notional", "mean"),
        avgVolume=("Volume", "mean"),
        daysTraded=("Trade_Date", "nunique"),
    )

    sym_avgs = {}
    for sym, row in sym_stats.iterrows():
        sym_avgs[sym] = {
            "avgNotional": float(row["avgNotional"]),
            "avgVolume": float(row["avgVolume"]),
            "daysTraded": int(row["daysTraded"]),
        }

    # Venue-level daily averages
    daily = window.groupby("Trade_Date").agg(
        totalNotional=("Notional", "sum"),
        totalVolume=("Volume", "sum"),
        uniqueSymbols=("Symbol", "nunique"),
    )

    venue_avgs = {
        "dailyNotional": float(daily["totalNotional"].mean()),
        "dailyVolume": float(daily["totalVolume"].mean()),
        "dailySymbols": float(daily["uniqueSymbols"].mean()),
        "tradingDays": actual_days,
    }

    return sym_avgs, venue_avgs


# =============================================================================
# METRIC COMPUTATION
# =============================================================================

def compute_venue_summary(df, venue_name, venue_avgs=None):
    """Compute aggregate summary stats for one venue on one date."""
    total_notional = float(df["Notional"].sum())
    total_volume = int(df["Volume"].sum())

    summary = {
        "notional": total_notional,
        "volume": total_volume,
        "trades": int(df["Trades"].sum()) if "Trades" in df.columns else 0,
        "symbols": int(df["Symbol"].nunique()),
    }

    # Historical comparison (venue-level, BOATS-sourced)
    if venue_avgs and venue_avgs.get("dailyNotional"):
        summary["histAvgNotional"] = round(venue_avgs["dailyNotional"], 0)
        summary["notionalVsAvg"] = round(total_notional / venue_avgs["dailyNotional"], 3)
        summary["histAvgVolume"] = round(venue_avgs["dailyVolume"], 0)
        summary["histTradingDays"] = venue_avgs["tradingDays"]

    # Spread/depth (BOATS + Bruce only)
    if "Average_Spread" in df.columns:
        valid_spread = df["Average_Spread"].dropna()
        summary["avgSpreadDollars"] = float(valid_spread.mean()) if len(valid_spread) > 0 else None
    else:
        summary["avgSpreadDollars"] = None

    if "Avg_Bid_Size" in df.columns:
        summary["avgBidSize"] = float(df["Avg_Bid_Size"].dropna().mean()) if df["Avg_Bid_Size"].notna().any() else None
    else:
        summary["avgBidSize"] = None

    if "Avg_Offer_Size" in df.columns:
        summary["avgOfferSize"] = float(df["Avg_Offer_Size"].dropna().mean()) if df["Avg_Offer_Size"].notna().any() else None
    else:
        summary["avgOfferSize"] = None

    # Overnight indication stats
    valid_ind = df["Indication_bps"].dropna()
    if len(valid_ind) > 0:
        up_count = (valid_ind > 0).sum()
        total_with_ind = len(valid_ind)
        summary["netIndicationBps"] = round(float(valid_ind.mean()), 2)
        summary["medianIndicationBps"] = round(float(valid_ind.median()), 2)
        summary["pctUp"] = round(float(up_count / total_with_ind * 100), 1)
        summary["stdIndicationBps"] = round(float(valid_ind.std()), 2)
        summary["symbolsWithIndication"] = int(total_with_ind)
    else:
        summary["netIndicationBps"] = None
        summary["medianIndicationBps"] = None
        summary["pctUp"] = None
        summary["stdIndicationBps"] = None
        summary["symbolsWithIndication"] = 0

    return summary


def compute_top_tickers(df, sym_to_idx, sym_avgs=None, n=TOP_TICKERS_COUNT):
    """Top N tickers by notional.
    Returns list of [symIdx, notional, volume, trades, vwap, indicationBps,
                     relNotional, relVolume, avgSpread, avgBidSize, avgOfferSize,
                     marketCap, priorClose, refGapBps, totalGapBps].
    relNotional/relVolume are today's value divided by 20-day average (1.0 = average).
    avgSpread/avgBidSize/avgOfferSize: per-ticker liquidity metrics (BOATS + Bruce only;
    Moon returns 0 for all three since that venue does not publish spread/depth data).
    """
    top = df.nlargest(n, "Notional")
    result = []
    for _, row in top.iterrows():
        sym = row["Symbol"]
        idx = sym_to_idx.get(sym, -1)

        # Relative metrics vs historical average
        rel_notional = None
        rel_volume = None
        if sym_avgs and sym in sym_avgs:
            hist = sym_avgs[sym]
            if hist["avgNotional"] > 0:
                rel_notional = round(float(row["Notional"]) / hist["avgNotional"], 2)
            if hist["avgVolume"] > 0:
                rel_volume = round(float(row["Volume"]) / hist["avgVolume"], 2)

        # Spread and depth (BOATS + Bruce have these; Moon does not)
        avg_spread = round(float(row["Average_Spread"]), 4) if pd.notna(row.get("Average_Spread")) else 0
        avg_bid_sz = int(row["Avg_Bid_Size"]) if pd.notna(row.get("Avg_Bid_Size")) else 0
        avg_ofr_sz = int(row["Avg_Offer_Size"]) if pd.notna(row.get("Avg_Offer_Size")) else 0

        # Market data fields
        mkt_cap = round(float(row["Market_Cap"]), 0) if pd.notna(row.get("Market_Cap")) else None
        prior_cl = round(float(row["Prior_Close"]), 4) if pd.notna(row.get("Prior_Close")) else None
        ref_gap = round(float(row["Ref_Gap_bps"]), 2) if pd.notna(row.get("Ref_Gap_bps")) else None
        total_gap = round(float(row["Total_Gap_bps"]), 2) if pd.notna(row.get("Total_Gap_bps")) else None

        result.append([
            idx,                                                                          # [0]
            round(float(row["Notional"]), 2),                                             # [1]
            int(row["Volume"]),                                                           # [2]
            int(row.get("Trades", 0)),                                                    # [3]
            round(float(row["VWAP"]), 4) if pd.notna(row.get("VWAP")) else None,         # [4]
            round(float(row["Indication_bps"]), 2) if pd.notna(row.get("Indication_bps")) else None,  # [5]
            rel_notional,                                                                 # [6]
            rel_volume,                                                                   # [7]
            avg_spread,                                                                   # [8]
            avg_bid_sz,                                                                   # [9]
            avg_ofr_sz,                                                                   # [10]
            mkt_cap,                                                                      # [11]
            prior_cl,                                                                     # [12]
            ref_gap,                                                                      # [13]
            total_gap,                                                                    # [14]
        ])
    return result


def compute_sector_distribution(df, sector_to_idx):
    """Sector breakdown. Returns list of [sectorIdx, totalNotional, symbolCount]."""
    grouped = df.groupby("Sector").agg(
        totalNotional=("Notional", "sum"),
        symbolCount=("Symbol", "nunique")
    ).reset_index()

    result = []
    for _, row in grouped.iterrows():
        idx = sector_to_idx.get(row["Sector"], -1)
        result.append([
            idx,
            round(float(row["totalNotional"]), 2),
            int(row["symbolCount"]),
        ])

    # Sort by notional descending
    result.sort(key=lambda x: x[1], reverse=True)
    return result


def compute_direction_histogram(df):
    """Bin indication_bps into histogram for chart rendering."""
    valid = df["Indication_bps"].dropna()
    if len(valid) == 0:
        return {"bins": DIRECTION_BINS, "counts": [0] * (len(DIRECTION_BINS) - 1)}

    counts, _ = np.histogram(valid.clip(DIRECTION_BINS[0], DIRECTION_BINS[-1]), bins=DIRECTION_BINS)
    return {
        "bins": DIRECTION_BINS,
        "counts": [int(c) for c in counts],
    }


def compute_cross_venue_overlap(venue_dfs, sym_to_idx):
    """Compute symbol overlap across venues."""
    sym_sets = {}
    for venue, df in venue_dfs.items():
        if df is not None and len(df) > 0:
            sym_sets[venue] = set(df["Symbol"].unique())
        else:
            sym_sets[venue] = set()

    boats = sym_sets.get("boats", set())
    bruce = sym_sets.get("bruce", set())
    moon = sym_sets.get("moon", set())

    all3 = boats & bruce & moon
    boats_bruce = (boats & bruce) - all3
    boats_moon = (boats & moon) - all3
    bruce_moon = (bruce & moon) - all3
    boats_only = boats - bruce - moon
    bruce_only = bruce - boats - moon
    moon_only = moon - boats - bruce

    def to_idx_list(sym_set):
        return sorted([sym_to_idx[s] for s in sym_set if s in sym_to_idx])

    return {
        "all3": to_idx_list(all3),
        OVERLAP_ANON["boatsBruce"]: to_idx_list(boats_bruce),
        OVERLAP_ANON["boatsMoon"]: to_idx_list(boats_moon),
        OVERLAP_ANON["bruceMoon"]: to_idx_list(bruce_moon),
        OVERLAP_ANON["boatsOnly"]: to_idx_list(boats_only),
        OVERLAP_ANON["bruceOnly"]: to_idx_list(bruce_only),
        OVERLAP_ANON["moonOnly"]: to_idx_list(moon_only),
        "counts": {
            "all3": len(all3),
            "twoVenues": len(boats_bruce) + len(boats_moon) + len(bruce_moon),
            "oneVenue": len(boats_only) + len(bruce_only) + len(moon_only),
            "total": len(boats | bruce | moon),
        }
    }


def compute_watchlist(venue_dfs, sym_to_idx, sector_to_idx, sym_avgs=None):
    """Build combined watchlist: every symbol across all venues, aggregated.

    Returns list of compact arrays, sorted by total notional descending:
    [symIdx, totalNotional, totalVolume, totalTrades, weightedVwap,
     indicationBps, relNotional, sectorIdx, venueFlags]

    venueFlags: bitmask  1=venue1, 2=venue2, 4=venue3
    """
    VENUE_BITS = {"boats": 1, "bruce": 2, "moon": 4}

    # Aggregate per-symbol across venues
    agg = {}  # sym -> {notional, volume, trades, vwap_num, vwap_den, ind, sector, flags}
    for venue, df in venue_dfs.items():
        if df is None or len(df) == 0:
            continue
        bit = VENUE_BITS.get(venue, 0)
        for _, row in df.iterrows():
            sym = row["Symbol"]
            if not isinstance(sym, str) or not sym:
                continue
            if sym not in agg:
                agg[sym] = {
                    "notional": 0.0, "volume": 0, "trades": 0,
                    "vwap_num": 0.0, "vwap_den": 0,
                    "ind": None, "ind_vol": 0,
                    "sector": row.get("Sector", "Unknown"),
                    "flags": 0,
                }
            a = agg[sym]
            a["notional"] += float(row["Notional"])
            a["volume"] += int(row["Volume"])
            a["trades"] += int(row.get("Trades", 0))
            # Volume-weighted VWAP
            vwap = row.get("VWAP")
            vol = int(row["Volume"])
            if pd.notna(vwap) and vol > 0:
                a["vwap_num"] += float(vwap) * vol
                a["vwap_den"] += vol
            # Volume-weighted indication (take from highest-volume venue)
            ind = row.get("Indication_bps")
            if pd.notna(ind) and vol > a["ind_vol"]:
                a["ind"] = float(ind)
                a["ind_vol"] = vol
            a["flags"] |= bit

    # Build compact arrays
    result = []
    for sym, a in agg.items():
        idx = sym_to_idx.get(sym, -1)
        if idx < 0:
            continue

        vwap = round(a["vwap_num"] / a["vwap_den"], 4) if a["vwap_den"] > 0 else None
        ind = round(a["ind"], 2) if a["ind"] is not None else None
        sec_idx = sector_to_idx.get(a["sector"], -1)

        # Relative notional vs 20-day average
        rel = None
        if sym_avgs and sym in sym_avgs:
            avg_n = sym_avgs[sym].get("avgNotional", 0)
            if avg_n > 0:
                rel = round(a["notional"] / avg_n, 2)

        result.append([
            idx,
            round(a["notional"], 2),
            a["volume"],
            a["trades"],
            vwap,
            ind,
            rel,
            sec_idx,
            a["flags"],
        ])

    # Sort by total notional descending
    result.sort(key=lambda x: x[1], reverse=True)
    return result


def compute_sector_heatmap(venue_dfs, sector_to_idx):
    """Compute per-venue per-sector indication stats for heatmap rendering.

    Returns dict: {venueAnon: [[sectorIdx, medianInd, meanInd, notional, symCount, pctUp], ...]}
    Each venue key maps to a list of sector rows with aggregated indication metrics.
    """
    result = {}
    for venue, df in venue_dfs.items():
        if df is None or len(df) == 0:
            continue
        anon = VENUE_ANON[venue]
        sectors = []
        for sector, group in df.groupby("Sector"):
            idx = sector_to_idx.get(sector, -1)
            valid_ind = group["Indication_bps"].dropna()
            notional = float(group["Notional"].sum())
            sym_count = int(group["Symbol"].nunique())
            if len(valid_ind) > 0:
                median_ind = round(float(valid_ind.median()), 1)
                mean_ind = round(float(valid_ind.mean()), 1)
                pct_up = round(float((valid_ind > 0).sum() / len(valid_ind) * 100), 1)
            else:
                median_ind = None
                mean_ind = None
                pct_up = None
            sectors.append([idx, median_ind, mean_ind, notional, sym_count, pct_up])
        result[anon] = sectors
    return result


# =============================================================================
# JSON MANAGEMENT
# =============================================================================

def load_existing_json():
    """Load venue_overview.json if it exists."""
    if os.path.exists(OUTPUT_JSON_PATH):
        with open(OUTPUT_JSON_PATH, "r") as f:
            return json.load(f)
    return None


def build_lookup_tables(all_dfs, existing_json=None):
    """Build/update lookup tables for symbols, sectors, companies.
    Preserves existing indices, appends new entries.
    """
    # Start from existing lookups if available
    if existing_json and "lookup" in existing_json:
        symbols = list(existing_json["lookup"]["symbols"])
        sectors = list(existing_json["lookup"]["sectors"])
        companies = list(existing_json["lookup"]["companies"])
    else:
        symbols = []
        sectors = []
        companies = []

    sym_set = set(symbols)
    sector_set = set(sectors)
    company_set = set(companies)

    for df in all_dfs:
        if df is None or len(df) == 0:
            continue
        for sym in df["Symbol"].unique():
            if isinstance(sym, str) and sym and sym not in sym_set:
                symbols.append(sym)
                sym_set.add(sym)
        for sec in df["Sector"].unique():
            if isinstance(sec, str) and sec and sec not in sector_set:
                sectors.append(sec)
                sector_set.add(sec)
        if "Company_Name" in df.columns:
            for comp in df["Company_Name"].unique():
                if isinstance(comp, str) and comp and comp not in company_set:
                    companies.append(comp)
                    company_set.add(comp)

    sym_to_idx = {s: i for i, s in enumerate(symbols)}
    sector_to_idx = {s: i for i, s in enumerate(sectors)}

    return {
        "symbols": symbols,
        "sectors": sectors,
        "companies": companies,
    }, sym_to_idx, sector_to_idx


def save_json(data, path=OUTPUT_JSON_PATH):
    """Write JSON atomically (write to temp, then rename).
    Uses allow_nan=False to prevent Python NaN from producing invalid JSON.
    """
    tmp_path = path + ".tmp"
    with open(tmp_path, "w") as f:
        json.dump(data, f, separators=(",", ":"), allow_nan=False)
    os.replace(tmp_path, path)
    size_kb = os.path.getsize(path) / 1024
    print(f"  Saved: {path} ({size_kb:.1f} KB)")


# =============================================================================
# MAIN
# =============================================================================

def main():
    parser = argparse.ArgumentParser(description="Generate venue overview JSON")
    parser.add_argument("--date", type=str, default=None,
                        help="Target date YYYY-MM-DD (default: today)")
    parser.add_argument("--dry-run", action="store_true",
                        help="Show what would be processed without writing")
    args = parser.parse_args()

    # Determine target date
    if args.date:
        target_date = datetime.strptime(args.date, "%Y-%m-%d").date()
    else:
        target_date = date.today()

    print("=" * 60)
    print("VENUE OVERVIEW GENERATOR")
    print("=" * 60)
    print(f"  Target date: {target_date} ({target_date.strftime('%A')})")
    if args.dry_run:
        print("  ** DRY RUN MODE **")

    # Step 1: Find files
    print(f"\nStep 1: Locating venue files...")
    files = find_todays_files(target_date)
    venues_found = sum(1 for v in files.values() if v is not None)
    for venue, path in files.items():
        status = os.path.basename(path) if path else "NOT FOUND"
        print(f"  {venue:8s}: {status}")

    if venues_found == 0:
        print("\n  No venue files found for this date. Exiting.")
        return 1

    # Step 2: Parse each venue
    print(f"\nStep 2: Parsing {venues_found} venue files...")
    ds = target_date.strftime("%Y-%m-%d")
    venue_dfs = {}

    if files["boats"]:
        boats_df = parse_boats(files["boats"], ds)
        print(f"  BOATS: {len(boats_df):,} rows (institutional)")
        venue_dfs["boats"] = boats_df
    else:
        venue_dfs["boats"] = None

    if files["bruce"]:
        bruce_df = parse_bruce(files["bruce"], ds)
        print(f"  Bruce: {len(bruce_df):,} rows (institutional)")
        venue_dfs["bruce"] = bruce_df
    else:
        venue_dfs["bruce"] = None

    if files["moon"]:
        moon_df = parse_moon(files["moon"], ds)
        print(f"  Moon:  {len(moon_df):,} rows (all active)")
        venue_dfs["moon"] = moon_df
    else:
        venue_dfs["moon"] = None

    # Step 3: Collect all symbols and fetch Prior Close + trade-date Open/Close
    print(f"\nStep 3: Fetching market data...")
    all_symbols = set()
    for df in venue_dfs.values():
        if df is not None:
            all_symbols.update(df["Symbol"].unique())

    sym_list = list(all_symbols)
    prior_closes = fetch_prior_close(sym_list, target_date)
    next_opens, next_closes = fetch_trade_date_prices(sym_list, target_date)

    # Step 4: Enrich with Symbol Master
    print(f"\nStep 4: Enriching with Symbol Master...")
    sm = load_symbol_master()

    all_dfs = []
    for venue, df in venue_dfs.items():
        if df is not None:
            df = enrich_with_metadata(df, sm)
            df = calculate_overnight_indication(df, prior_closes, next_opens, next_closes)
            venue_dfs[venue] = df
            all_dfs.append(df)

    # Step 4b: Load historical averages from master parquet
    print(f"\nStep 4b: Loading historical averages ({HISTORICAL_LOOKBACK_DAYS}-day window)...")
    sym_avgs, venue_avgs = load_historical_averages(target_date)
    if sym_avgs:
        print(f"  Historical data: {len(sym_avgs):,} symbols with averages")
    else:
        print(f"  No historical data available (first run or missing parquet)")

    if args.dry_run:
        print("\n  DRY RUN complete. Would process:")
        for venue, df in venue_dfs.items():
            if df is not None:
                valid = df["Indication_bps"].notna().sum()
                print(f"    {venue}: {len(df)} rows, {valid} with indication")
        return 0

    # Step 5: Build lookup tables
    print(f"\nStep 5: Building lookup tables...")
    existing = load_existing_json()
    lookup, sym_to_idx, sector_to_idx = build_lookup_tables(all_dfs, existing)
    print(f"  Symbols: {len(lookup['symbols']):,}, Sectors: {len(lookup['sectors'])}")

    # Step 6: Compute metrics for each venue
    print(f"\nStep 6: Computing metrics...")
    date_entry = {
        "summary": {},
        "topTickers": {},
        "sectors": {},
        "direction": {},
    }

    for venue, df in venue_dfs.items():
        if df is not None and len(df) > 0:
            anon = VENUE_ANON[venue]  # boats -> venue1, etc.
            # Pass venue_avgs only to BOATS (the parquet source); others get None
            va = venue_avgs if venue == "boats" and venue_avgs else None
            date_entry["summary"][anon] = compute_venue_summary(df, venue, venue_avgs=va)
            date_entry["topTickers"][anon] = compute_top_tickers(
                df, sym_to_idx, sym_avgs=sym_avgs
            )
            date_entry["sectors"][anon] = compute_sector_distribution(df, sector_to_idx)
            date_entry["direction"][anon] = compute_direction_histogram(df)

            s = date_entry["summary"][anon]
            pct_str = f"{s['pctUp']:.1f}% up" if s["pctUp"] is not None else "no indication"
            rel_str = ""
            if s.get("notionalVsAvg"):
                rel_str = f", {s['notionalVsAvg']:.2f}x avg"
            print(f"  {venue:8s}: ${s['notional']/1e9:.2f}B notional, "
                  f"{s['symbols']} symbols, {pct_str}{rel_str}")

    # Cross-venue overlap
    date_entry["overlap"] = compute_cross_venue_overlap(venue_dfs, sym_to_idx)
    oc = date_entry["overlap"]["counts"]
    print(f"  Overlap: {oc['all3']} on all 3, {oc['twoVenues']} on 2, "
          f"{oc['oneVenue']} on 1 only ({oc['total']} total unique)")

    # Watchlist: combined view of all symbols across venues
    date_entry["watchlist"] = compute_watchlist(
        venue_dfs, sym_to_idx, sector_to_idx, sym_avgs=sym_avgs
    )
    print(f"  Watchlist: {len(date_entry['watchlist'])} symbols")

    # Sector heatmap: per-venue per-sector indication metrics
    date_entry["sectorHeatmap"] = compute_sector_heatmap(venue_dfs, sector_to_idx)

    # Step 6b: Fetch VIX close for each date
    print(f"\nStep 6b: Fetching VIX data...")
    try:
        import yfinance as yf
        all_dates_in_json = sorted(existing["dates"].keys()) if existing else [ds]
        if ds not in all_dates_in_json:
            all_dates_in_json.append(ds)
        all_dates_in_json.sort()
        vix_ticker = yf.Ticker("^VIX")
        vix_hist = vix_ticker.history(
            start=all_dates_in_json[0],
            end=(pd.Timestamp(all_dates_in_json[-1]) + pd.Timedelta(days=2)).strftime("%Y-%m-%d")
        )
        vix_by_date = {}
        if not vix_hist.empty:
            for _, vrow in vix_hist.iterrows():
                d_str = vrow.name.strftime("%Y-%m-%d")
                if d_str in all_dates_in_json:
                    vix_by_date[d_str] = round(float(vrow["Close"]), 2)
        print(f"  VIX: {len(vix_by_date)} dates populated")
    except Exception as e:
        print(f"  VIX fetch failed: {e}")
        vix_by_date = {}

    # Step 7: Assemble and save JSON
    print(f"\nStep 7: Saving JSON...")

    if existing:
        existing["lookup"] = lookup
        existing["dates"][ds] = date_entry
        existing["meta"]["latestDate"] = ds
        existing["meta"]["dateCount"] = len(existing["dates"])
        existing["meta"]["generated"] = datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
        # Merge VIX data
        existing_vix = existing["meta"].get("vixByDate", {})
        existing_vix.update(vix_by_date)
        existing["meta"]["vixByDate"] = existing_vix
        output = existing
    else:
        output = {
            "meta": {
                "generated": datetime.now().strftime("%Y-%m-%dT%H:%M:%S"),
                "latestDate": ds,
                "dateCount": 1,
                "version": "1.0",
                "vixByDate": vix_by_date,
            },
            "lookup": lookup,
            "dates": {
                ds: date_entry,
            },
        }

    save_json(output)

    print(f"\n{'=' * 60}")
    print(f"VENUE OVERVIEW COMPLETE")
    print(f"{'=' * 60}")
    print(f"  Date: {ds}")
    print(f"  Venues: {venues_found}/3")
    print(f"  Total dates in JSON: {output['meta']['dateCount']}")
    print(f"  JSON: {OUTPUT_JSON_PATH}")

    return 0


if __name__ == "__main__":
    sys.exit(main() or 0)
