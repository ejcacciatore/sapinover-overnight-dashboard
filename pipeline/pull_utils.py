"""
pull_utils.py - Shared utilities for daily ATS data pullers
============================================================
Cloud-adapted version for GitHub Actions.
Loads secrets from environment variables instead of .env file.

Sapinover LLC | Overnight Trading Research Platform
"""

import os
import sys
import logging
import datetime
from logging.handlers import RotatingFileHandler

# ---------------------------------------------------------------------------
# Paths — auto-detect from script location (works in GH Actions and local)
# ---------------------------------------------------------------------------

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
LOG_DIR = os.path.join(BASE_DIR, "logs")
OUTPUT_DIR = os.path.join(BASE_DIR, "output")

# ---------------------------------------------------------------------------
# US Market Holidays 2026-2027 (update annually)
# ---------------------------------------------------------------------------

US_MARKET_HOLIDAYS = {
    # 2026
    datetime.date(2026, 1, 1),    # New Year's Day
    datetime.date(2026, 1, 19),   # MLK Jr. Day
    datetime.date(2026, 2, 16),   # Presidents' Day
    datetime.date(2026, 4, 3),    # Good Friday
    datetime.date(2026, 5, 25),   # Memorial Day
    datetime.date(2026, 6, 19),   # Juneteenth
    datetime.date(2026, 7, 3),    # Independence Day (observed)
    datetime.date(2026, 9, 7),    # Labor Day
    datetime.date(2026, 11, 26),  # Thanksgiving
    datetime.date(2026, 12, 25),  # Christmas
    # 2027
    datetime.date(2027, 1, 1),    # New Year's Day
    datetime.date(2027, 1, 18),   # MLK Jr. Day
    datetime.date(2027, 2, 15),   # Presidents' Day
    datetime.date(2027, 3, 26),   # Good Friday
    datetime.date(2027, 5, 31),   # Memorial Day
    datetime.date(2027, 6, 18),   # Juneteenth (observed)
    datetime.date(2027, 7, 5),    # Independence Day (observed)
    datetime.date(2027, 9, 6),    # Labor Day
    datetime.date(2027, 11, 25),  # Thanksgiving
    datetime.date(2027, 12, 24),  # Christmas (observed)
}

# ---------------------------------------------------------------------------
# Functions
# ---------------------------------------------------------------------------

def is_trading_day(d: datetime.date) -> bool:
    """Check if a date is a US equity trading day (not weekend or holiday)."""
    if d.weekday() >= 5:
        return False
    return d not in US_MARKET_HOLIDAYS


def setup_logging(logger_name: str, log_filename: str) -> logging.Logger:
    """Configure rotating file + console logging. Returns the logger."""
    os.makedirs(LOG_DIR, exist_ok=True)
    log_path = os.path.join(LOG_DIR, log_filename)

    lgr = logging.getLogger(logger_name)
    lgr.setLevel(logging.DEBUG)

    # Avoid duplicate handlers on re-import
    if lgr.handlers:
        return lgr

    # Rotating file handler (5 MB, 3 backups)
    fh = RotatingFileHandler(log_path, maxBytes=5 * 1024 * 1024, backupCount=3)
    fh.setLevel(logging.DEBUG)
    fh.setFormatter(logging.Formatter(
        "%(asctime)s | %(levelname)-5s | %(message)s", datefmt="%Y-%m-%d %H:%M:%S"
    ))

    # Console handler
    ch = logging.StreamHandler(sys.stdout)
    ch.setLevel(logging.INFO)
    ch.setFormatter(logging.Formatter("%(message)s"))

    lgr.addHandler(fh)
    lgr.addHandler(ch)
    return lgr


def get_month_dir(d: datetime.date) -> str:
    """Return path to YYYY-MM/ month directory, creating if needed."""
    month_dir = os.path.join(BASE_DIR, d.strftime("%Y-%m"))
    os.makedirs(month_dir, exist_ok=True)
    return month_dir


def dual_save_bytes(content: bytes, filename: str, target_date: datetime.date,
                    logger: logging.Logger) -> list:
    """Save raw bytes to root dir + month dir. Returns list of saved paths."""
    saved = []

    # Root directory
    root_path = os.path.join(BASE_DIR, filename)
    with open(root_path, "wb") as f:
        f.write(content)
    saved.append(root_path)
    logger.info(f"  Saved to: {filename}")

    # Month directory
    month_dir = get_month_dir(target_date)
    month_path = os.path.join(month_dir, filename)
    with open(month_path, "wb") as f:
        f.write(content)
    saved.append(month_path)
    logger.info(f"  Saved to: {target_date.strftime('%Y-%m')}/{filename}")

    return saved


def load_env() -> dict:
    """Load configuration from environment variables (GitHub Secrets)
    or fall back to .env file if present."""
    env = {}

    # First try environment variables (GitHub Actions)
    env_keys = [
        "GMAIL_ADDRESS", "GMAIL_APP_PASSWORD",
        "BRUCE_SFTP_HOST", "BRUCE_SFTP_PORT", "BRUCE_SFTP_USER", "BRUCE_SFTP_PASSWORD",
        "EGNYTE_DOMAIN", "EGNYTE_ACCESS_TOKEN",
        "GRAPH_TENANT_ID", "GRAPH_CLIENT_ID", "GRAPH_CLIENT_SECRET", "GRAPH_USER_EMAIL",
        "SUPABASE_URL", "SUPABASE_SERVICE_KEY",
        "ENCRYPT_PASSWORD",
    ]
    for key in env_keys:
        val = os.environ.get(key)
        if val:
            env[key] = val

    # Fall back to .env file if env vars are sparse
    if len(env) < 3:
        env_path = os.path.join(BASE_DIR, ".env")
        if os.path.exists(env_path):
            with open(env_path, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line or line.startswith("#"):
                        continue
                    if "=" not in line:
                        continue
                    key, _, value = line.partition("=")
                    key = key.strip()
                    value = value.strip()
                    if len(value) >= 2 and value[0] == value[-1] and value[0] in ('"', "'"):
                        value = value[1:-1]
                    env[key] = value

    return env


def parse_date_arg(args_date: str | None) -> datetime.date:
    """Parse --date argument or return today."""
    if args_date:
        return datetime.datetime.strptime(args_date, "%Y-%m-%d").date()
    return datetime.date.today()
