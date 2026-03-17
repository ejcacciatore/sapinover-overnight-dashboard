"""
encrypt_data.py - Encrypt dashboard data, metrics guide, and venue overview
====================================================================
Cloud-adapted version. Reads password from ENCRYPT_PASSWORD env var
or --password flag. Outputs .enc files to both local dir and output/ dir.

Usage:
    python encrypt_data.py                    # Uses ENCRYPT_PASSWORD env var
    python encrypt_data.py --password MyPass  # Custom password

Sapinover LLC | Overnight Trading Research Platform
"""

import os
import sys
import json
import base64
import shutil
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from cryptography.hazmat.primitives import hashes

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
BLUEOCEAN_DIR = os.path.join(BASE_DIR, "BlueOcean")
OUTPUT_DIR = os.path.join(BASE_DIR, "output")

# PBKDF2 iterations - must match browser-side derivation
PBKDF2_ITERATIONS = 100000


def encrypt_file(input_path: str, output_path: str, password: str):
    """Encrypt a file with AES-256-GCM using a password-derived key."""

    with open(input_path, 'r', encoding='utf-8') as f:
        plaintext = f.read()

    plaintext_bytes = plaintext.encode('utf-8')
    print(f"  Input: {len(plaintext_bytes):,} bytes ({len(plaintext_bytes)/1024/1024:.2f} MB)")

    salt = os.urandom(16)
    iv = os.urandom(12)

    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=32,
        salt=salt,
        iterations=PBKDF2_ITERATIONS,
    )
    key = kdf.derive(password.encode('utf-8'))

    aesgcm = AESGCM(key)
    ciphertext = aesgcm.encrypt(iv, plaintext_bytes, None)

    packed = salt + iv + ciphertext
    encoded = base64.b64encode(packed)

    with open(output_path, 'wb') as f:
        f.write(encoded)

    enc_size = os.path.getsize(output_path)
    print(f"  Output: {enc_size:,} bytes ({enc_size/1024/1024:.2f} MB)")
    print(f"  PBKDF2 iterations: {PBKDF2_ITERATIONS:,}")

    return output_path


def verify_encryption(enc_path: str, password: str):
    """Verify the encrypted file can be decrypted back to valid JSON."""
    with open(enc_path, 'rb') as f:
        encoded = f.read()

    packed = base64.b64decode(encoded)
    salt = packed[:16]
    iv = packed[16:28]
    ciphertext = packed[28:]

    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=32,
        salt=salt,
        iterations=PBKDF2_ITERATIONS,
    )
    key = kdf.derive(password.encode('utf-8'))

    aesgcm = AESGCM(key)
    plaintext = aesgcm.decrypt(iv, ciphertext, None)

    data = json.loads(plaintext.decode('utf-8'))
    print(f"  Verification: OK ({data['meta']['tradingDays']} trading days, {data['meta']['totalObs']:,} observations)")
    return True


def verify_encryption_generic(enc_path: str, password: str):
    """Verify the encrypted file can be decrypted (non-JSON content)."""
    with open(enc_path, 'rb') as f:
        encoded = f.read()

    packed = base64.b64decode(encoded)
    salt = packed[:16]
    iv = packed[16:28]
    ciphertext = packed[28:]

    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=32,
        salt=salt,
        iterations=PBKDF2_ITERATIONS,
    )
    key = kdf.derive(password.encode('utf-8'))

    aesgcm = AESGCM(key)
    plaintext = aesgcm.decrypt(iv, ciphertext, None)
    text = plaintext.decode('utf-8')

    print(f"  Verification: OK ({len(text):,} chars)")
    return True


def copy_to_output(src_path: str, filename: str):
    """Copy encrypted file to output directory for GitHub Actions."""
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    dst = os.path.join(OUTPUT_DIR, filename)
    shutil.copy2(src_path, dst)
    print(f"  Copied to output/{filename}")


# File configurations: (input_name, output_name, search_dirs, verify_func)
FILE_CONFIGS = [
    {
        "label": "DATA.JSON",
        "input": "data.json",
        "output": "data.enc",
        "verify": verify_encryption,
    },
    {
        "label": "METRICS GUIDE",
        "input": "metrics-guide-content.html",
        "output": "metrics-guide.enc",
        "verify": verify_encryption_generic,
    },
    {
        "label": "VENUE OVERVIEW",
        "input": "venue_overview.json",
        "output": "venue-overview.enc",
        "verify": verify_encryption_generic,
    },
]


if __name__ == '__main__':
    # Get password: --password flag > ENCRYPT_PASSWORD env var
    password = os.environ.get("ENCRYPT_PASSWORD", "")

    if '--password' in sys.argv:
        idx = sys.argv.index('--password')
        if idx + 1 < len(sys.argv):
            password = sys.argv[idx + 1]

    if not password:
        print("ERROR: No encryption password. Set ENCRYPT_PASSWORD env var or use --password flag.")
        sys.exit(1)

    # Search directories for input files
    search_dirs = [BLUEOCEAN_DIR, BASE_DIR]

    for cfg in FILE_CONFIGS:
        # Find input file
        input_path = None
        for d in search_dirs:
            candidate = os.path.join(d, cfg["input"])
            if os.path.exists(candidate):
                input_path = candidate
                break

        if not input_path:
            print(f"SKIP: {cfg['input']} not found")
            continue

        print("=" * 50)
        print(f"ENCRYPTING {cfg['label']}")
        print("=" * 50)

        output_path = os.path.join(os.path.dirname(input_path), cfg["output"])

        print(f"\nEncrypting {input_path}...")
        encrypt_file(input_path, output_path, password)

        print(f"\nVerifying decryption...")
        try:
            cfg["verify"](output_path, password)
        except Exception as e:
            print(f"  Verification FAILED: {e}")
            sys.exit(1)

        copy_to_output(output_path, cfg["output"])
        print()

    print("Done.")
