"""
cloud_orchestrator.py - GitHub Actions Pipeline Orchestrator
=============================================================
Cloud-adapted version of daily_pull_all.py for running in GitHub Actions.
Pulls data from all 3 ATS venues, processes, encrypts, and stages for deploy.

The GitHub Actions workflow handles the git commit/push of .enc files.

Usage:
    python cloud_orchestrator.py                    # Full pipeline
    python cloud_orchestrator.py --date 2026-03-17  # Specific date
    python cloud_orchestrator.py --skip-pull         # Re-encrypt existing data only

Sapinover LLC | Overnight Trading Research Platform
"""

import os
import sys
import json
import time
import shutil
import argparse
import datetime
import subprocess

import requests

from pull_utils import BASE_DIR, OUTPUT_DIR, is_trading_day, setup_logging, load_env

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

BLUEOCEAN_DIR = os.path.join(BASE_DIR, "BlueOcean")

logger = None


# ---------------------------------------------------------------------------
# Supabase Status Reporting
# ---------------------------------------------------------------------------

def _supabase_headers() -> dict:
    env = load_env()
    key = env.get("SUPABASE_SERVICE_KEY", "")
    return {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }


def _supabase_url() -> str:
    env = load_env()
    return env.get("SUPABASE_URL", "").rstrip("/")


def report_pipeline_status(target_date: datetime.date, status: str, venues: dict,
                           duration_seconds: int = 0, error_message: str = None,
                           encrypted: bool = False, deployed: bool = False):
    """Report pipeline status to Supabase and write local status file."""
    status_data = {
        "run_date": target_date.isoformat(),
        "status": status,
        "venues_pulled": venues,
        "encrypted": encrypted,
        "deployed": deployed,
        "duration_seconds": duration_seconds,
        "runner": "github-actions",
    }
    if error_message:
        status_data["error_message"] = error_message[:500]

    # Write local status file (picked up by the workflow)
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    status_path = os.path.join(OUTPUT_DIR, "pipeline_status.json")
    with open(status_path, "w") as f:
        json.dump(status_data, f, indent=2)
    logger.info(f"Status written to {status_path}")

    # Report to Supabase
    url = _supabase_url()
    if not url:
        return

    try:
        resp = requests.post(
            f"{url}/rest/v1/pipeline_runs",
            headers=_supabase_headers(),
            json=status_data,
            timeout=10,
        )
        if resp.status_code in (200, 201):
            logger.info(f"  Pipeline status reported to Supabase: {status}")
        else:
            logger.warning(f"  Supabase insert returned {resp.status_code}")
    except Exception as e:
        logger.warning(f"  Supabase report failed (non-blocking): {e}")


# ---------------------------------------------------------------------------
# Venue Pullers
# ---------------------------------------------------------------------------

def run_puller(script_name: str, extra_args: list = None) -> tuple:
    """Run a venue puller script as a subprocess.
    Returns (exit_code, stdout_text)."""
    script_path = os.path.join(BASE_DIR, script_name)

    if not os.path.exists(script_path):
        return (2, f"Script not found: {script_path}")

    cmd = [sys.executable, script_path]
    if extra_args:
        cmd.extend(extra_args)

    try:
        result = subprocess.run(
            cmd,
            cwd=BASE_DIR,
            capture_output=True,
            text=True,
            timeout=300,
            env={**os.environ},  # Pass through all env vars (secrets)
        )
        output = result.stdout.strip()
        if result.stderr.strip():
            output += "\n" + result.stderr.strip()
        return (result.returncode, output)
    except subprocess.TimeoutExpired:
        return (2, "Timed out after 300 seconds")
    except Exception as e:
        return (2, f"Subprocess error: {e}")


def status_label(code: int) -> str:
    if code == 0:
        return "SUCCESS"
    elif code == 1:
        return "SKIPPED"
    else:
        return "ERROR"


# ---------------------------------------------------------------------------
# Encryption
# ---------------------------------------------------------------------------

def run_encryption(target_date: datetime.date) -> bool:
    """Run encrypt_data.py and copy .enc files to output directory."""

    # Ensure BlueOcean directory exists for encrypt_data.py
    os.makedirs(BLUEOCEAN_DIR, exist_ok=True)
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    encrypt_script = os.path.join(BLUEOCEAN_DIR, "encrypt_data.py")
    if not os.path.exists(encrypt_script):
        # Try in pipeline root
        encrypt_script = os.path.join(BASE_DIR, "encrypt_data.py")

    if not os.path.exists(encrypt_script):
        logger.error("encrypt_data.py not found")
        return False

    env = load_env()
    password = env.get("ENCRYPT_PASSWORD", "")

    cmd = [sys.executable, encrypt_script]
    if password:
        cmd.extend(["--password", password])

    try:
        result = subprocess.run(
            cmd,
            cwd=os.path.dirname(encrypt_script),
            capture_output=True,
            text=True,
            timeout=120,
            env={**os.environ},
        )
        if result.returncode != 0:
            logger.error(f"encrypt_data.py failed (exit {result.returncode})")
            if result.stderr:
                logger.error(f"  {result.stderr.strip()[:300]}")
            return False

        for line in result.stdout.strip().split("\n"):
            if "Verification:" in line or "ENCRYPTING" in line or "Copied" in line:
                logger.info(f"  {line.strip()}")

    except subprocess.TimeoutExpired:
        logger.error("encrypt_data.py timed out")
        return False

    # Copy .enc files to output directory
    enc_files = ["data.enc", "venue-overview.enc", "metrics-guide.enc"]
    search_dirs = [BLUEOCEAN_DIR, BASE_DIR]
    copied = 0

    for enc_file in enc_files:
        for search_dir in search_dirs:
            src = os.path.join(search_dir, enc_file)
            if os.path.exists(src):
                dst = os.path.join(OUTPUT_DIR, enc_file)
                shutil.copy2(src, dst)
                logger.info(f"  Staged {enc_file} ({os.path.getsize(src):,} bytes)")
                copied += 1
                break

    if copied == 0:
        logger.error("No .enc files found after encryption")
        return False

    logger.info(f"  {copied} .enc file(s) staged for deploy")
    return True


# ---------------------------------------------------------------------------
# Main Pipeline
# ---------------------------------------------------------------------------

def main():
    global logger
    logger = setup_logging("cloud_pipeline", "cloud_pipeline.log")
    pipeline_start = time.time()

    parser = argparse.ArgumentParser(description="Sapinover Cloud Pipeline (GitHub Actions)")
    parser.add_argument("--date", type=str, help="Target date (YYYY-MM-DD). Default: today")
    parser.add_argument("--skip-pull", action="store_true",
                        help="Skip data pull, only re-encrypt and deploy")
    args = parser.parse_args()

    # Also check environment variables (set by GitHub Actions workflow)
    if not args.date and os.environ.get("TARGET_DATE"):
        args.date = os.environ["TARGET_DATE"]
    if not args.skip_pull and os.environ.get("SKIP_PULL", "").lower() == "true":
        args.skip_pull = True

    logger.info("=" * 60)
    logger.info("Sapinover Cloud Pipeline (GitHub Actions)")
    logger.info("=" * 60)

    # Determine target date
    if args.date:
        try:
            target_date = datetime.datetime.strptime(args.date, "%Y-%m-%d").date()
        except ValueError:
            logger.error(f"Invalid date format: {args.date}. Use YYYY-MM-DD.")
            return 2
    else:
        target_date = datetime.date.today()

    logger.info(f"Date: {target_date.strftime('%Y-%m-%d')} ({target_date.strftime('%A')})")
    logger.info(f"Mode: {'encrypt-only' if args.skip_pull else 'full pipeline'}")
    logger.info(f"Runner: GitHub Actions")
    logger.info("")

    # Check if trading day
    if not is_trading_day(target_date):
        reason = "weekend" if target_date.weekday() >= 5 else "market holiday"
        logger.info(f"Skipping: {target_date} is a {reason}.")
        report_pipeline_status(target_date, "skipped", {},
                               error_message=f"Non-trading day ({reason})")
        return 0

    venues_dict = {}
    error_msg = None

    # --------------- DATA PULL ---------------
    if not args.skip_pull:
        venues = [
            ("Moon", "moon_daily_pull.py"),
            ("BOATS", "boats_daily_pull.py"),
            ("Bruce", "bruce_daily_pull.py"),
        ]

        extra_args = []
        if args.date:
            extra_args.extend(["--date", args.date])

        for name, script in venues:
            logger.info(f"  {name}: running {script}...")
            code, output = run_puller(script, extra_args)
            venues_dict[name] = status_label(code).lower()

            if output:
                last_line = output.strip().split("\n")[-1]
                logger.info(f"  {name}: {status_label(code)} - {last_line}")
            else:
                logger.info(f"  {name}: {status_label(code)}")
            logger.info("")

        # Summary
        logger.info("-" * 50)
        for name, status in venues_dict.items():
            logger.info(f"  {name:<10} {status}")
        logger.info("-" * 50)

        any_success = any(v == "success" for v in venues_dict.values())

        # --------------- PROCESSING ---------------
        if any_success:
            # Run append_to_combined_master.py if it exists
            master_script = "append_to_combined_master.py"
            if os.path.exists(os.path.join(BASE_DIR, master_script)):
                logger.info("")
                logger.info(f"Running {master_script}...")
                code, output = run_puller(master_script, ["--skip-today"])
                logger.info(f"  {master_script}: {status_label(code)}")
                if output:
                    for line in output.strip().split("\n")[-8:]:
                        logger.info(f"  {line}")
                if code != 0:
                    error_msg = f"{master_script} failed"
            else:
                logger.warning(f"  {master_script} not found — skipping processing step")
                logger.warning("  Copy from Google Drive: G:\\My Drive\\Colab Notebooks\\Overnight_Session_Data\\")

            # Run generate_venue_overview.py if it exists
            overview_script = "generate_venue_overview.py"
            if os.path.exists(os.path.join(BASE_DIR, overview_script)):
                logger.info("")
                logger.info(f"Running {overview_script}...")
                overview_args = []
                if args.date:
                    overview_args.extend(["--date", args.date])
                code, output = run_puller(overview_script, overview_args)
                logger.info(f"  {overview_script}: {status_label(code)}")
                if output:
                    for line in output.strip().split("\n")[-5:]:
                        logger.info(f"  {line}")

    # --------------- ENCRYPTION ---------------
    logger.info("")
    logger.info("Running encryption...")
    encrypted = run_encryption(target_date)

    if not encrypted:
        error_msg = error_msg or "Encryption failed"

    # --------------- REPORT ---------------
    duration = int(time.time() - pipeline_start)

    if error_msg:
        final_status = "partial" if any(v == "success" for v in venues_dict.values()) else "failed"
    elif not venues_dict:
        final_status = "encrypt-only"
    else:
        final_status = "success"

    report_pipeline_status(
        target_date=target_date,
        status=final_status,
        venues=venues_dict,
        duration_seconds=duration,
        error_message=error_msg,
        encrypted=encrypted,
        deployed=encrypted,  # Deployment is handled by the workflow
    )

    logger.info("")
    logger.info(f"Pipeline complete in {duration}s. Status: {final_status}")

    return 0 if final_status in ("success", "encrypt-only") else 2


if __name__ == "__main__":
    sys.exit(main())
