"""
moon_daily_pull.py - Automated daily Moon ATS data pull
=======================================================
Fetches overnight Moon ATS trading data from OTC Markets' public API
and saves as CSV to the project's Google Drive directory.

Usage:
    python moon_daily_pull.py                     # Pull today's data
    python moon_daily_pull.py --date 2026-02-26   # Pull with specific date label
    python moon_daily_pull.py --check-gaps         # Report missing recent files

Exit codes:
    0 = Success (file saved)
    1 = Skipped (weekend, holiday, or file already exists)
    2 = Error (API failure, network error, zero records)

API note:
    The endpoint /active/current returns only the most recent overnight
    session. The --date flag controls the filename, not what the API
    returns. If a day is missed, the data cannot be recovered from this
    API. Use the Colab notebook (MoonATS_extract.ipynb) for manual runs.

Schedule:
    Windows Task Scheduler, Mon-Fri at 6:00 AM ET
    (overnight session closes ~4 AM ET, 2-hour buffer)

Sapinover LLC | Overnight Trading Research Platform
"""

import os
import sys
import time
import logging
import argparse
import datetime
from logging.handlers import RotatingFileHandler

import requests
import pandas as pd

# ---------------------------------------------------------------------------
# Shared utilities (with standalone fallback)
# ---------------------------------------------------------------------------

try:
    from pull_utils import (
        BASE_DIR, LOG_DIR, US_MARKET_HOLIDAYS,
        is_trading_day, setup_logging as _setup_logging
    )
    _HAS_UTILS = True
except ImportError:
    _HAS_UTILS = False
    BASE_DIR = os.path.dirname(os.path.abspath(__file__))
    LOG_DIR = os.path.join(BASE_DIR, "logs")
    US_MARKET_HOLIDAYS = {
        datetime.date(2026, 1, 1), datetime.date(2026, 1, 19),
        datetime.date(2026, 2, 16), datetime.date(2026, 4, 3),
        datetime.date(2026, 5, 25), datetime.date(2026, 6, 19),
        datetime.date(2026, 7, 3), datetime.date(2026, 9, 7),
        datetime.date(2026, 11, 26), datetime.date(2026, 12, 25),
        datetime.date(2027, 1, 1), datetime.date(2027, 1, 18),
        datetime.date(2027, 2, 15), datetime.date(2027, 3, 26),
        datetime.date(2027, 5, 31), datetime.date(2027, 6, 18),
        datetime.date(2027, 7, 5), datetime.date(2027, 9, 6),
        datetime.date(2027, 11, 25), datetime.date(2027, 12, 24),
    }

    def is_trading_day(d: datetime.date) -> bool:
        if d.weekday() >= 5:
            return False
        return d not in US_MARKET_HOLIDAYS

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

BASE_URL = "https://backend.otcmarkets.com/otcapi/market-data/moon-overnight/active/current"

# Headers must mimic a browser or the API returns 403
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
    "Referer": "https://www.otcmarkets.com/market-activity/moon-ats/active/dollarVolume",
    "Origin": "https://www.otcmarkets.com",
    "Accept": "application/json",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Connection": "keep-alive",
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-site",
    "Sec-Ch-Ua": '"Chromium";v="133", "Not(A:Brand";v="99", "Google Chrome";v="133"',
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": '"Windows"',
}

PAGE_SIZE = 25
MAX_RETRIES = 3

# Output columns (canonical Moon ATS schema per DATA_SCHEMA.md)
OUTPUT_COLUMNS = ["Symbol", "Price", "% Change", "$ Volume", "Share Volume", "Trades"]

# ---------------------------------------------------------------------------
# Logging setup
# ---------------------------------------------------------------------------

logger = logging.getLogger("moon_pull")


def setup_logging():
    """Configure logging to both file and console."""
    if _HAS_UTILS:
        # Use shared setup from pull_utils
        return _setup_logging("moon_pull", "moon_pull.log")
    # Standalone fallback
    os.makedirs(LOG_DIR, exist_ok=True)
    log_path = os.path.join(LOG_DIR, "moon_pull.log")
    logger.setLevel(logging.DEBUG)
    fh = RotatingFileHandler(log_path, maxBytes=5 * 1024 * 1024, backupCount=3)
    fh.setLevel(logging.DEBUG)
    fh.setFormatter(logging.Formatter(
        "%(asctime)s | %(levelname)-5s | %(message)s", datefmt="%Y-%m-%d %H:%M:%S"
    ))
    ch = logging.StreamHandler(sys.stdout)
    ch.setLevel(logging.INFO)
    ch.setFormatter(logging.Formatter("%(message)s"))
    logger.addHandler(fh)
    logger.addHandler(ch)


def make_filename(d: datetime.date) -> str:
    """Generate the canonical Moon ATS CSV filename for a given date."""
    return f"MOON_ATS_MostActive_{d.strftime('%Y-%m-%d')}.csv"


def file_already_exists(d: datetime.date) -> bool:
    """Check if today's Moon file already exists in either location."""
    filename = make_filename(d)
    month_dir = d.strftime("%Y-%m")

    root_path = os.path.join(BASE_DIR, filename)
    month_path = os.path.join(BASE_DIR, month_dir, filename)

    return os.path.exists(root_path) or os.path.exists(month_path)


# ---------------------------------------------------------------------------
# API fetch
# ---------------------------------------------------------------------------

def fetch_page(page_num: int) -> dict | None:
    """Fetch a single page from the Moon ATS API with retry logic."""
    for attempt in range(MAX_RETRIES):
        try:
            params = {"page": page_num, "pageSize": PAGE_SIZE, "sortOn": "dollarVolume"}
            resp = requests.get(BASE_URL, params=params, headers=HEADERS, timeout=30)
            resp.raise_for_status()
            return resp.json()
        except (requests.RequestException, ValueError) as e:
            wait = 2 ** (attempt + 1)
            logger.warning(
                f"  Page {page_num} attempt {attempt + 1}/{MAX_RETRIES} failed: {e}. "
                f"Retrying in {wait}s..."
            )
            time.sleep(wait)

    logger.error(f"  Page {page_num} failed after {MAX_RETRIES} attempts.")
    return None


def fetch_moon_data() -> pd.DataFrame | None:
    """Fetch all Moon ATS records via paginated API calls."""
    logger.info("Fetching Moon ATS data from OTC Markets API...")

    # Page 1: get total pages and first batch of records
    first_page = fetch_page(1)
    if first_page is None:
        logger.error("Failed to fetch page 1. Aborting.")
        return None

    total_pages = first_page.get("pages", 0)
    total_records = first_page.get("totalRecords", 0)
    logger.info(f"  API reports {total_records:,} records across {total_pages} pages")

    # Validate response structure
    records = first_page.get("records", [])
    if not records:
        logger.error("Page 1 returned zero records.")
        return None

    expected_keys = {"symbol", "price", "pctChange", "dollarVolume", "shareVolume", "tradeCount"}
    actual_keys = set(records[0].keys())
    if not expected_keys.issubset(actual_keys):
        missing = expected_keys - actual_keys
        logger.error(f"API response missing expected fields: {missing}")
        return None

    all_records = list(records)

    # Fetch remaining pages
    failed_pages = 0
    for page in range(2, total_pages + 1):
        data = fetch_page(page)
        if data is not None:
            all_records.extend(data.get("records", []))
        else:
            failed_pages += 1

        if page % 10 == 0:
            logger.info(f"  Fetched page {page}/{total_pages}")

    if failed_pages > 0:
        logger.warning(f"  {failed_pages} page(s) failed. Proceeding with {len(all_records)} records.")

    logger.info(f"  Total rows collected: {len(all_records):,}")

    # Build DataFrame with canonical column names
    df = pd.DataFrame(all_records)
    df = df[["symbol", "price", "pctChange", "dollarVolume", "shareVolume", "tradeCount"]]
    df.columns = OUTPUT_COLUMNS

    # Convert pctChange decimal to percentage (e.g., 0.1291 -> 12.91)
    df["% Change"] = pd.to_numeric(df["% Change"], errors="coerce")
    df["% Change"] = (df["% Change"] * 100).round(2)

    return df


# ---------------------------------------------------------------------------
# Save
# ---------------------------------------------------------------------------

def save_csv(df: pd.DataFrame, target_date: datetime.date) -> list:
    """Save DataFrame to root directory and month directory."""
    filename = make_filename(target_date)
    saved_paths = []

    # Save to root directory
    root_path = os.path.join(BASE_DIR, filename)
    df.to_csv(root_path, index=False)
    saved_paths.append(root_path)
    logger.info(f"  Saved to: {filename}")

    # Save to month directory
    month_dir = os.path.join(BASE_DIR, target_date.strftime("%Y-%m"))
    os.makedirs(month_dir, exist_ok=True)
    month_path = os.path.join(month_dir, filename)
    df.to_csv(month_path, index=False)
    saved_paths.append(month_path)
    logger.info(f"  Saved to: {target_date.strftime('%Y-%m')}/{filename}")

    return saved_paths


# ---------------------------------------------------------------------------
# Gap checker
# ---------------------------------------------------------------------------

def check_for_gaps(lookback_days: int = 5):
    """Report any missing Moon ATS files for recent trading days."""
    today = datetime.date.today()
    missing = []

    for i in range(1, lookback_days + 1):
        check_date = today - datetime.timedelta(days=i)
        if is_trading_day(check_date) and not file_already_exists(check_date):
            missing.append(check_date)

    if missing:
        logger.warning(f"Missing Moon ATS data for {len(missing)} trading day(s):")
        for d in sorted(missing):
            logger.warning(f"  {d.strftime('%Y-%m-%d')} ({d.strftime('%A')})")
        logger.warning(
            "Note: The API only serves the latest session. "
            "Use the Colab notebook (MoonATS_extract.ipynb) if still available."
        )
    else:
        logger.info(f"No gaps found in the last {lookback_days} trading days.")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    setup_logging()

    # Parse arguments
    parser = argparse.ArgumentParser(description="Moon ATS daily data pull")
    parser.add_argument("--date", type=str, help="Target date (YYYY-MM-DD). Default: today")
    parser.add_argument("--check-gaps", action="store_true", help="Check for missing recent files")
    args = parser.parse_args()

    logger.info("=" * 50)
    logger.info("Moon ATS Daily Pull")
    logger.info("=" * 50)

    # Gap check mode
    if args.check_gaps:
        check_for_gaps()
        return 0

    # Determine target date
    if args.date:
        try:
            target_date = datetime.datetime.strptime(args.date, "%Y-%m-%d").date()
        except ValueError:
            logger.error(f"Invalid date format: {args.date}. Use YYYY-MM-DD.")
            return 2
    else:
        target_date = datetime.date.today()

    logger.info(f"Target date: {target_date.strftime('%Y-%m-%d')} ({target_date.strftime('%A')})")

    # Check if trading day
    if not is_trading_day(target_date):
        reason = "weekend" if target_date.weekday() >= 5 else "market holiday"
        logger.info(f"Skipping: {target_date} is a {reason}.")
        return 1

    # Check if already pulled
    if file_already_exists(target_date):
        logger.info(f"Skipping: {make_filename(target_date)} already exists.")
        return 1

    # Fetch data
    df = fetch_moon_data()
    if df is None or len(df) == 0:
        logger.error("No data returned from API.")
        return 2

    # Sanity checks
    row_count = len(df)
    if row_count < 100:
        logger.warning(f"Unusually low record count: {row_count}. Saving anyway.")
    if row_count > 5000:
        logger.warning(f"Unusually high record count: {row_count}. Saving anyway.")

    total_dollar_vol = df["$ Volume"].sum()

    # Save
    saved = save_csv(df, target_date)

    logger.info(f"Summary: {row_count:,} records, ${total_dollar_vol:,.0f} total $ volume")
    logger.info(f"Saved to {len(saved)} location(s)")
    logger.info("Completed successfully.")

    return 0



if __name__ == "__main__":
    sys.exit(main())
