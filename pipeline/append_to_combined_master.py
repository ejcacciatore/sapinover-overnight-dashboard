"""
append_to_combined_master.py - Combined 3-ATS Master Parquet Append Tool
========================================================================
Scans for unprocessed files from BlueOcean (BOATS), Bruce, and Moon ATS,
enriches with yfinance market data, calculates timing differentials,
merges Symbol Master metadata, appends to combined master parquet, and
regenerates all dashboard JSON files.

Usage:
    python append_to_combined_master.py              # Auto-detect and process missing dates/venues
    python append_to_combined_master.py --dry-run    # Show what would be processed without changing anything
    python append_to_combined_master.py --skip-today # Skip today's date (T-1 mode)
    python append_to_combined_master.py --boats-only # Backward compat: process only BlueOcean

Sapinover LLC | Overnight Trading Research Platform
"""

import pandas as pd
import numpy as np
import re
import os
import sys
import glob
import json
import time
import shutil
import subprocess
import warnings
from datetime import datetime, timedelta
from typing import Optional, Tuple, List, Set, Dict

warnings.filterwarnings('ignore')

try:
    import yfinance as yf
except ImportError:
    print("ERROR: yfinance not installed. Run: pip install yfinance")
    sys.exit(1)

# =============================================================================
# CONFIGURATION
# =============================================================================

BASE_DIR = os.environ.get("PIPELINE_BASE_DIR", os.path.dirname(os.path.abspath(__file__)))
BLUEOCEAN_DIR = os.path.join(BASE_DIR, "BlueOcean")
COMBINED_DIR = os.path.join(BASE_DIR, "Combined_ATS")
COMBINED_MASTER = os.path.join(COMBINED_DIR, "Combined_Master_Institutional.parquet")
COMBINED_DASHBOARD_DIR = os.path.join(COMBINED_DIR, "dashboard_data")
DASHBOARD_DIR = os.path.join(BLUEOCEAN_DIR, "dashboard_data")

# BlueOcean-only master files (backward compatibility)
MASTER_FILES = [
    os.path.join(BLUEOCEAN_DIR, "BlueOcean_Master_Historical.parquet"),
    os.path.join(BLUEOCEAN_DIR, "BlueOcean_Master_Institutional.parquet"),
]
SYMBOL_MASTER_CSV = os.path.join(BLUEOCEAN_DIR, "BlueOcean_Symbol_Master.csv")

# Website deployment path
WEBSITE_DATA_PATH = os.environ.get("WEBSITE_DATA_PATH", os.path.join(BASE_DIR, "output", "overnight-alpha.json"))

# Filters
NOTIONAL_THRESHOLD = 50000
OUTLIER_BPS_THRESHOLD = 1000
SYMBOL_REFRESH_DAYS = 7

# Dynamically build SCAN_DIRS from existing YYYY-MM directories
SCAN_DIRS = [BASE_DIR]
for entry in os.listdir(BASE_DIR):
    full_path = os.path.join(BASE_DIR, entry)
    if os.path.isdir(full_path) and re.match(r'^\d{4}-\d{2}$', entry):
        SCAN_DIRS.append(full_path)


# =============================================================================
# HELPER FUNCTIONS (from v5.1 pipeline)
# =============================================================================

def convert_ticker_yf(ticker: str) -> str:
    """Convert ticker to yfinance format."""
    if not isinstance(ticker, str):
        return str(ticker)
    ticker = ticker.strip().upper()
    if re.match(r'^[A-Z]+ [A-Z]$', ticker):
        return ticker.replace(' ', '-')
    if '.PR.' in ticker:
        parts = ticker.split('.PR.')
        return f"{parts[0]}-P{parts[1]}" if len(parts) == 2 else ticker
    if '.WS' in ticker:
        return ticker.replace('.WS', '-WT')
    if '.' in ticker and not ticker.endswith('.'):
        return ticker.replace('.', '-')
    return ticker


def extract_date_from_filename(filename: str) -> Optional[datetime]:
    """Extract date from any venue filename."""
    for pattern in [r'(\d{4})(\d{2})(\d{2})', r'(\d{4})-(\d{2})-(\d{2})']:
        match = re.search(pattern, filename)
        if match:
            try:
                y, m, d = map(int, match.groups())
                dt = datetime(y, m, d)
                if 2020 <= y <= 2030:
                    return dt
            except ValueError:
                continue
    return None


def detect_leverage(name: str) -> Tuple[str, str]:
    """Detect ETF leverage from name."""
    name_lower = (name or '').lower()
    is_inverse = any(x in name_lower for x in ['inverse', 'short', 'bear', '-1x'])
    if '3x' in name_lower or 'triple' in name_lower or 'ultrapro' in name_lower:
        mult = '3x'
    elif '2x' in name_lower or 'double' in name_lower or 'ultra' in name_lower:
        mult = '2x'
    else:
        mult = '1x'
    if is_inverse:
        ltype = 'Inverse Leveraged' if mult != '1x' else 'Inverse'
        mult = f'-{mult}'
    elif mult != '1x':
        ltype = 'Leveraged'
    else:
        ltype = 'Standard'
    return ltype, mult


def format_currency(val: float) -> str:
    if val >= 1e12: return f'${val/1e12:.2f}T'
    if val >= 1e9: return f'${val/1e9:.2f}B'
    if val >= 1e6: return f'${val/1e6:.2f}M'
    if val >= 1e3: return f'${val/1e3:.1f}K'
    return f'${val:.0f}'


def format_volume(val):
    if val >= 1e9: return f'{val/1e9:.1f}B shares'
    if val >= 1e6: return f'{val/1e6:.1f}M shares'
    if val >= 1e3: return f'{val/1e3:.0f}K shares'
    return f'{val:.0f} shares'


def safe_round(val, decimals=2):
    if pd.isna(val): return 0.0
    return round(float(val), decimals)


# =============================================================================
# STEP 1: SCAN FOR UNPROCESSED FILES FROM ALL 3 VENUES
# =============================================================================

def find_all_venue_files() -> Dict[str, Dict[str, str]]:
    """Find all venue files across scan directories.

    Returns dict keyed by date string, with inner dict of venue->filepath.
    Example: {"2026-03-04": {"BlueOcean": "/path/to/boats.xlsx", "Bruce": "/path/to/bruce.csv", "Moon": "/path/to/moon.csv"}}
    """
    files = {}

    # --- BlueOcean (BOATS) ---
    # Prefer xlsx over csv
    boats_xlsx = {}
    boats_csv = {}
    for directory in SCAN_DIRS:
        if not os.path.exists(directory):
            continue
        for f in glob.glob(os.path.join(directory, "Market_Data_Statistics_*.xlsx")):
            basename = os.path.basename(f)
            dt = extract_date_from_filename(basename)
            if dt:
                key = dt.strftime("%Y-%m-%d")
                boats_xlsx[key] = f
        for f in glob.glob(os.path.join(directory, "Market_Data_Statistics_*.csv")):
            basename = os.path.basename(f)
            dt = extract_date_from_filename(basename)
            if dt:
                key = dt.strftime("%Y-%m-%d")
                if key not in boats_csv:
                    boats_csv[key] = f

    # Merge: xlsx preferred, csv as fallback
    all_boats_dates = set(boats_xlsx.keys()) | set(boats_csv.keys())
    for date_str in all_boats_dates:
        if date_str not in files:
            files[date_str] = {}
        if date_str in boats_xlsx:
            files[date_str]["BlueOcean"] = boats_xlsx[date_str]
        elif date_str in boats_csv:
            files[date_str]["BlueOcean"] = boats_csv[date_str]

    # --- Bruce ---
    for directory in SCAN_DIRS:
        if not os.path.exists(directory):
            continue
        for f in glob.glob(os.path.join(directory, "*_Bruce_DailyActivity.csv")):
            basename = os.path.basename(f)
            dt = extract_date_from_filename(basename)
            if dt:
                key = dt.strftime("%Y-%m-%d")
                if key not in files:
                    files[key] = {}
                # Keep the first found (month-dir copy takes priority if already there)
                if "Bruce" not in files[key]:
                    files[key]["Bruce"] = f

    # --- Moon ---
    for directory in SCAN_DIRS:
        if not os.path.exists(directory):
            continue
        for f in glob.glob(os.path.join(directory, "MOON_ATS_MostActive_*.csv")):
            basename = os.path.basename(f)
            dt = extract_date_from_filename(basename)
            if dt:
                key = dt.strftime("%Y-%m-%d")
                if key not in files:
                    files[key] = {}
                if "Moon" not in files[key]:
                    files[key]["Moon"] = f

    return files


def find_all_boats_files() -> Dict[str, str]:
    """Find all BOATS files across scan directories, preferring xlsx over csv.
    Backward-compat wrapper for --boats-only mode.
    """
    files = {}
    for directory in SCAN_DIRS:
        if not os.path.exists(directory):
            continue
        for f in glob.glob(os.path.join(directory, "Market_Data_Statistics_*.xlsx")):
            basename = os.path.basename(f)
            dt = extract_date_from_filename(basename)
            if dt:
                files[dt.strftime("%Y-%m-%d")] = f
    # Fill gaps with CSV
    for directory in SCAN_DIRS:
        if not os.path.exists(directory):
            continue
        for f in glob.glob(os.path.join(directory, "Market_Data_Statistics_*.csv")):
            basename = os.path.basename(f)
            dt = extract_date_from_filename(basename)
            if dt:
                key = dt.strftime("%Y-%m-%d")
                if key not in files:
                    files[key] = f
    return files


def get_existing_dates(master_path: str) -> Set[str]:
    """Get set of dates already in master parquet (BlueOcean-only backward compat)."""
    if not os.path.exists(master_path):
        return set()
    df = pd.read_parquet(master_path, columns=['Trade_Date'])
    df['Trade_Date'] = pd.to_datetime(df['Trade_Date'])
    return set(df['Trade_Date'].dt.strftime("%Y-%m-%d").unique())


def get_existing_date_venue_pairs() -> Set[Tuple[str, str]]:
    """Get set of (date, venue) pairs already in combined master parquet."""
    if not os.path.exists(COMBINED_MASTER):
        return set()
    cols_to_read = ['Trade_Date', 'Venue']
    try:
        df = pd.read_parquet(COMBINED_MASTER, columns=cols_to_read)
    except Exception:
        return set()
    df['Trade_Date'] = pd.to_datetime(df['Trade_Date'])
    df['_date_str'] = df['Trade_Date'].dt.strftime("%Y-%m-%d")
    pairs = set()
    for _, row in df[['_date_str', 'Venue']].drop_duplicates().iterrows():
        pairs.add((row['_date_str'], row['Venue']))
    return pairs


# =============================================================================
# STEP 2: THREE VENUE PARSERS
# =============================================================================

def load_boats_file(filepath: str, trade_date: str) -> pd.DataFrame:
    """Load a BOATS file (xlsx or csv) and standardize columns."""
    if filepath.endswith(".csv"):
        df = pd.read_csv(filepath)
    else:
        df = pd.read_excel(filepath)

    # Standardize column names to match combined parquet schema
    col_map = {
        'Average Spread': 'Avg_Spread',
        'Average Bid Size': 'Avg_Bid_Size',
        'Average Offer Size': 'Avg_Offer_Size',
        'Hi': 'High',
        'Lo': 'Low',
        'Executions': 'Trades',
    }
    df = df.rename(columns=col_map)

    # Clean numeric columns
    for col in ['Avg_Spread', 'Notional', 'Open', 'High', 'Low', 'Close',
                'Volume', 'Trades', 'Avg_Bid_Size', 'Avg_Offer_Size']:
        if col in df.columns:
            df[col] = (
                df[col].astype(str)
                .str.replace("$", "", regex=False)
                .str.replace(",", "", regex=False)
                .str.strip()
            )
            df[col] = pd.to_numeric(df[col], errors='coerce')

    # Compute VWAP from Notional / Volume
    df['VWAP_Price'] = np.where(
        (df['Volume'].notna()) & (df['Volume'] > 0),
        df['Notional'] / df['Volume'],
        np.nan
    )

    df['Venue'] = 'BlueOcean'
    df['Trade_Date'] = pd.to_datetime(trade_date)
    df['Source_File'] = os.path.basename(filepath)

    # Ensure all standard columns exist
    for col in ['Avg_Spread', 'Avg_Bid_Size', 'Avg_Offer_Size', 'Open', 'High', 'Low', 'Close', 'Trades']:
        if col not in df.columns:
            df[col] = np.nan

    return df


def load_bruce_file(filepath: str, trade_date: str) -> pd.DataFrame:
    """Load a Bruce DailyActivity CSV and standardize columns.

    Bruce CSVs come in two formats:
      Legacy  (Dec 2025 - Jan 9 2026): ref_date, symbol, executions,
              executed_volume, executed_notional, vwap  (6 cols, lowercase)
      Extended (Jan 12 2026+): RefDate, Symbol, AvgSpread, AvgBidSize,
              AvgOfferSize, Trades, Volume, Notional, VWAP, Open, High,
              Low, Close[, PctTwoSided]  (13-14 cols, mixed case)

    Both are normalized to the canonical column set.
    """
    df = pd.read_csv(filepath)

    # Detect legacy format by checking for lowercase 'executed_volume'
    is_legacy = 'executed_volume' in df.columns or 'executed_notional' in df.columns

    if is_legacy:
        # Legacy format mapping
        col_map = {
            'symbol': 'Symbol',
            'executions': 'Trades',
            'executed_volume': 'Volume',
            'executed_notional': 'Notional',
            'vwap': 'VWAP',
        }
        df = df.rename(columns=col_map)
        # Drop ref_date (we use trade_date parameter)
        if 'ref_date' in df.columns:
            df = df.drop(columns=['ref_date'])
    else:
        # Extended format mapping
        col_map = {
            'AvgSpread': 'Avg_Spread',
            'AvgBidSize': 'Avg_Bid_Size',
            'AvgOfferSize': 'Avg_Offer_Size',
        }
        df = df.rename(columns=col_map)

    # Clean Avg_Spread (strip leading $ sign, convert to numeric)
    if 'Avg_Spread' in df.columns:
        df['Avg_Spread'] = (
            df['Avg_Spread'].astype(str)
            .str.replace("$", "", regex=False)
            .str.replace(",", "", regex=False)
            .str.strip()
        )
        df['Avg_Spread'] = pd.to_numeric(df['Avg_Spread'], errors='coerce')

    # Clean other numeric columns
    for col in ['Notional', 'Open', 'High', 'Low', 'Close', 'Volume', 'Trades',
                'Avg_Bid_Size', 'Avg_Offer_Size', 'VWAP']:
        if col in df.columns:
            df[col] = (
                df[col].astype(str)
                .str.replace("$", "", regex=False)
                .str.replace(",", "", regex=False)
                .str.strip()
            )
            df[col] = pd.to_numeric(df[col], errors='coerce')

    # Bruce has native VWAP column (both legacy and extended)
    if 'VWAP' in df.columns:
        df['VWAP_Price'] = df['VWAP']
        df = df.drop(columns=['VWAP'])
    else:
        df['VWAP_Price'] = np.where(
            (df.get('Volume', pd.Series(dtype=float)).notna()) &
            (df.get('Volume', pd.Series(dtype=float)) > 0),
            df.get('Notional', 0) / df.get('Volume', 1),
            np.nan
        )

    # Drop extra Bruce columns
    drop_cols = [c for c in ['RefDate', 'PctTwoSided'] if c in df.columns]
    if drop_cols:
        df = df.drop(columns=drop_cols)

    df['Venue'] = 'Bruce'
    df['Trade_Date'] = pd.to_datetime(trade_date)
    df['Source_File'] = os.path.basename(filepath)

    # Ensure all standard columns exist (legacy format lacks most of these)
    for col in ['Avg_Spread', 'Avg_Bid_Size', 'Avg_Offer_Size', 'Open', 'High',
                'Low', 'Close', 'Trades', 'Volume', 'Notional']:
        if col not in df.columns:
            df[col] = np.nan

    return df


def load_moon_file(filepath: str, trade_date: str) -> pd.DataFrame:
    """Load a Moon ATS MostActive CSV and standardize columns."""
    df = pd.read_csv(filepath)

    # Standardize column names (handle both forms)
    col_map = {}
    if '$ Volume' in df.columns:
        col_map['$ Volume'] = 'Notional'
    elif '$ Vol' in df.columns:
        col_map['$ Vol'] = 'Notional'
    if 'Share Volume' in df.columns:
        col_map['Share Volume'] = 'Volume'
    elif 'Share Vol' in df.columns:
        col_map['Share Vol'] = 'Volume'
    col_map['Price'] = 'Close'
    df = df.rename(columns=col_map)

    # Drop % Change column
    drop_cols = [c for c in ['% Change'] if c in df.columns]
    if drop_cols:
        df = df.drop(columns=drop_cols)

    # Clean numeric columns
    for col in ['Notional', 'Volume', 'Close', 'Trades']:
        if col in df.columns:
            df[col] = (
                df[col].astype(str)
                .str.replace("$", "", regex=False)
                .str.replace(",", "", regex=False)
                .str.strip()
            )
            df[col] = pd.to_numeric(df[col], errors='coerce')

    # Moon does not have OHLC detail or spread data
    df['Open'] = np.nan
    df['High'] = np.nan
    df['Low'] = np.nan
    df['Avg_Spread'] = np.nan
    df['Avg_Bid_Size'] = np.nan
    df['Avg_Offer_Size'] = np.nan

    # Best approximation of VWAP
    df['VWAP_Price'] = np.where(
        (df['Volume'].notna()) & (df['Volume'] > 0),
        df['Notional'] / df['Volume'],
        np.nan
    )

    df['Venue'] = 'Moon'
    df['Trade_Date'] = pd.to_datetime(trade_date)
    df['Source_File'] = os.path.basename(filepath)

    # Ensure Trades column exists
    if 'Trades' not in df.columns:
        df['Trades'] = np.nan

    return df


def filter_institutional(df: pd.DataFrame) -> pd.DataFrame:
    """Apply $50K notional + Volume > 0 filter."""
    initial = len(df)
    df = df[(df['Notional'] >= NOTIONAL_THRESHOLD) & (df['Volume'] > 0)].copy()
    print(f"    Filtered: {initial:,} -> {len(df):,} rows (institutional)")
    return df


# =============================================================================
# STEP 3: FETCH YFINANCE MARKET PRICES
# =============================================================================

def fetch_market_data(symbols: List[str], min_date: datetime, max_date: datetime) -> pd.DataFrame:
    """Fetch market data from yfinance for all symbols across date range."""
    yf_start = (min_date - timedelta(days=7)).strftime('%Y-%m-%d')
    yf_end = (max_date + timedelta(days=3)).strftime('%Y-%m-%d')

    print(f"\n  Fetching yfinance data for {len(symbols):,} symbols")
    print(f"  Date range: {yf_start} to {yf_end}")
    est_min = len(symbols) * 0.12 / 60
    print(f"  Estimated time: {est_min:.1f} - {est_min*1.5:.1f} minutes")

    market_data = []
    failed = []

    for i, symbol in enumerate(symbols):
        yf_symbol = convert_ticker_yf(symbol)
        try:
            ticker = yf.Ticker(yf_symbol)
            hist = ticker.history(start=yf_start, end=yf_end)
            if hist.empty:
                failed.append((symbol, "No data"))
                continue
            for date, row in hist.iterrows():
                market_data.append({
                    'Symbol': symbol,
                    'Market_Date': date.date(),
                    'Market_Open': float(row['Open']),
                    'Market_Close': float(row['Close'])
                })
        except Exception as e:
            failed.append((symbol, str(e)[:30]))
        time.sleep(0.05)

        if (i + 1) % 200 == 0:
            print(f"    {i+1}/{len(symbols)} fetched...")

    print(f"  Fetch complete: {len(symbols) - len(failed):,} success, {len(failed):,} failed")
    if failed and len(failed) <= 15:
        for sym, reason in failed:
            print(f"    FAILED: {sym} - {reason}")

    return pd.DataFrame(market_data)


def merge_market_prices(trade_df: pd.DataFrame, market_df: pd.DataFrame) -> pd.DataFrame:
    """Merge Prior_Close, Next_Open, Next_Close into trade data."""
    trade_df['Trade_Date_Only'] = trade_df['Trade_Date'].dt.date

    # Current day open/close
    current_day = market_df.rename(columns={
        'Market_Date': 'Trade_Date_Only',
        'Market_Open': 'Next_Open',
        'Market_Close': 'Next_Close'
    })[['Symbol', 'Trade_Date_Only', 'Next_Open', 'Next_Close']]
    trade_df = trade_df.merge(current_day, on=['Symbol', 'Trade_Date_Only'], how='left')

    # Prior close lookup
    prior_data = []
    for symbol in trade_df['Symbol'].unique():
        sym_trades = trade_df[trade_df['Symbol'] == symbol]['Trade_Date_Only'].unique()
        sym_market = market_df[market_df['Symbol'] == symbol].sort_values('Market_Date')
        if sym_market.empty:
            continue
        dates = sym_market['Market_Date'].tolist()
        closes = sym_market['Market_Close'].tolist()
        for trade_date in sym_trades:
            prior_dates = [d for d in dates if d < trade_date]
            if prior_dates:
                idx = dates.index(prior_dates[-1])
                prior_data.append({
                    'Symbol': symbol,
                    'Trade_Date_Only': trade_date,
                    'Prior_Close': closes[idx]
                })

    if prior_data:
        trade_df = trade_df.merge(pd.DataFrame(prior_data),
                                   on=['Symbol', 'Trade_Date_Only'], how='left')
    else:
        trade_df['Prior_Close'] = np.nan

    trade_df = trade_df.drop(columns=['Trade_Date_Only'])

    matched = trade_df['Prior_Close'].notna().sum()
    print(f"  Market data merged: {matched:,}/{len(trade_df):,} ({matched/len(trade_df)*100:.1f}%)")
    return trade_df


# =============================================================================
# STEP 4: CALCULATE TIMING DIFFERENTIAL METRICS
# =============================================================================

def calculate_metrics(df: pd.DataFrame) -> pd.DataFrame:
    """Calculate all timing differential metrics matching master schema."""
    # Filter to complete rows
    complete = df[
        df['Prior_Close'].notna() &
        df['Next_Open'].notna() &
        (df['Prior_Close'] > 0)
    ].copy()

    incomplete = df[
        ~(df['Prior_Close'].notna() & df['Next_Open'].notna() & (df['Prior_Close'] > 0))
    ].copy()

    print(f"  Complete rows: {len(complete):,} / {len(df):,}")

    # Reference Gap: Prior Close -> VWAP
    complete['Reference_Gap_bps'] = (
        (complete['VWAP_Price'] - complete['Prior_Close']) /
        complete['Prior_Close'] * 10000
    )

    # Timing Differential: VWAP -> Next Open
    complete['Timing_Differential_bps'] = (
        (complete['Next_Open'] - complete['VWAP_Price']) /
        complete['Prior_Close'] * 10000
    )

    # Total Overnight Gap
    complete['Total_Overnight_Gap_bps'] = (
        (complete['Next_Open'] - complete['Prior_Close']) /
        complete['Prior_Close'] * 10000
    )

    # Captured Alpha (direction-adjusted: positive when execution aligns with gap)
    complete['Captured_Alpha_bps'] = np.where(
        complete['Total_Overnight_Gap_bps'] >= 0,
        complete['Timing_Differential_bps'],
        -complete['Timing_Differential_bps']
    )

    # Gap Direction
    complete['Gap_Direction'] = np.where(
        complete['Total_Overnight_Gap_bps'] >= 0, 'UP', 'DOWN'
    )

    # Directional Consistency
    complete['Directional_Consistency'] = (
        ((complete['Gap_Direction'] == 'UP') & (complete['Timing_Differential_bps'] > 0)) |
        ((complete['Gap_Direction'] == 'DOWN') & (complete['Timing_Differential_bps'] < 0))
    )

    # Data Status
    complete['Data_Status'] = 'Complete'

    # Outlier flag
    complete['Is_Outlier'] = complete['Timing_Differential_bps'].abs() > OUTLIER_BPS_THRESHOLD

    # Handle incomplete rows
    if len(incomplete) > 0:
        for col in ['Reference_Gap_bps', 'Timing_Differential_bps',
                     'Total_Overnight_Gap_bps', 'Captured_Alpha_bps']:
            incomplete[col] = np.nan
        incomplete['Gap_Direction'] = None
        incomplete['Directional_Consistency'] = np.nan
        incomplete['Data_Status'] = 'Incomplete'
        incomplete['Is_Outlier'] = False
        result = pd.concat([complete, incomplete], ignore_index=True)
    else:
        result = complete

    # Summary
    clean = complete[~complete['Is_Outlier']]
    if len(clean) > 0:
        print(f"  Timing Differential (excl outliers):")
        print(f"    Mean: {clean['Timing_Differential_bps'].mean():.2f} bps")
        print(f"    Median: {clean['Timing_Differential_bps'].median():.2f} bps")
        print(f"  Directional Consistency: {clean['Directional_Consistency'].mean()*100:.1f}%")
        print(f"  Outliers flagged: {complete['Is_Outlier'].sum():,}")

    return result


# =============================================================================
# STEP 5: UPDATE SYMBOL MASTER
# =============================================================================

def update_symbol_master(symbols: List[str]) -> pd.DataFrame:
    """Update Symbol Master CSV with metadata for new/stale symbols."""
    if os.path.exists(SYMBOL_MASTER_CSV):
        master_sym = pd.read_csv(SYMBOL_MASTER_CSV)
        print(f"  Symbol Master loaded: {len(master_sym):,} symbols")
    else:
        master_sym = pd.DataFrame()
        print(f"  No Symbol Master found, creating new")

    existing_symbols = set(master_sym['Symbol'].unique()) if len(master_sym) > 0 else set()
    new_symbols = set(symbols) - existing_symbols

    # Check for stale
    symbols_to_refresh = []
    today = datetime.now().date()
    if len(master_sym) > 0 and 'Last_Updated' in master_sym.columns:
        threshold = today - timedelta(days=SYMBOL_REFRESH_DAYS)
        stale = master_sym[
            pd.to_datetime(master_sym['Last_Updated'], errors='coerce').dt.date < threshold
        ]
        symbols_to_refresh = [s for s in stale['Symbol'].tolist() if s in symbols]

    symbols_to_fetch = list(set(new_symbols) | set(symbols_to_refresh))
    print(f"  New symbols: {len(new_symbols):,}")
    print(f"  Stale refreshes: {len(symbols_to_refresh):,}")
    print(f"  Total to fetch: {len(symbols_to_fetch):,}")

    if not symbols_to_fetch:
        print(f"  Symbol Master is current, no updates needed")
        return master_sym

    print(f"  Fetching metadata...")
    new_metadata = []
    for i, symbol in enumerate(symbols_to_fetch):
        yf_symbol = convert_ticker_yf(symbol)
        try:
            info = yf.Ticker(yf_symbol).info
            quote_type = info.get('quoteType', 'EQUITY')
            if quote_type == 'ETF':
                asset_type = 'ETF'
                sector = 'ETF'
                industry = info.get('category', 'Unknown')
                etf_category = info.get('category', 'Unknown')
                ltype, lmult = detect_leverage(info.get('longName', ''))
            else:
                asset_type = 'Stock'
                sector = info.get('sector', 'Unknown')
                industry = info.get('industry', 'Unknown')
                etf_category = None
                ltype, lmult = 'N/A', '1x'

            new_metadata.append({
                'Symbol': symbol,
                'Company_Name': info.get('longName', info.get('shortName', symbol)),
                'Asset_Type': asset_type,
                'Sector': sector,
                'Industry': industry,
                'Market_Cap': info.get('marketCap'),
                'Avg_Volume': info.get('averageVolume'),
                'Beta': info.get('beta'),
                'ETF_Category': etf_category,
                'Leverage_Type': ltype,
                'Leverage_Multiple': lmult,
                'Last_Updated': today.isoformat(),
            })
        except Exception:
            new_metadata.append({
                'Symbol': symbol,
                'Company_Name': symbol,
                'Asset_Type': 'Unknown',
                'Sector': 'Unknown',
                'Industry': 'Unknown',
                'Market_Cap': None,
                'Avg_Volume': None,
                'Beta': None,
                'ETF_Category': None,
                'Leverage_Type': 'Unknown',
                'Leverage_Multiple': '1x',
                'Last_Updated': today.isoformat(),
            })
        time.sleep(0.1)
        if (i + 1) % 100 == 0:
            print(f"    {i+1}/{len(symbols_to_fetch)} metadata fetched...")

    new_meta_df = pd.DataFrame(new_metadata)

    if len(master_sym) > 0:
        master_sym = master_sym[~master_sym['Symbol'].isin(symbols_to_fetch)]
        master_sym = pd.concat([master_sym, new_meta_df], ignore_index=True)
    else:
        master_sym = new_meta_df

    master_sym.to_csv(SYMBOL_MASTER_CSV, index=False)
    print(f"  Symbol Master updated: {len(master_sym):,} total symbols")

    return master_sym


# =============================================================================
# STEP 6: MERGE SYMBOL MASTER METADATA
# =============================================================================

def merge_symbol_metadata(trade_df: pd.DataFrame, symbol_df: pd.DataFrame) -> pd.DataFrame:
    """Merge Symbol Master metadata into trade data."""
    merge_cols = ['Symbol', 'Company_Name', 'Asset_Type', 'Sector', 'Industry',
                  'Market_Cap', 'ETF_Category', 'Leverage_Type', 'Leverage_Multiple']
    available = [c for c in merge_cols if c in symbol_df.columns]
    trade_df = trade_df.merge(symbol_df[available], on='Symbol', how='left')
    coverage = trade_df['Asset_Type'].notna().sum()
    print(f"  Symbol metadata merged: {coverage:,}/{len(trade_df):,} ({coverage/len(trade_df)*100:.1f}%)")
    return trade_df


# =============================================================================
# STEP 7: APPEND TO MASTER PARQUET
# =============================================================================

def append_to_combined_parquet(new_df: pd.DataFrame) -> pd.DataFrame:
    """Append new data to combined master parquet with venue-aware dedup."""
    os.makedirs(COMBINED_DIR, exist_ok=True)

    if os.path.exists(COMBINED_MASTER):
        master = pd.read_parquet(COMBINED_MASTER)
        print(f"  Existing combined master: {len(master):,} rows, {master['Trade_Date'].nunique()} dates")
    else:
        master = pd.DataFrame()
        print(f"  Creating new combined master parquet")

    # Align columns
    if len(master) > 0:
        all_cols = set(master.columns) | set(new_df.columns)
        for col in all_cols:
            if col not in master.columns:
                master[col] = None
            if col not in new_df.columns:
                new_df[col] = None
        new_df['Trade_Date'] = pd.to_datetime(new_df['Trade_Date'])

    # Concatenate
    combined = pd.concat([master, new_df], ignore_index=True)
    combined = combined.sort_values(['Trade_Date', 'Venue', 'Symbol']).reset_index(drop=True)

    # Dedup on (Trade_Date, Symbol, Venue)
    if 'Trade_Date' in combined.columns and 'Venue' in combined.columns:
        combined['_td'] = pd.to_datetime(combined['Trade_Date']).dt.date
        dupes = combined.duplicated(subset=['_td', 'Symbol', 'Venue'], keep='first').sum()
        if dupes > 0:
            print(f"  WARNING: {dupes:,} duplicate (date, symbol, venue) triples found, keeping first")
            combined = combined.drop_duplicates(subset=['_td', 'Symbol', 'Venue'], keep='first')
        combined = combined.drop(columns=['_td'])

    return combined


def append_to_blueocean_parquet(new_df: pd.DataFrame, master_path: str) -> pd.DataFrame:
    """Append new BlueOcean-only data to a BlueOcean master parquet (backward compat)."""
    if os.path.exists(master_path):
        master = pd.read_parquet(master_path)
        print(f"  Existing master: {len(master):,} rows, {master['Trade_Date'].nunique()} dates")
    else:
        master = pd.DataFrame()
        print(f"  Creating new master parquet")

    # Align columns
    if len(master) > 0:
        all_cols = set(master.columns) | set(new_df.columns)
        for col in all_cols:
            if col not in master.columns:
                master[col] = None
            if col not in new_df.columns:
                new_df[col] = None
        new_df['Trade_Date'] = pd.to_datetime(new_df['Trade_Date'])

    # Concatenate
    combined = pd.concat([master, new_df], ignore_index=True)
    combined = combined.sort_values(['Trade_Date', 'Symbol']).reset_index(drop=True)

    # Dedup check
    if 'Trade_Date' in combined.columns:
        combined['_td'] = pd.to_datetime(combined['Trade_Date']).dt.date
        dupes = combined.duplicated(subset=['_td', 'Symbol'], keep='first').sum()
        if dupes > 0:
            print(f"  WARNING: {dupes:,} duplicate (date, symbol) pairs found, keeping first")
            combined = combined.drop_duplicates(subset=['_td', 'Symbol'], keep='first')
        combined = combined.drop(columns=['_td'])

    return combined


# =============================================================================
# STEP 8: REGENERATE DASHBOARD JSON
# =============================================================================

def notional_bucket(val):
    if val < 100000: return '$50K-100K'
    if val < 500000: return '$100K-500K'
    if val < 1000000: return '$500K-1M'
    if val < 5000000: return '$1M-5M'
    return '>$5M'

NOTIONAL_BUCKET_ORDER = ['$50K-100K', '$100K-500K', '$500K-1M', '$1M-5M', '>$5M']

def mcap_bucket(val):
    if pd.isna(val) or val <= 0: return None
    if val < 300e6: return 'Micro (<$300M)'
    if val < 2e9: return 'Small ($300M-2B)'
    if val < 10e9: return 'Mid ($2B-10B)'
    if val < 200e9: return 'Large ($10B-200B)'
    return 'Mega (>$200B)'

MCAP_BUCKET_ORDER = ['Micro (<$300M)', 'Small ($300M-2B)', 'Mid ($2B-10B)',
                     'Large ($10B-200B)', 'Mega (>$200B)']

def spread_bucket(cents):
    if cents < 1: return '<1\u00a2'
    if cents < 2: return '1-2\u00a2'
    if cents < 5: return '2-5\u00a2'
    if cents < 10: return '5-10\u00a2'
    if cents < 25: return '10-25\u00a2'
    return '>25\u00a2'

SPREAD_BUCKET_ORDER = ['<1\u00a2', '1-2\u00a2', '2-5\u00a2', '5-10\u00a2',
                       '10-25\u00a2', '>25\u00a2']


def regenerate_dashboard_json(master_df: pd.DataFrame, dashboard_dir: str):
    """Regenerate all 10 dashboard JSON files + data.json from master parquet."""
    print("\n" + "=" * 60)
    print("REGENERATING DASHBOARD JSON")
    print("=" * 60)

    os.makedirs(dashboard_dir, exist_ok=True)

    # Filter to complete rows only
    if 'Data_Status' in master_df.columns:
        df = master_df[master_df['Data_Status'] == 'Complete'].copy()
        print(f"  Complete rows: {len(df):,} / {len(master_df):,}")
    else:
        df = master_df.copy()

    df['Trade_Date'] = pd.to_datetime(df['Trade_Date'])
    df['Trade_Date_Only'] = df['Trade_Date'].dt.date
    dates = sorted(df['Trade_Date_Only'].unique())

    total_notional = df['Notional'].sum()
    total_volume = int(df['Volume'].sum())
    total_obs = len(df)
    trades_col = 'Trades' if 'Trades' in df.columns else None
    total_executions = int(df[trades_col].sum()) if trades_col else 0

    n_stocks = len(df[df['Asset_Type'] == 'Stock']) if 'Asset_Type' in df.columns else 0
    n_etfs = len(df[df['Asset_Type'] == 'ETF']) if 'Asset_Type' in df.columns else 0

    dc_col = df['Directional_Consistency']
    if dc_col.dtype == bool:
        dc_rate = dc_col.sum() / total_obs * 100
        dc_count = int(dc_col.sum())
    else:
        dc_rate = dc_col.mean() * 100
        dc_count = int((dc_col > 0).sum())

    spread_col = 'Avg_Spread' if 'Avg_Spread' in df.columns else None
    if spread_col:
        avg_spread_raw = df[spread_col].dropna()
        mean_spread_cents = safe_round(avg_spread_raw.mean() * 100, 2)
        median_spread_cents = safe_round(avg_spread_raw.median() * 100, 2)
    else:
        mean_spread_cents = 0.0
        median_spread_cents = 0.0

    # 1. summary_stats.json
    summary_stats = {
        'generated_at': datetime.now().isoformat(),
        'date_range': {
            'start': str(dates[0]),
            'end': str(dates[-1]),
            'trading_days': len(dates)
        },
        'totals': {
            'notional': safe_round(total_notional, 2),
            'notional_formatted': format_currency(total_notional),
            'volume': total_volume,
            'volume_formatted': format_volume(total_volume),
            'observations': total_obs,
            'unique_symbols': int(df['Symbol'].nunique())
        },
        'daily_averages': {
            'notional': safe_round(total_notional / len(dates), 2),
            'notional_formatted': format_currency(total_notional / len(dates))
        },
        'asset_breakdown': {'stocks': n_stocks, 'etfs': n_etfs},
        'alpha_metrics': {
            'captured_alpha_mean_bps': safe_round(df['Captured_Alpha_bps'].mean()),
            'captured_alpha_median_bps': safe_round(df['Captured_Alpha_bps'].median()),
            'directional_success_rate_pct': safe_round(dc_rate, 1)
        },
        'liquidity': {'avg_spread_cents': mean_spread_cents}
    }
    print(f"  1. summary_stats.json")

    # 2. daily_volume.json
    daily_groups = df.groupby('Trade_Date_Only')
    daily_volume = {
        'dates': [str(d) for d in dates],
        'notional': [], 'volume': [], 'executions': [],
        'symbols': [], 'captured_alpha_median_bps': [], 'directional_success_pct': []
    }
    for d in dates:
        day = daily_groups.get_group(d)
        daily_volume['notional'].append(safe_round(day['Notional'].sum(), 2))
        daily_volume['volume'].append(int(day['Volume'].sum()))
        daily_volume['executions'].append(int(day[trades_col].sum()) if trades_col else 0)
        daily_volume['symbols'].append(int(day['Symbol'].nunique()))
        daily_volume['captured_alpha_median_bps'].append(
            safe_round(day['Captured_Alpha_bps'].median()))
        if day['Directional_Consistency'].dtype == bool:
            dc_pct = day['Directional_Consistency'].sum() / len(day) * 100
        else:
            dc_pct = day['Directional_Consistency'].mean() * 100
        daily_volume['directional_success_pct'].append(safe_round(dc_pct, 1))
    print(f"  2. daily_volume.json")

    # 3. sector_breakdown.json
    sector_col = 'Sector' if 'Sector' in df.columns else None
    if sector_col:
        df['_sector'] = df[sector_col].fillna('Unknown')
        sector_grp = df.groupby('_sector')
        sector_data = []
        for sec, grp in sector_grp:
            if grp['Directional_Consistency'].dtype == bool:
                sr = grp['Directional_Consistency'].sum() / len(grp) * 100
            else:
                sr = grp['Directional_Consistency'].mean() * 100
            sector_data.append({
                'sector': sec, 'notional': grp['Notional'].sum(),
                'volume': int(grp['Volume'].sum()),
                'symbol_count': int(grp['Symbol'].nunique()),
                'captured_alpha_median_bps': safe_round(grp['Captured_Alpha_bps'].median()),
                'success_rate': safe_round(sr, 1)
            })
        sector_data.sort(key=lambda x: x['notional'], reverse=True)
        sector_breakdown = {
            'sectors': [s['sector'] for s in sector_data],
            'notional': [safe_round(s['notional'], 2) for s in sector_data],
            'notional_pct': [safe_round(s['notional']/total_notional*100, 2) for s in sector_data],
            'volume': [s['volume'] for s in sector_data],
            'symbol_count': [s['symbol_count'] for s in sector_data],
            'captured_alpha_median_bps': [s['captured_alpha_median_bps'] for s in sector_data],
            'directional_success_pct': [s['success_rate'] for s in sector_data]
        }
        df.drop(columns=['_sector'], inplace=True)
    else:
        sector_breakdown = {'sectors': ['Unknown'], 'notional': [total_notional],
                            'notional_pct': [100.0], 'volume': [total_volume],
                            'symbol_count': [df['Symbol'].nunique()],
                            'captured_alpha_median_bps': [0], 'directional_success_pct': [0]}
    print(f"  3. sector_breakdown.json")

    # 4. top_symbols.json
    sym_grp = df.groupby('Symbol')
    sym_stats = []
    for sym, grp in sym_grp:
        if grp['Directional_Consistency'].dtype == bool:
            sr = grp['Directional_Consistency'].sum() / len(grp) * 100
        else:
            sr = grp['Directional_Consistency'].mean() * 100
        sym_stats.append({
            'symbol': sym,
            'company_name': grp.iloc[0].get('Company_Name', sym) or sym,
            'asset_type': grp.iloc[0].get('Asset_Type', 'Unknown') or 'Unknown',
            'sector': grp.iloc[0].get('Sector', 'Unknown') or 'Unknown',
            'notional': grp['Notional'].sum(),
            'volume': int(grp['Volume'].sum()),
            'executions': int(grp[trades_col].sum()) if trades_col else 0,
            'days_traded': int(grp['Trade_Date_Only'].nunique()),
            'captured_alpha_median': safe_round(grp['Captured_Alpha_bps'].median()),
            'success_rate': safe_round(sr, 1),
            'market_cap': float(grp.iloc[0].get('Market_Cap', 0) or 0),
            'beta': float(grp.iloc[0].get('Beta', 0) or 0)
        })
    sym_stats.sort(key=lambda x: x['notional'], reverse=True)
    top_n = sym_stats[:102]
    all_notionals = sorted([s['notional'] for s in sym_stats], reverse=True)
    cum_not = np.cumsum(all_notionals)
    top10_pct = safe_round(cum_not[min(9, len(cum_not)-1)] / total_notional * 100, 2)
    top25_pct = safe_round(cum_not[min(24, len(cum_not)-1)] / total_notional * 100, 2)
    top50_pct = safe_round(cum_not[min(49, len(cum_not)-1)] / total_notional * 100, 2)
    top_symbols = {
        'symbols': [s['symbol'] for s in top_n],
        'company_names': [s['company_name'] for s in top_n],
        'asset_types': [s['asset_type'] for s in top_n],
        'sectors': [s['sector'] for s in top_n],
        'notional': [safe_round(s['notional'], 2) for s in top_n],
        'volume': [s['volume'] for s in top_n],
        'executions': [s['executions'] for s in top_n],
        'days_traded': [s['days_traded'] for s in top_n],
        'captured_alpha_median_bps': [s['captured_alpha_median'] for s in top_n],
        'directional_success_pct': [s['success_rate'] for s in top_n],
        'market_cap': [s['market_cap'] for s in top_n],
        'beta': [s['beta'] for s in top_n],
        'concentration': {'top_10_pct': top10_pct, 'top_25_pct': top25_pct, 'top_50_pct': top50_pct}
    }
    print(f"  4. top_symbols.json")

    # 5. spread_analysis.json
    if spread_col:
        df['_spread_cents'] = df[spread_col] * 100
        df['_spread_bucket'] = df['_spread_cents'].apply(spread_bucket)
        spread_data = {b: {'notional': 0.0, 'count': 0, 'volume': 0} for b in SPREAD_BUCKET_ORDER}
        for _, row in df.iterrows():
            b = row['_spread_bucket']
            if b in spread_data:
                spread_data[b]['notional'] += row['Notional']
                spread_data[b]['count'] += 1
                spread_data[b]['volume'] += int(row['Volume'])
        spread_analysis = {
            'distribution': {
                'buckets': SPREAD_BUCKET_ORDER,
                'notional': [safe_round(spread_data[b]['notional'], 2) for b in SPREAD_BUCKET_ORDER],
                'count': [spread_data[b]['count'] for b in SPREAD_BUCKET_ORDER],
                'volume': [spread_data[b]['volume'] for b in SPREAD_BUCKET_ORDER]
            },
            'overall': {'mean_spread_cents': mean_spread_cents, 'median_spread_cents': median_spread_cents}
        }
        df.drop(columns=['_spread_cents', '_spread_bucket'], inplace=True)
    else:
        spread_analysis = {
            'distribution': {'buckets': SPREAD_BUCKET_ORDER, 'notional': [0]*6, 'count': [0]*6, 'volume': [0]*6},
            'overall': {'mean_spread_cents': 0, 'median_spread_cents': 0}
        }
    print(f"  5. spread_analysis.json")

    # 6. alpha_metrics.json
    ref_gap = df['Reference_Gap_bps']
    timing_diff = df['Timing_Differential_bps']
    total_gap = df['Total_Overnight_Gap_bps']
    if sector_col:
        df['_sector'] = df[sector_col].fillna('Unknown')
        alpha_by_sector = []
        for sec in sector_breakdown['sectors']:
            sec_data = df[df['_sector'] == sec]
            if len(sec_data) == 0:
                alpha_by_sector.append({'sector': sec, 'mean': 0, 'median': 0, 'sr': 0})
                continue
            if sec_data['Directional_Consistency'].dtype == bool:
                sr = sec_data['Directional_Consistency'].sum() / len(sec_data) * 100
            else:
                sr = sec_data['Directional_Consistency'].mean() * 100
            alpha_by_sector.append({
                'sector': sec,
                'mean': safe_round(sec_data['Timing_Differential_bps'].mean()),
                'median': safe_round(sec_data['Timing_Differential_bps'].median()),
                'sr': safe_round(sr, 1)
            })
        df.drop(columns=['_sector'], inplace=True)
    else:
        alpha_by_sector = [{'sector': 'Unknown', 'mean': 0, 'median': 0, 'sr': 0}]
    alpha_metrics = {
        'uncaptured': {'mean': safe_round(ref_gap.mean()), 'median': safe_round(ref_gap.median()), 'std': safe_round(ref_gap.std())},
        'captured': {'mean': safe_round(timing_diff.mean()), 'median': safe_round(timing_diff.median()), 'std': safe_round(timing_diff.std())},
        'total_overnight': {'mean': safe_round(total_gap.mean()), 'median': safe_round(total_gap.median()), 'std': safe_round(total_gap.std())},
        'by_sector': {
            'sectors': [a['sector'] for a in alpha_by_sector],
            'captured_mean_bps': [a['mean'] for a in alpha_by_sector],
            'captured_median_bps': [a['median'] for a in alpha_by_sector],
            'success_rate_pct': [a['sr'] for a in alpha_by_sector]
        }
    }
    print(f"  6. alpha_metrics.json")

    # 7. directional_success.json
    dir_data = []
    for direction in ['DOWN', 'UP']:
        d_grp = df[df['Gap_Direction'] == direction]
        if len(d_grp) == 0:
            dir_data.append({'dir': direction, 'sr': 0, 'count': 0, 'notional': 0})
            continue
        if d_grp['Directional_Consistency'].dtype == bool:
            sr = d_grp['Directional_Consistency'].sum() / len(d_grp) * 100
        else:
            sr = d_grp['Directional_Consistency'].mean() * 100
        dir_data.append({
            'dir': direction, 'sr': safe_round(sr, 1),
            'count': len(d_grp), 'notional': safe_round(d_grp['Notional'].sum(), 2)
        })
    df['_notional_bucket'] = df['Notional'].apply(notional_bucket)
    size_data = []
    for bucket in NOTIONAL_BUCKET_ORDER:
        b_grp = df[df['_notional_bucket'] == bucket]
        if len(b_grp) == 0:
            size_data.append({'bucket': bucket, 'sr': 0, 'count': 0})
            continue
        if b_grp['Directional_Consistency'].dtype == bool:
            sr = b_grp['Directional_Consistency'].sum() / len(b_grp) * 100
        else:
            sr = b_grp['Directional_Consistency'].mean() * 100
        size_data.append({'bucket': bucket, 'sr': safe_round(sr, 1), 'count': len(b_grp)})
    df.drop(columns=['_notional_bucket'], inplace=True)
    directional_success = {
        'overall': {'success_rate_pct': safe_round(dc_rate, 1), 'total_trades': total_obs, 'successful_trades': dc_count},
        'by_gap_direction': {
            'directions': [d['dir'] for d in dir_data],
            'success_rate_pct': [d['sr'] for d in dir_data],
            'count': [d['count'] for d in dir_data],
            'notional': [d['notional'] for d in dir_data]
        },
        'by_size': {
            'buckets': [s['bucket'] for s in size_data],
            'success_rate_pct': [s['sr'] for s in size_data],
            'count': [s['count'] for s in size_data]
        }
    }
    print(f"  7. directional_success.json")

    # 8. etf_analysis.json
    etf_df = df[df['Asset_Type'] == 'ETF'].copy() if 'Asset_Type' in df.columns else pd.DataFrame()
    if len(etf_df) > 0:
        etf_notional = etf_df['Notional'].sum()
        cat_col = 'ETF_Category' if 'ETF_Category' in etf_df.columns else None
        cat_data = []
        if cat_col:
            etf_df['_cat'] = etf_df[cat_col].fillna('Unknown')
            for cat, grp in etf_df.groupby('_cat'):
                if cat == 'Unknown' or not cat: continue
                if grp['Directional_Consistency'].dtype == bool:
                    sr = grp['Directional_Consistency'].sum() / len(grp) * 100
                else:
                    sr = grp['Directional_Consistency'].mean() * 100
                cat_data.append({'cat': cat, 'notional': grp['Notional'].sum(),
                                 'symbol_count': int(grp['Symbol'].nunique()), 'sr': safe_round(sr, 1)})
            cat_data.sort(key=lambda x: x['notional'], reverse=True)
            cat_data = cat_data[:15]
        lev_col = 'Leverage_Multiple' if 'Leverage_Multiple' in etf_df.columns else None
        lev_data = []
        if lev_col:
            for lev in ['1x', '2x', '3x', '-1x', '-2x', '-3x']:
                l_grp = etf_df[etf_df[lev_col] == lev]
                if len(l_grp) == 0: continue
                if l_grp['Directional_Consistency'].dtype == bool:
                    sr = l_grp['Directional_Consistency'].sum() / len(l_grp) * 100
                else:
                    sr = l_grp['Directional_Consistency'].mean() * 100
                lev_data.append({'lev': lev, 'notional': safe_round(l_grp['Notional'].sum(), 2),
                                 'symbol_count': int(l_grp['Symbol'].nunique()), 'sr': safe_round(sr, 1)})
        etf_analysis = {
            'summary': {'total_etf_observations': len(etf_df), 'unique_etfs': int(etf_df['Symbol'].nunique()),
                        'total_notional': safe_round(etf_notional, 2),
                        'pct_of_total_notional': safe_round(etf_notional/total_notional*100, 1)},
            'by_category': {'categories': [c['cat'] for c in cat_data],
                            'notional': [safe_round(c['notional'], 2) for c in cat_data],
                            'symbol_count': [c['symbol_count'] for c in cat_data],
                            'success_rate_pct': [c['sr'] for c in cat_data]},
            'by_leverage': {'leverage': [l['lev'] for l in lev_data],
                            'notional': [l['notional'] for l in lev_data],
                            'symbol_count': [l['symbol_count'] for l in lev_data],
                            'success_rate_pct': [l['sr'] for l in lev_data]}
        }
    else:
        etf_analysis = {
            'summary': {'total_etf_observations': 0, 'unique_etfs': 0, 'total_notional': 0, 'pct_of_total_notional': 0},
            'by_category': {'categories': [], 'notional': [], 'symbol_count': [], 'success_rate_pct': []},
            'by_leverage': {'leverage': [], 'notional': [], 'symbol_count': [], 'success_rate_pct': []}
        }
    print(f"  8. etf_analysis.json")

    # 9. mcap_analysis.json
    mcap_col = 'Market_Cap' if 'Market_Cap' in df.columns else None
    if mcap_col:
        df['_mcap_bucket'] = df[mcap_col].apply(mcap_bucket)
        mcap_data = []
        for bucket in MCAP_BUCKET_ORDER:
            b_grp = df[df['_mcap_bucket'] == bucket]
            if len(b_grp) == 0:
                mcap_data.append({'bucket': bucket, 'notional': 0, 'pct': 0, 'count': 0, 'syms': 0, 'sr': 0})
                continue
            if b_grp['Directional_Consistency'].dtype == bool:
                sr = b_grp['Directional_Consistency'].sum() / len(b_grp) * 100
            else:
                sr = b_grp['Directional_Consistency'].mean() * 100
            mcap_data.append({'bucket': bucket, 'notional': b_grp['Notional'].sum(),
                              'pct': safe_round(b_grp['Notional'].sum()/total_notional*100, 1),
                              'count': len(b_grp), 'syms': int(b_grp['Symbol'].nunique()), 'sr': safe_round(sr, 1)})
        df.drop(columns=['_mcap_bucket'], inplace=True)
        mcap_analysis = {
            'distribution': {
                'buckets': [m['bucket'] for m in mcap_data],
                'notional': [safe_round(m['notional'], 2) for m in mcap_data],
                'notional_pct': [m['pct'] for m in mcap_data],
                'count': [m['count'] for m in mcap_data],
                'unique_symbols': [m['syms'] for m in mcap_data],
                'success_rate_pct': [m['sr'] for m in mcap_data]
            }
        }
    else:
        mcap_analysis = {
            'distribution': {'buckets': MCAP_BUCKET_ORDER, 'notional': [0]*5, 'notional_pct': [0]*5,
                             'count': [0]*5, 'unique_symbols': [0]*5, 'success_rate_pct': [0]*5}
        }
    print(f"  9. mcap_analysis.json")

    # 10. beta_distribution.json
    beta_col = 'Beta' if 'Beta' in df.columns else None
    if beta_col:
        beta_vals = df[beta_col].dropna()
        beta_vals = beta_vals[beta_vals > 0]
        if len(beta_vals) > 0:
            beta_distribution = {'overall': {'mean': safe_round(beta_vals.mean(), 3),
                                             'median': safe_round(beta_vals.median(), 3),
                                             'std': safe_round(beta_vals.std(), 3)}}
        else:
            beta_distribution = {'overall': {'mean': 0, 'median': 0, 'std': 0}}
    else:
        beta_distribution = {'overall': {'mean': 0, 'median': 0, 'std': 0}}
    print(f"  10. beta_distribution.json")

    # Save all 10 files
    files_to_save = {
        'summary_stats.json': summary_stats,
        'daily_volume.json': daily_volume,
        'sector_breakdown.json': sector_breakdown,
        'top_symbols.json': top_symbols,
        'spread_analysis.json': spread_analysis,
        'alpha_metrics.json': alpha_metrics,
        'directional_success.json': directional_success,
        'etf_analysis.json': etf_analysis,
        'mcap_analysis.json': mcap_analysis,
        'beta_distribution.json': beta_distribution,
    }

    print(f"\n  Saving to {dashboard_dir}/")
    for filename, data in files_to_save.items():
        filepath = os.path.join(dashboard_dir, filename)
        with open(filepath, 'w') as f:
            json.dump(data, f, indent=2)
        size = os.path.getsize(filepath)
        size_str = f'{size/1024:.1f} KB' if size > 1024 else f'{size} B'
        print(f"    {filename:<30} {size_str:>10}")

    # Cleanup
    df.drop(columns=['Trade_Date_Only'], inplace=True, errors='ignore')

    print(f"\n  Dashboard regeneration complete!")
    print(f"  Date range: {dates[0]} to {dates[-1]} ({len(dates)} days)")


def generate_data_json(df: pd.DataFrame, dates: list, output_path: str, include_venue: bool = False):
    """Generate compressed data.json for the live interactive dashboard.

    Args:
        df: Complete DataFrame
        dates: sorted list of date objects
        output_path: path to write data.json
        include_venue: if True, add venue_idx to data rows and venues to lookup
    """

    # Build lookups
    sym_info = df.drop_duplicates('Symbol')[['Symbol']].copy().sort_values('Symbol').reset_index(drop=True)
    meta_cols = ['Symbol', 'Company_Name', 'Asset_Type', 'Sector', 'ETF_Category',
                 'Leverage_Multiple', 'Market_Cap']
    available_meta = [c for c in meta_cols if c in df.columns]
    sym_meta = df.drop_duplicates('Symbol')[available_meta].copy()
    sym_info = sym_info.merge(sym_meta, on='Symbol', how='left')

    symbols_list = sym_info['Symbol'].tolist()
    companies_list = sym_info['Company_Name'].fillna(sym_info['Symbol']).tolist()
    symbol_to_idx = {s: i for i, s in enumerate(symbols_list)}

    # Sectors (flat GICS + ETF categories)
    all_sectors_raw = set()
    for _, row in sym_info.iterrows():
        asset_type = row.get('Asset_Type', 'Unknown') or 'Unknown'
        if pd.isna(asset_type):
            asset_type = 'Unknown'
        if asset_type == 'ETF':
            cat = row.get('ETF_Category', None)
            if cat and not pd.isna(cat) and str(cat) not in ['nan', 'None', 'Unknown', '']:
                all_sectors_raw.add(str(cat))
            else:
                sector = row.get('Sector', 'Unknown')
                all_sectors_raw.add('Unknown' if pd.isna(sector) or not sector else str(sector))
        else:
            sector = row.get('Sector', 'Unknown')
            all_sectors_raw.add('Unknown' if pd.isna(sector) or not sector else str(sector))

    # Remove any NaN/None that leaked through
    all_sectors_raw.discard(float('nan'))
    all_sectors_raw = {s for s in all_sectors_raw if isinstance(s, str)}
    sectors_list = sorted(all_sectors_raw)
    if 'Unknown' in sectors_list:
        sectors_list.remove('Unknown')
        sectors_list.append('Unknown')
    sector_to_idx = {s: i for i, s in enumerate(sectors_list)}

    def get_sector_for_symbol(row):
        asset_type = row.get('Asset_Type', 'Unknown') or 'Unknown'
        if pd.isna(asset_type):
            asset_type = 'Unknown'
        if asset_type == 'ETF':
            cat = row.get('ETF_Category', None)
            if cat and not pd.isna(cat) and str(cat) not in ['nan', 'None', 'Unknown', '']:
                return str(cat)
        sector = row.get('Sector', 'Unknown')
        return 'Unknown' if pd.isna(sector) or not sector else str(sector)

    sym_info['_display_sector'] = sym_info.apply(get_sector_for_symbol, axis=1)
    sym_sector_map = dict(zip(sym_info['Symbol'], sym_info['_display_sector']))

    df['_trade_date_str'] = pd.to_datetime(df['Trade_Date']).dt.strftime('%Y-%m-%d')
    dates_list = sorted(df['_trade_date_str'].unique().tolist())
    date_to_idx = {d: i for i, d in enumerate(dates_list)}

    # Venue lookup (if needed)
    venues_list = ['BlueOcean', 'Bruce', 'Moon']
    venue_to_idx = {v: i for i, v in enumerate(venues_list)}

    # Winsorization bounds
    td_vals = df['Timing_Differential_bps'].dropna()
    rg_vals = df['Reference_Gap_bps'].dropna()
    td_lo, td_hi = float(np.percentile(td_vals, 5)), float(np.percentile(td_vals, 95))
    rg_lo, rg_hi = float(np.percentile(rg_vals, 5)), float(np.percentile(rg_vals, 95))

    # Safe NaN-to-int helper (float('nan') is truthy, so `or 0` doesn't work)
    def safe_int(v):
        try:
            f = float(v) if v is not None else 0.0
            if f != f:  # NaN check
                return 0
            return int(f)
        except (ValueError, TypeError):
            return 0

    def safe_float(v, decimals=2):
        try:
            f = float(v) if v is not None else 0.0
            if f != f:  # NaN check
                return 0.0
            return round(f, decimals)
        except (ValueError, TypeError):
            return 0.0

    # Build data rows
    data_rows = []
    trades_col_name = 'Trades' if 'Trades' in df.columns else None

    for _, row in df.iterrows():
        symbol = row['Symbol']
        sym_idx = symbol_to_idx.get(symbol, 0)
        date_str = row['_trade_date_str']
        date_idx = date_to_idx.get(date_str, 0)
        asset_type = row.get('Asset_Type', 'Unknown') or 'Unknown'
        asset_type_int = 1 if asset_type == 'ETF' else 0
        display_sector = sym_sector_map.get(symbol, 'Unknown')
        sector_idx = sector_to_idx.get(display_sector, len(sectors_list) - 1)

        td = safe_float(row.get('Timing_Differential_bps', 0), 4)
        rg = safe_float(row.get('Reference_Gap_bps', 0), 4)
        total_gap_val = safe_float(row.get('Total_Overnight_Gap_bps', 0), 4)
        td_w = round(max(td_lo, min(td_hi, td)), 1)
        rg_w = round(max(rg_lo, min(rg_hi, rg)), 1)

        gap_dir = row.get('Gap_Direction', 'DOWN')
        gap_dir_int = 1 if gap_dir == 'UP' else 0
        dir_con = row.get('Directional_Consistency', False)
        dir_con_int = 1 if (dir_con is True or dir_con == 1) else 0
        is_outlier = row.get('Is_Outlier', False)
        outlier_int = 1 if (is_outlier is True or is_outlier == 1) else 0

        mcap = row.get('Market_Cap', None)
        mcap_f = safe_float(mcap, 2)
        mcap_val = round(mcap_f / 1e9, 2) if mcap_f > 0 else None
        lev_mult = str(row.get('Leverage_Multiple', '1x') or '1x')

        ca = safe_float(row.get('Captured_Alpha_bps', 0), 4)
        ca_r = round(ca, 1)
        ca_w = round(max(td_lo, min(td_hi, ca)), 1)

        if include_venue:
            venue_str = row.get('Venue', 'BlueOcean') or 'BlueOcean'
            v_idx = venue_to_idx.get(venue_str, 0)
            data_rows.append([
                sym_idx, sym_idx, date_idx, asset_type_int, sector_idx, v_idx,
                safe_float(row.get('Notional', 0), 2),
                safe_int(row.get('Volume', 0)),
                safe_int(row.get(trades_col_name, 0)) if trades_col_name else 0,
                safe_float(row.get('VWAP_Price', 0), 4),
                safe_float(row.get('Prior_Close', 0), 4),
                safe_float(row.get('Next_Open', 0), 4),
                safe_float(row.get('Next_Close', 0), 2),
                round(td, 1), td_w, round(rg, 1), rg_w, round(total_gap_val, 1),
                gap_dir_int, dir_con_int, outlier_int,
                mcap_val, lev_mult,
                ca_r, ca_w
            ])
        else:
            data_rows.append([
                sym_idx, sym_idx, date_idx, asset_type_int, sector_idx,
                safe_float(row.get('Notional', 0), 2),
                safe_int(row.get('Volume', 0)),
                safe_int(row.get(trades_col_name, 0)) if trades_col_name else 0,
                safe_float(row.get('VWAP_Price', 0), 4),
                safe_float(row.get('Prior_Close', 0), 4),
                safe_float(row.get('Next_Open', 0), 4),
                safe_float(row.get('Next_Close', 0), 2),
                round(td, 1), td_w, round(rg, 1), rg_w, round(total_gap_val, 1),
                gap_dir_int, dir_con_int, outlier_int,
                mcap_val, lev_mult,
                ca_r, ca_w
            ])

    # Build lookup dict
    lookup = {
        'symbols': symbols_list,
        'companies': companies_list,
        'sectors': sectors_list,
        'dates': dates_list
    }
    if include_venue:
        lookup['venues'] = venues_list

    # Fetch VIX close per date for market context
    vix_by_date = {}
    try:
        import yfinance as yf
        # yfinance end date is exclusive, add 2-day buffer to include last date
        vix_end = (datetime.strptime(dates_list[-1], '%Y-%m-%d') + timedelta(days=2)).strftime('%Y-%m-%d')
        vix_data = yf.download('^VIX', start=dates_list[0], end=vix_end,
                               progress=False, auto_adjust=True)
        if len(vix_data) > 0:
            for idx, row in vix_data.iterrows():
                d_str = idx.strftime('%Y-%m-%d')
                close_val = row['Close']
                if hasattr(close_val, 'item'):
                    close_val = close_val.item()
                if not pd.isna(close_val):
                    vix_by_date[d_str] = round(float(close_val), 2)
            print(f"    VIX data: {len(vix_by_date)} dates fetched")
    except Exception as e:
        print(f"    VIX fetch warning: {e}")

    v10_json = {
        'meta': {
            'generated': datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
            'dateRange': [dates_list[0], dates_list[-1]],
            'tradingDays': len(dates_list),
            'totalObs': len(data_rows),
            'uniqueSymbols': len(symbols_list),
            'totalNotional': round(float(df['Notional'].sum()), 2),
            'winsor': {
                'td': [round(td_lo, 1), round(td_hi, 1)],
                'rg': [round(rg_lo, 1), round(rg_hi, 1)]
            },
            'vixByDate': vix_by_date
        },
        'lookup': lookup,
        'data': data_rows
    }

    # Sanitize NaN/Inf -> None (null in JSON) before serializing
    def sanitize_row(row):
        out = []
        for v in row:
            if isinstance(v, float) and (np.isnan(v) or np.isinf(v)):
                out.append(None)
            else:
                out.append(v)
        return out

    v10_json['data'] = [sanitize_row(r) for r in v10_json['data']]

    with open(output_path, 'w') as f:
        json.dump(v10_json, f)

    file_size = os.path.getsize(output_path) / 1024 / 1024
    print(f"    data.json: {file_size:.2f} MB ({len(data_rows):,} rows) -> {output_path}")

    df.drop(columns=['_trade_date_str'], inplace=True, errors='ignore')


# =============================================================================
# STEP 9: AUTO-DEPLOY TO WEBSITE
# =============================================================================

def deploy_to_website(combined_data_json_path: str):
    """Copy combined data.json to the website public data path, then git commit and push."""
    print("\n" + "=" * 60)
    print("AUTO-DEPLOY TO WEBSITE")
    print("=" * 60)

    if not os.path.exists(combined_data_json_path):
        print(f"  ERROR: Combined data.json not found at {combined_data_json_path}")
        return False

    # Ensure target directory exists
    target_dir = os.path.dirname(WEBSITE_DATA_PATH)
    if not os.path.exists(target_dir):
        print(f"  WARNING: Website directory does not exist: {target_dir}")
        print(f"  Skipping website deployment.")
        return False

    try:
        shutil.copy2(combined_data_json_path, WEBSITE_DATA_PATH)
        src_size = os.path.getsize(combined_data_json_path) / 1024 / 1024
        print(f"  DEPLOYED: {combined_data_json_path}")
        print(f"       -> {WEBSITE_DATA_PATH}")
        print(f"       Size: {src_size:.2f} MB")
    except Exception as e:
        print(f"  ERROR copying to website: {e}")
        return False

    # --- Git auto-commit and push ---
    # Repo root is two levels up from sapinover-site/public/data/
    repo_root = os.path.normpath(os.path.join(target_dir, "..", "..", ".."))
    relative_file = os.path.join("sapinover-site", "public", "data", "overnight-alpha.json")
    today_str = datetime.now().strftime("%Y-%m-%d")
    commit_msg = f"Auto-deploy: update 3-ATS data.json [{today_str}]"

    print(f"\n  GIT DEPLOY:")
    print(f"    Repo root : {repo_root}")
    print(f"    File      : {relative_file}")
    print(f"    Commit msg: {commit_msg}")

    try:
        # git add
        result_add = subprocess.run(
            ["git", "add", relative_file],
            cwd=repo_root,
            capture_output=True,
            text=True,
            timeout=30,
        )
        if result_add.returncode != 0:
            print(f"  WARNING: git add failed (rc={result_add.returncode}): {result_add.stderr.strip()}")
            return True  # file was copied successfully, git just failed

        # git commit
        result_commit = subprocess.run(
            ["git", "commit", "-m", commit_msg],
            cwd=repo_root,
            capture_output=True,
            text=True,
            timeout=30,
        )
        if result_commit.returncode != 0:
            stderr = result_commit.stderr.strip()
            stdout = result_commit.stdout.strip()
            # "nothing to commit" is not a real error
            if "nothing to commit" in stdout or "nothing to commit" in stderr:
                print(f"    No changes to commit (file unchanged).")
                return True
            print(f"  WARNING: git commit failed (rc={result_commit.returncode}): {stderr or stdout}")
            return True

        print(f"    Committed successfully.")

        # git push
        result_push = subprocess.run(
            ["git", "push", "origin", "main"],
            cwd=repo_root,
            capture_output=True,
            text=True,
            timeout=60,
        )
        if result_push.returncode != 0:
            print(f"  WARNING: git push failed (rc={result_push.returncode}): {result_push.stderr.strip()}")
            print(f"    The commit is local. Run 'git push origin main' manually.")
            return True

        print(f"    Pushed to origin/main successfully.")
        return True

    except subprocess.TimeoutExpired:
        print(f"  WARNING: Git operation timed out. The file was copied but may not be pushed.")
        print(f"    Run 'git push origin main' manually from {repo_root}")
        return True
    except FileNotFoundError:
        print(f"  WARNING: 'git' command not found. Install Git or push manually.")
        return True
    except Exception as e:
        print(f"  WARNING: Git deploy error: {e}")
        print(f"    The file was copied successfully. Push manually if needed.")
        return True


# =============================================================================
# MAIN: BOATS-ONLY BACKWARD COMPAT MODE
# =============================================================================

def main_boats_only(dry_run: bool, skip_today: bool):
    """Run in BlueOcean-only backward compatibility mode."""
    print("=" * 60)
    print("BLUEOCEAN MASTER PARQUET APPEND TOOL (BOATS-ONLY MODE)")
    print("=" * 60)
    if dry_run:
        print("** DRY RUN MODE - no changes will be made **\n")
    if skip_today:
        print("** T-1 MODE - skipping today's date, processing only T-1 and earlier **\n")

    # Step 1: Scan for BOATS files and compare to master
    print("\nStep 1: Scanning for BOATS files...")
    all_boats = find_all_boats_files()
    print(f"  Found {len(all_boats)} BOATS files on disk")

    master_path = MASTER_FILES[0]
    existing_dates = get_existing_dates(master_path)
    print(f"  Master parquet has {len(existing_dates)} dates")

    missing_dates = sorted(set(all_boats.keys()) - existing_dates)

    if skip_today:
        today_str = datetime.now().strftime('%Y-%m-%d')
        if today_str in missing_dates:
            print(f"  Skipping today ({today_str}) - will process tomorrow with complete prices")
            missing_dates = [d for d in missing_dates if d != today_str]

    if not missing_dates:
        print("\n  No missing dates found. Master parquet is up to date!")
        print("  Exiting.")
        return

    print(f"\n  MISSING DATES ({len(missing_dates)}):")
    for d in missing_dates:
        print(f"    {d}: {os.path.basename(all_boats[d])}")

    if dry_run:
        print("\n  DRY RUN complete. Run without --dry-run to process.")
        return

    # Step 2: Load and filter raw data
    print(f"\nStep 2: Loading and filtering {len(missing_dates)} files...")
    all_new_data = []
    for date_str in missing_dates:
        filepath = all_boats[date_str]
        print(f"  {date_str}: {os.path.basename(filepath)}")
        df = load_boats_file(filepath, date_str)
        df = filter_institutional(df)
        all_new_data.append(df)

    new_df = pd.concat(all_new_data, ignore_index=True)
    print(f"\n  Total new rows after filter: {len(new_df):,}")
    print(f"  Unique symbols: {new_df['Symbol'].nunique():,}")

    # Step 3: Fetch yfinance market prices
    print(f"\nStep 3: Fetching market data...")
    symbols = new_df['Symbol'].unique().tolist()
    min_date = new_df['Trade_Date'].min()
    max_date = new_df['Trade_Date'].max()
    market_df = fetch_market_data(symbols, min_date, max_date)

    # Step 4: Merge prices and calculate metrics
    print(f"\nStep 4: Merging market data and calculating metrics...")
    new_df = merge_market_prices(new_df, market_df)
    new_df = calculate_metrics(new_df)

    # Step 5: Update Symbol Master
    print(f"\nStep 5: Updating Symbol Master...")
    symbol_df = update_symbol_master(symbols)

    # Step 6: Merge Symbol Master metadata
    print(f"\nStep 6: Merging symbol metadata...")
    new_df = merge_symbol_metadata(new_df, symbol_df)

    # Step 7: Append to master parquet (both copies)
    print(f"\nStep 7: Appending to master parquet...")
    combined = None
    for mpath in MASTER_FILES:
        print(f"\n  Updating: {os.path.basename(mpath)}")
        combined = append_to_blueocean_parquet(new_df.copy(), mpath)
        combined.to_parquet(mpath, index=False)
        print(f"  Saved: {len(combined):,} rows, {combined['Trade_Date'].nunique()} dates")

    # Also save dated copy
    all_dates = pd.to_datetime(combined['Trade_Date']).dt.date
    date_min = all_dates.min().strftime('%Y%m%d')
    date_max = all_dates.max().strftime('%Y%m%d')
    dated_path = os.path.join(BLUEOCEAN_DIR,
                               f'BlueOcean_Master_Institutional_{date_min}_{date_max}.parquet')
    combined.to_parquet(dated_path, index=False)
    print(f"\n  Dated copy: {os.path.basename(dated_path)}")

    # Step 8: Regenerate dashboard JSON
    regenerate_dashboard_json(combined, DASHBOARD_DIR)

    # Generate BlueOcean data.json
    if 'Data_Status' in combined.columns:
        complete_df = combined[combined['Data_Status'] == 'Complete'].copy()
    else:
        complete_df = combined.copy()
    complete_df['Trade_Date'] = pd.to_datetime(complete_df['Trade_Date'])
    complete_df['Trade_Date_Only'] = complete_df['Trade_Date'].dt.date
    bo_dates = sorted(complete_df['Trade_Date_Only'].unique())
    print(f"\n  Generating BlueOcean data.json...")
    bo_data_json_path = os.path.join(BLUEOCEAN_DIR, 'data.json')
    generate_data_json(complete_df, bo_dates, bo_data_json_path, include_venue=False)
    complete_df.drop(columns=['Trade_Date_Only'], inplace=True, errors='ignore')

    # Final summary
    print("\n" + "=" * 60)
    print("APPEND COMPLETE (BOATS-ONLY)")
    print("=" * 60)
    print(f"  New dates added: {len(missing_dates)}")
    print(f"  New rows added: {len(new_df):,}")
    print(f"  Master total: {len(combined):,} rows")
    print(f"  Date range: {date_min} to {date_max}")
    print(f"  Trading days: {combined['Trade_Date'].nunique()}")
    print(f"  Total notional: {format_currency(combined['Notional'].sum())}")


# =============================================================================
# MAIN: COMBINED 3-VENUE MODE
# =============================================================================

def regen_json_only():
    """Regenerate data.json files from existing parquets without processing new files."""
    print("=" * 60)
    print("REGENERATE JSON ONLY MODE")
    print("=" * 60)

    # Combined data.json
    combined_parquet = COMBINED_MASTER
    if os.path.exists(combined_parquet):
        combined = pd.read_parquet(combined_parquet)
        if 'Data_Status' in combined.columns:
            complete = combined[combined['Data_Status'] == 'Complete'].copy()
        else:
            complete = combined.copy()
        complete['Trade_Date'] = pd.to_datetime(complete['Trade_Date'])
        complete['Trade_Date_Only'] = complete['Trade_Date'].dt.date
        c_dates = sorted(complete['Trade_Date_Only'].unique())
        combined_json_path = os.path.join(COMBINED_DIR, 'data.json')
        print(f"\n  Generating combined data.json ({len(complete):,} rows, {len(c_dates)} dates)...")
        generate_data_json(complete, c_dates, combined_json_path, include_venue=True)
        complete.drop(columns=['Trade_Date_Only'], inplace=True, errors='ignore')

        # Deploy to website
        deploy_to_website(combined_json_path)
    else:
        print(f"  ERROR: Combined master not found at {combined_parquet}")

    # BlueOcean-only data.json
    if os.path.exists(MASTER_FILES[0]):
        bo = pd.read_parquet(MASTER_FILES[0])
        if 'Data_Status' in bo.columns:
            complete_bo = bo[bo['Data_Status'] == 'Complete'].copy()
        else:
            complete_bo = bo.copy()
        complete_bo['Trade_Date'] = pd.to_datetime(complete_bo['Trade_Date'])
        complete_bo['Trade_Date_Only'] = complete_bo['Trade_Date'].dt.date
        bo_dates = sorted(complete_bo['Trade_Date_Only'].unique())
        bo_json_path = os.path.join(BLUEOCEAN_DIR, 'data.json')
        print(f"\n  Generating BlueOcean-only data.json ({len(complete_bo):,} rows, {len(bo_dates)} dates)...")
        generate_data_json(complete_bo, bo_dates, bo_json_path, include_venue=False)

    print("\n  JSON regeneration complete!")


def main():
    dry_run = '--dry-run' in sys.argv
    skip_today = '--skip-today' in sys.argv
    boats_only = '--boats-only' in sys.argv
    regen_json = '--regen-json' in sys.argv

    if regen_json:
        regen_json_only()
        return

    if boats_only:
        main_boats_only(dry_run, skip_today)
        return

    print("=" * 60)
    print("COMBINED ATS MASTER PARQUET TOOL (3-Venue)")
    print("=" * 60)
    if dry_run:
        print("** DRY RUN MODE - no changes will be made **\n")
    if skip_today:
        print("** T-1 MODE - skipping today's date, processing only T-1 and earlier **\n")

    print(f"  Scan directories: {len(SCAN_DIRS)}")
    for sd in SCAN_DIRS:
        if sd != BASE_DIR:
            print(f"    {os.path.basename(sd)}")

    # =========================================================================
    # Step 1: Scan for unprocessed files from all 3 venues
    # =========================================================================
    print("\nStep 1: Scanning for venue files...")
    all_venue_files = find_all_venue_files()

    # Count by venue
    bo_count = sum(1 for d in all_venue_files.values() if 'BlueOcean' in d)
    bruce_count = sum(1 for d in all_venue_files.values() if 'Bruce' in d)
    moon_count = sum(1 for d in all_venue_files.values() if 'Moon' in d)
    print(f"  Files found on disk:")
    print(f"    BlueOcean: {bo_count} files")
    print(f"    Bruce:     {bruce_count} files")
    print(f"    Moon:      {moon_count} files")
    print(f"    Dates:     {len(all_venue_files)} unique dates")

    # Check what is already in combined master
    existing_pairs = get_existing_date_venue_pairs()
    print(f"  Combined master has {len(existing_pairs)} (date, venue) pairs")

    # Find missing (date, venue) pairs
    missing_work = []  # list of (date_str, venue, filepath)
    for date_str in sorted(all_venue_files.keys()):
        for venue, filepath in all_venue_files[date_str].items():
            if (date_str, venue) not in existing_pairs:
                missing_work.append((date_str, venue, filepath))

    # T-1 mode: exclude today's date
    if skip_today:
        today_str = datetime.now().strftime('%Y-%m-%d')
        before = len(missing_work)
        missing_work = [(d, v, f) for d, v, f in missing_work if d != today_str]
        skipped = before - len(missing_work)
        if skipped > 0:
            print(f"  Skipping today ({today_str}): {skipped} venue files deferred")

    if not missing_work:
        print("\n  No missing (date, venue) pairs found. Combined master is up to date!")
        print("  Exiting.")
        return

    # Summarize missing work
    missing_dates = sorted(set(d for d, v, f in missing_work))
    missing_by_venue = {}
    for d, v, f in missing_work:
        if v not in missing_by_venue:
            missing_by_venue[v] = []
        missing_by_venue[v].append(d)

    print(f"\n  MISSING (date, venue) PAIRS ({len(missing_work)} total):")
    for venue in ['BlueOcean', 'Bruce', 'Moon']:
        if venue in missing_by_venue:
            dates_list = missing_by_venue[venue]
            print(f"    {venue}: {len(dates_list)} dates")
            for d in sorted(dates_list)[:5]:
                matched = [(dd, vv, ff) for dd, vv, ff in missing_work if dd == d and vv == venue]
                if matched:
                    print(f"      {d}: {os.path.basename(matched[0][2])}")
            if len(dates_list) > 5:
                print(f"      ... and {len(dates_list) - 5} more")

    if dry_run:
        print("\n  DRY RUN complete. Run without --dry-run to process.")
        return

    # =========================================================================
    # Step 2: Load and filter raw data from all 3 venues
    # =========================================================================
    print(f"\nStep 2: Loading and filtering {len(missing_work)} venue files...")
    all_new_data = []
    venue_row_counts = {'BlueOcean': 0, 'Bruce': 0, 'Moon': 0}

    for date_str, venue, filepath in missing_work:
        print(f"  {date_str} [{venue}]: {os.path.basename(filepath)}")
        if venue == 'BlueOcean':
            df = load_boats_file(filepath, date_str)
        elif venue == 'Bruce':
            df = load_bruce_file(filepath, date_str)
        elif venue == 'Moon':
            df = load_moon_file(filepath, date_str)
        else:
            print(f"    WARNING: Unknown venue '{venue}', skipping")
            continue
        df = filter_institutional(df)
        venue_row_counts[venue] += len(df)
        all_new_data.append(df)

    if not all_new_data:
        print("\n  No data loaded. Exiting.")
        return

    new_df = pd.concat(all_new_data, ignore_index=True)
    print(f"\n  Total new rows after filter: {len(new_df):,}")
    print(f"  By venue:")
    for v in ['BlueOcean', 'Bruce', 'Moon']:
        if venue_row_counts[v] > 0:
            print(f"    {v}: {venue_row_counts[v]:,}")
    print(f"  Unique symbols (across all venues): {new_df['Symbol'].nunique():,}")

    # =========================================================================
    # Step 3: Fetch yfinance market prices (deduplicated across venues)
    # =========================================================================
    print(f"\nStep 3: Fetching market data...")
    # Deduplicate symbols across venues before fetching
    symbols = new_df['Symbol'].unique().tolist()
    min_date = new_df['Trade_Date'].min()
    max_date = new_df['Trade_Date'].max()
    market_df = fetch_market_data(symbols, min_date, max_date)

    # =========================================================================
    # Step 4: Merge prices and calculate metrics
    # =========================================================================
    print(f"\nStep 4: Merging market data and calculating metrics...")
    new_df = merge_market_prices(new_df, market_df)
    new_df = calculate_metrics(new_df)

    # =========================================================================
    # Step 5: Update Symbol Master
    # =========================================================================
    print(f"\nStep 5: Updating Symbol Master...")
    symbol_df = update_symbol_master(symbols)

    # =========================================================================
    # Step 6: Merge Symbol Master metadata
    # =========================================================================
    print(f"\nStep 6: Merging symbol metadata...")
    new_df = merge_symbol_metadata(new_df, symbol_df)

    # =========================================================================
    # Step 7: Append to master parquet
    # =========================================================================
    print(f"\nStep 7: Appending to master parquets...")

    # 7a: Append to Combined_Master_Institutional.parquet (primary)
    print(f"\n  7a. Updating combined master: {os.path.basename(COMBINED_MASTER)}")
    combined = append_to_combined_parquet(new_df.copy())
    combined.to_parquet(COMBINED_MASTER, index=False)
    print(f"  Saved: {len(combined):,} rows, {combined['Trade_Date'].nunique()} dates")
    n_venues_in_master = combined['Venue'].nunique() if 'Venue' in combined.columns else 1
    print(f"  Venues in master: {n_venues_in_master}")

    # 7b: Backward-compat: update BlueOcean-only master files
    bo_new = new_df[new_df['Venue'] == 'BlueOcean'].copy() if 'Venue' in new_df.columns else new_df.copy()
    if len(bo_new) > 0:
        print(f"\n  7b. Updating BlueOcean-only masters ({len(bo_new):,} rows)...")
        # Drop the Venue column for backward compat if present
        bo_for_master = bo_new.copy()
        bo_combined = None
        for mpath in MASTER_FILES:
            print(f"    Updating: {os.path.basename(mpath)}")
            bo_combined = append_to_blueocean_parquet(bo_for_master.copy(), mpath)
            bo_combined.to_parquet(mpath, index=False)
            print(f"    Saved: {len(bo_combined):,} rows, {bo_combined['Trade_Date'].nunique()} dates")

        # Also save dated copy
        all_dates_bo = pd.to_datetime(bo_combined['Trade_Date']).dt.date
        date_min_bo = all_dates_bo.min().strftime('%Y%m%d')
        date_max_bo = all_dates_bo.max().strftime('%Y%m%d')
        dated_path = os.path.join(BLUEOCEAN_DIR,
                                   f'BlueOcean_Master_Institutional_{date_min_bo}_{date_max_bo}.parquet')
        bo_combined.to_parquet(dated_path, index=False)
        print(f"    Dated copy: {os.path.basename(dated_path)}")
    else:
        print(f"\n  7b. No new BlueOcean data, skipping backward-compat update.")
        bo_combined = None

    # =========================================================================
    # Step 8: Regenerate dashboard JSON
    # =========================================================================

    # 8a: Combined dashboard
    print(f"\n  8a. Regenerating combined dashboard JSON -> {COMBINED_DASHBOARD_DIR}")
    regenerate_dashboard_json(combined, COMBINED_DASHBOARD_DIR)

    # 8b: Generate combined data.json with Venue field
    if 'Data_Status' in combined.columns:
        complete_combined = combined[combined['Data_Status'] == 'Complete'].copy()
    else:
        complete_combined = combined.copy()
    complete_combined['Trade_Date'] = pd.to_datetime(complete_combined['Trade_Date'])
    complete_combined['Trade_Date_Only'] = complete_combined['Trade_Date'].dt.date
    combined_dates = sorted(complete_combined['Trade_Date_Only'].unique())

    print(f"\n  Generating combined data.json (with venue field)...")
    combined_data_json_path = os.path.join(COMBINED_DIR, 'data.json')
    generate_data_json(complete_combined, combined_dates, combined_data_json_path, include_venue=True)
    complete_combined.drop(columns=['Trade_Date_Only'], inplace=True, errors='ignore')

    # 8c: Generate BlueOcean-only data.json for GitHub Pages dashboard
    if bo_combined is not None:
        if 'Data_Status' in bo_combined.columns:
            complete_bo = bo_combined[bo_combined['Data_Status'] == 'Complete'].copy()
        else:
            complete_bo = bo_combined.copy()
        complete_bo['Trade_Date'] = pd.to_datetime(complete_bo['Trade_Date'])
        complete_bo['Trade_Date_Only'] = complete_bo['Trade_Date'].dt.date
        bo_dates = sorted(complete_bo['Trade_Date_Only'].unique())
        print(f"\n  Generating BlueOcean-only data.json...")
        bo_data_json_path = os.path.join(BLUEOCEAN_DIR, 'data.json')
        generate_data_json(complete_bo, bo_dates, bo_data_json_path, include_venue=False)
        complete_bo.drop(columns=['Trade_Date_Only'], inplace=True, errors='ignore')
    else:
        # If no new BO data, regenerate from existing BO masters
        if os.path.exists(MASTER_FILES[0]):
            existing_bo = pd.read_parquet(MASTER_FILES[0])
            if 'Data_Status' in existing_bo.columns:
                complete_bo = existing_bo[existing_bo['Data_Status'] == 'Complete'].copy()
            else:
                complete_bo = existing_bo.copy()
            complete_bo['Trade_Date'] = pd.to_datetime(complete_bo['Trade_Date'])
            complete_bo['Trade_Date_Only'] = complete_bo['Trade_Date'].dt.date
            bo_dates = sorted(complete_bo['Trade_Date_Only'].unique())
            print(f"\n  Regenerating BlueOcean-only data.json from existing master...")
            bo_data_json_path = os.path.join(BLUEOCEAN_DIR, 'data.json')
            generate_data_json(complete_bo, bo_dates, bo_data_json_path, include_venue=False)
            complete_bo.drop(columns=['Trade_Date_Only'], inplace=True, errors='ignore')

    # =========================================================================
    # Step 9: Auto-deploy to website
    # =========================================================================
    deploy_to_website(combined_data_json_path)

    # =========================================================================
    # Final summary
    # =========================================================================
    all_dates_combined = pd.to_datetime(combined['Trade_Date']).dt.date
    date_min = all_dates_combined.min().strftime('%Y%m%d')
    date_max = all_dates_combined.max().strftime('%Y%m%d')

    # Venue breakdown
    venue_summary = {}
    if 'Venue' in combined.columns:
        for v in combined['Venue'].unique():
            v_data = combined[combined['Venue'] == v]
            venue_summary[v] = {
                'rows': len(v_data),
                'dates': v_data['Trade_Date'].nunique(),
                'symbols': v_data['Symbol'].nunique(),
                'notional': v_data['Notional'].sum()
            }

    print("\n" + "=" * 60)
    print("APPEND COMPLETE (3-Venue)")
    print("=" * 60)
    print(f"  New (date, venue) pairs added: {len(missing_work)}")
    print(f"  New rows added: {len(new_df):,}")
    print(f"  Combined master total: {len(combined):,} rows")
    print(f"  Date range: {date_min} to {date_max}")
    print(f"  Trading days: {combined['Trade_Date'].nunique()}")
    print(f"  Total notional: {format_currency(combined['Notional'].sum())}")

    if venue_summary:
        print(f"\n  Venue Breakdown:")
        print(f"    {'Venue':<12} {'Rows':>8} {'Dates':>6} {'Symbols':>8} {'Notional':>14}")
        print(f"    {'-'*12} {'-'*8} {'-'*6} {'-'*8} {'-'*14}")
        for v in ['BlueOcean', 'Bruce', 'Moon']:
            if v in venue_summary:
                vs = venue_summary[v]
                print(f"    {v:<12} {vs['rows']:>8,} {vs['dates']:>6} {vs['symbols']:>8,} {format_currency(vs['notional']):>14}")

    print(f"\n  Output files:")
    print(f"    Combined master: {COMBINED_MASTER}")
    print(f"    Combined dashboard: {COMBINED_DASHBOARD_DIR}/")
    print(f"    Combined data.json: {combined_data_json_path}")
    if bo_combined is not None:
        for mpath in MASTER_FILES:
            print(f"    BlueOcean master: {mpath}")
    bo_data_json_path = os.path.join(BLUEOCEAN_DIR, 'data.json')
    if os.path.exists(bo_data_json_path):
        print(f"    BlueOcean data.json: {bo_data_json_path}")
    if os.path.exists(WEBSITE_DATA_PATH):
        print(f"    Website deploy: {WEBSITE_DATA_PATH}")


if __name__ == "__main__":
    main()
