# =============================================================================
# modules/auth.py  —  Password Security
# =============================================================================
#
# WHY NOT store plain passwords?
#   If your database file ever gets leaked, all users are immediately
#   compromised.  Hashing makes the stored value useless to attackers.
#
# We use PBKDF2-HMAC-SHA256 — the same algorithm used by Django, WPA2, etc.
# It is built into Python's standard library (no pip install needed).
#
# HOW IT WORKS:
#   1. Generate 16 random bytes (the "salt").  This makes two users with
#      the same password produce completely different hashes.
#   2. Run the password + salt through PBKDF2 for 260,000 iterations.
#      This makes brute-force cracking extremely slow.
#   3. Store:  hex(salt) + ":" + hex(derived_key)
#
# Verification just repeats step 2 with the same salt and compares.
# =============================================================================

import hashlib
import os
import binascii

# ─── Constants ────────────────────────────────────────────────────────────────

_ALGORITHM  = "sha256"
_ITERATIONS = 260_000     # NIST recommended minimum as of 2023
_SALT_BYTES = 16          # 128-bit salt


def hash_password(password: str) -> str:
    """
    Hash a plain-text password and return a storable string.

    Example output:
        "a3f9bc12e5d04108:8bc34f2e1a09d3f6bc012e4..."

    The salt and hash are stored together separated by ":" so we can
    always extract the salt again during verification.
    """
    salt = os.urandom(_SALT_BYTES)
    key  = hashlib.pbkdf2_hmac(_ALGORITHM, password.encode("utf-8"), salt, _ITERATIONS)
    return binascii.hexlify(salt).decode() + ":" + binascii.hexlify(key).decode()


def verify_password(password: str, stored_hash: str) -> bool:
    """
    Return True if `password` matches the previously hashed value.

    We re-derive the key using the same salt that was stored, then compare
    the result to the stored key in constant time (no timing attacks).
    """
    try:
        salt_hex, key_hex = stored_hash.split(":", 1)
        salt = binascii.unhexlify(salt_hex)
        key  = hashlib.pbkdf2_hmac(_ALGORITHM, password.encode("utf-8"), salt, _ITERATIONS)
        # hmac.compare_digest prevents timing-based attacks
        import hmac
        return hmac.compare_digest(binascii.hexlify(key).decode(), key_hex)
    except Exception:
        return False
