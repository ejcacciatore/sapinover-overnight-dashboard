"""
bruce_daily_pull.py - Automated Bruce Markets daily data pull
=============================================================
Downloads Bruce DailyActivity CSV files via SFTP (primary) or Egnyte
REST API (fallback) from Bruce Markets' Egnyte file share.

SFTP: ftp-brucemarkets.egnyte.com:22
Path: /Shared/BruceData/DailyActivity/

Usage:
    python bruce_daily_pull.py                     # Pull today's data
    python bruce_daily_pull.py --date 2026-02-26   # Pull specific date
    python bruce_daily_pull.py --check-gaps         # Report missing files
    python bruce_daily_pull.py --test-sftp          # Test SFTP connection

Exit codes:
    0 = Success (file saved)
    1 = Skipped (weekend, holiday, file exists, or not yet available)
    2 = Error (auth failure, connection error, validation failure)

Prerequisites:
    pip install requests pandas paramiko
    Configure .env with BRUCE_SFTP_HOST, BRUCE_SFTP_USER, BRUCE_SFTP_PASSWORD

Sapinover LLC | Overnight Trading Research Platform
"""

import os
import sys
import io
import time
import argparse
import datetime

import requests
import pandas as pd

from pull_utils import (
    BASE_DIR, is_trading_day, setup_logging,
    dual_save_bytes, load_env
)

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

EGNYTE_FOLDER_PATH = "/Shared/BruceData/DailyActivity"
SFTP_FOLDER_PATH = "/Shared/BruceData/DailyActivity"
MAX_RETRIES = 3

# Expected Bruce CSV columns (13 columns)
EXPECTED_COLUMNS = {
    "RefDate", "Symbol", "AvgSpread", "AvgBidSize", "AvgOfferSize",
    "Trades", "Volume", "Notional", "VWAP", "Open", "High", "Low", "Close"
}

logger = None  # Initialized in main()

# ---------------------------------------------------------------------------
# SFTP (Primary)
# ---------------------------------------------------------------------------

def sftp_connect(env: dict):
    """Create an SFTP connection using paramiko."""
    try:
        import paramiko
    except ImportError:
        logger.error("paramiko not installed. Run: pip install paramiko")
        return None, None

    host = env.get("BRUCE_SFTP_HOST", "ftp-brucemarkets.egnyte.com")
    port = int(env.get("BRUCE_SFTP_PORT", "22"))
    user = env.get("BRUCE_SFTP_USER", "")
    password = env.get("BRUCE_SFTP_PASSWORD", "")

    if not user or not password:
        logger.warning("SFTP credentials not configured (BRUCE_SFTP_USER / BRUCE_SFTP_PASSWORD)")
        return None, None

    try:
        transport = paramiko.Transport((host, port))
        transport.connect(username=user, password=password)
        sftp = paramiko.SFTPClient.from_transport(transport)
        logger.info(f"  SFTP connected to {host}:{port} as {user}")
        return sftp, transport
    except Exception as e:
        logger.warning(f"  SFTP connection failed: {e}")
        return None, None


def sftp_list_files(sftp) -> list[str]:
    """List CSV files in the Bruce DailyActivity folder via SFTP."""
    try:
        files = sftp.listdir(SFTP_FOLDER_PATH)
        csv_files = [f for f in files if f.endswith(".csv")]
        logger.info(f"  SFTP: Found {len(csv_files)} CSV files in {SFTP_FOLDER_PATH}")
        return csv_files
    except Exception as e:
        logger.warning(f"  SFTP folder listing failed: {e}")
        return []


def sftp_download(sftp, filename: str) -> bytes | None:
    """Download a file via SFTP and return its contents as bytes."""
    remote_path = f"{SFTP_FOLDER_PATH}/{filename}"
    try:
        with io.BytesIO() as buf:
            sftp.getfo(remote_path, buf)
            content = buf.getvalue()
            logger.info(f"  SFTP downloaded {filename}: {len(content):,} bytes")
            return content
    except FileNotFoundError:
        logger.info(f"  SFTP: File not found: {remote_path}")
        return None
    except Exception as e:
        logger.warning(f"  SFTP download failed: {e}")
        return None


def sftp_pull(env: dict, target_date: datetime.date) -> bytes | None:
    """Try to pull the Bruce file via SFTP. Returns file bytes or None."""
    logger.info("Attempting SFTP pull...")
    sftp, transport = sftp_connect(env)
    if sftp is None:
        return None

    try:
        target_filename = make_filename(target_date)

        # Try direct download first (faster than listing)
        content = sftp_download(sftp, target_filename)
        if content is not None:
            return content

        # File not found by exact name; list folder to check what's available
        available = sftp_list_files(sftp)
        if available:
            # Sort descending to show most recent
            available.sort(reverse=True)
            logger.info(f"  Most recent files on SFTP:")
            for f in available[:5]:
                logger.info(f"    {f}")
        else:
            logger.info("  No CSV files found in SFTP folder")

        logger.info(f"  {target_filename} not yet available on SFTP.")
        return None
    finally:
        try:
            sftp.close()
            transport.close()
        except Exception:
            pass


def test_sftp_connection(env: dict) -> bool:
    """Test SFTP connectivity and list available files."""
    logger.info("Testing SFTP connection...")
    sftp, transport = sftp_connect(env)
    if sftp is None:
        logger.error("SFTP connection failed. Check credentials in .env:")
        logger.error("  BRUCE_SFTP_HOST=ftp-brucemarkets.egnyte.com")
        logger.error("  BRUCE_SFTP_PORT=22")
        logger.error("  BRUCE_SFTP_USER=calcguard$brucemarkets")
        logger.error("  BRUCE_SFTP_PASSWORD=<your web access password>")
        return False

    try:
        files = sftp_list_files(sftp)
        if files:
            files.sort(reverse=True)
            logger.info(f"Connection successful! {len(files)} files available.")
            logger.info("Most recent files:")
            for f in files[:10]:
                logger.info(f"  {f}")
        else:
            logger.info("Connection successful but no CSV files found.")
        return True
    finally:
        try:
            sftp.close()
            transport.close()
        except Exception:
            pass


# ---------------------------------------------------------------------------
# Egnyte REST API (Fallback)
# ---------------------------------------------------------------------------

def _egnyte_get(url: str, token: str, stream: bool = False):
    """Make a GET request to Egnyte API with retry logic."""
    headers = {"Authorization": f"Bearer {token}"}

    for attempt in range(MAX_RETRIES):
        try:
            resp = requests.get(url, headers=headers, timeout=30, stream=stream)
            if resp.status_code == 401:
                logger.error("Egnyte returned 401 Unauthorized.")
                logger.error("Your access token may have expired. Regenerate at:")
                logger.error("  https://developers.egnyte.com")
                return None
            if resp.status_code == 403:
                logger.error("Egnyte returned 403 Forbidden. Check folder access permissions.")
                return None
            if resp.status_code == 404:
                logger.debug(f"Egnyte 404: {url}")
                return None
            resp.raise_for_status()
            return resp
        except requests.RequestException as e:
            wait = 2 ** (attempt + 1)
            logger.warning(f"  Attempt {attempt + 1}/{MAX_RETRIES} failed: {e}. Retrying in {wait}s...")
            time.sleep(wait)

    logger.error(f"Egnyte request failed after {MAX_RETRIES} attempts: {url}")
    return None


def egnyte_pull(env: dict, target_date: datetime.date) -> bytes | None:
    """Try to pull the Bruce file via Egnyte REST API. Returns file bytes or None."""
    domain = env.get("EGNYTE_DOMAIN", "brucemarkets")
    token = env.get("EGNYTE_ACCESS_TOKEN", "")
    if not token:
        logger.info("Egnyte API fallback skipped: EGNYTE_ACCESS_TOKEN not set.")
        return None

    logger.info("Attempting Egnyte REST API fallback...")
    target_filename = make_filename(target_date)

    # List folder
    url = f"https://{domain}.egnyte.com/pubapi/v1/fs{EGNYTE_FOLDER_PATH}"
    resp = _egnyte_get(url, token)
    if resp is None:
        return None

    data = resp.json()
    files = data.get("files", [])
    logger.info(f"  Found {len(files)} files in Egnyte folder")

    # Find target file
    target_file = None
    for f in files:
        if f.get("name", "") == target_filename:
            target_file = f
            break

    if target_file is None:
        logger.info(f"  {target_filename} not found on Egnyte.")
        return None

    # Download
    file_path = target_file.get("path", f"{EGNYTE_FOLDER_PATH}/{target_filename}")
    download_url = f"https://{domain}.egnyte.com/pubapi/v1/fs-content{file_path}"
    resp = _egnyte_get(download_url, token, stream=True)
    if resp is None:
        return None

    content = resp.content
    logger.info(f"  Egnyte downloaded {len(content):,} bytes")
    return content


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

def validate_bruce_csv(file_bytes: bytes, target_date: datetime.date) -> bool:
    """Validate the downloaded Bruce CSV file."""
    try:
        df = pd.read_csv(io.BytesIO(file_bytes))

        # Check columns
        actual_cols = set(df.columns)
        if not EXPECTED_COLUMNS.issubset(actual_cols):
            missing = EXPECTED_COLUMNS - actual_cols
            logger.error(f"  Validation failed: missing columns {missing}")
            logger.error(f"  Found columns: {list(df.columns)}")
            return False

        # Check RefDate matches target date
        ref_dates = df["RefDate"].unique()
        expected_date_str = target_date.strftime("%Y-%m-%d")
        if expected_date_str not in ref_dates:
            logger.error(f"  Validation failed: RefDate {ref_dates} does not match {expected_date_str}")
            return False

        # Row count check
        row_count = len(df)
        if row_count < 500:
            logger.warning(f"  Low row count: {row_count} (expected ~6,000). Saving anyway.")
        else:
            logger.info(f"  Validation passed: {row_count:,} rows, {len(actual_cols)} columns")

        # File size check
        size_kb = len(file_bytes) / 1024
        if size_kb < 30:
            logger.warning(f"  Unusually small file: {size_kb:.0f} KB")
        elif size_kb > 3000:
            logger.warning(f"  Unusually large file: {size_kb:.0f} KB")

        return True

    except Exception as e:
        logger.error(f"  Validation failed: {e}")
        return False


# ---------------------------------------------------------------------------
# File management
# ---------------------------------------------------------------------------

def make_filename(d: datetime.date) -> str:
    """Generate canonical Bruce filename."""
    return f"{d.strftime('%Y-%m-%d')}_Bruce_DailyActivity.csv"


def file_already_exists(d: datetime.date) -> bool:
    """Check if Bruce file exists in root or month directory."""
    filename = make_filename(d)
    locations = [
        os.path.join(BASE_DIR, filename),
        os.path.join(BASE_DIR, d.strftime("%Y-%m"), filename),
    ]
    return any(os.path.exists(p) for p in locations)


def check_for_gaps(lookback_days: int = 5):
    """Report missing Bruce files for recent trading days."""
    today = datetime.date.today()
    missing = []
    for i in range(1, lookback_days + 1):
        check_date = today - datetime.timedelta(days=i)
        if is_trading_day(check_date) and not file_already_exists(check_date):
            missing.append(check_date)

    if missing:
        logger.warning(f"Missing Bruce data for {len(missing)} trading day(s):")
        for d in sorted(missing):
            logger.warning(f"  {d.strftime('%Y-%m-%d')} ({d.strftime('%A')})")
    else:
        logger.info(f"No gaps found in the last {lookback_days} trading days.")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    global logger
    logger = setup_logging("bruce_pull", "bruce_pull.log")

    parser = argparse.ArgumentParser(description="Bruce Markets daily data pull")
    parser.add_argument("--date", type=str, help="Target date (YYYY-MM-DD). Default: today")
    parser.add_argument("--check-gaps", action="store_true", help="Check for missing recent files")
    parser.add_argument("--test-sftp", action="store_true", help="Test SFTP connection")
    args = parser.parse_args()

    logger.info("=" * 50)
    logger.info("Bruce Markets Daily Pull (SFTP + Egnyte fallback)")
    logger.info("=" * 50)

    # Load credentials
    env = load_env()

    # SFTP test mode
    if args.test_sftp:
        success = test_sftp_connection(env)
        return 0 if success else 2

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

    # Try SFTP first (primary), then Egnyte API (fallback)
    file_bytes = sftp_pull(env, target_date)

    if file_bytes is None:
        file_bytes = egnyte_pull(env, target_date)

    if file_bytes is None:
        logger.info("File not available from either SFTP or Egnyte API.")
        logger.info("Bruce may not have uploaded today's data yet. Will retry on next run.")
        return 1

    # Validate
    if not validate_bruce_csv(file_bytes, target_date):
        logger.error("File validation failed. Not saving.")
        return 2

    # Save to both locations
    filename = make_filename(target_date)
    saved = dual_save_bytes(file_bytes, filename, target_date, logger)

    logger.info(f"Summary: {len(file_bytes):,} bytes, saved to {len(saved)} location(s)")
    logger.info("Completed successfully.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
