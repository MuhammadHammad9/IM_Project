# =============================================================================
# modules/logger.py  —  Centralised Logging
# =============================================================================
#
# Why logs matter:
#   Without logs, when something goes wrong at 3 AM you have no idea what
#   happened.  With logs you get a permanent record of every connection,
#   message, error, and disconnect.
#
# Python's built-in `logging` module writes to both a file AND the console
# simultaneously, so you can watch the server live AND review history later.
# =============================================================================

import logging
import os


def get_logger(name: str = "IM-Server") -> logging.Logger:
    """
    Create and configure a logger that writes to:
      - server.log  (permanent file, appended across restarts)
      - Console / terminal  (live view while the server runs)

    Call this once in server.py and pass the returned logger around.
    """
    logger = logging.getLogger(name)

    # Only configure if no handlers have been added yet (prevent duplicates
    # when the module is imported more than once during testing)
    if logger.handlers:
        return logger

    logger.setLevel(logging.DEBUG)   # capture everything DEBUG and above

    # ── File handler ──────────────────────────────────────────────────────────
    # Writes to server.log in the project root.
    # mode="a" means append — old entries are never lost on restart.
    file_handler = logging.FileHandler("server.log", mode="a", encoding="utf-8")
    file_handler.setLevel(logging.DEBUG)
    file_handler.setFormatter(logging.Formatter(
        fmt="%(asctime)s  [%(levelname)-5s]  %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S"
    ))

    # ── Console handler ────────────────────────────────────────────────────────
    console_handler = logging.StreamHandler()
    console_handler.setLevel(logging.INFO)   # INFO+ on console (less noise)
    console_handler.setFormatter(logging.Formatter(
        fmt="%(asctime)s  %(message)s",
        datefmt="%H:%M:%S"
    ))

    logger.addHandler(file_handler)
    logger.addHandler(console_handler)

    return logger
