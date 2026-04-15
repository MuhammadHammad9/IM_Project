# =============================================================================
# modules/db.py  —  Database Manager (SQLite)
# =============================================================================
#
# WHY a database?
#   Without one, all messages disappear the moment the server restarts.
#   With SQLite, every message, user account, and file record persists
#   across server restarts forever — just like WhatsApp or Signal.
#
# SQLite is built into Python — zero installation required.
# The entire database lives in a single file: database.db
#
# TABLE DESIGN:
#
#   users    — user accounts (username, password hash, last seen)
#   messages — every chat message ever sent (with delivery status)
#   files    — metadata for every file that was transferred
#
# THREAD SAFETY:
#   Multiple server threads read/write the DB simultaneously.
#   We use a threading.Lock() to serialise ALL DB operations — only one
#   thread can query the database at a time.  This prevents corruption.
# =============================================================================

import sqlite3
import threading
import datetime
import os
from typing import Optional, List, Dict


class Database:

    def __init__(self, db_path: str = "database.db"):
        self._path = db_path
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(db_path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row    # rows behave like dicts
        self._conn.execute("PRAGMA journal_mode=WAL")  # better concurrency
        self._create_tables()

    # =========================================================================
    # Schema creation
    # =========================================================================

    def _create_tables(self):
        """Create all tables if they do not already exist."""
        with self._lock:
            self._conn.executescript("""
                CREATE TABLE IF NOT EXISTS users (
                    id            INTEGER PRIMARY KEY AUTOINCREMENT,
                    username      TEXT    UNIQUE NOT NULL,
                    password_hash TEXT    NOT NULL,
                    last_seen     TEXT    DEFAULT NULL
                );

                CREATE TABLE IF NOT EXISTS messages (
                    id         INTEGER PRIMARY KEY AUTOINCREMENT,
                    msg_id     TEXT    UNIQUE NOT NULL,
                    sender     TEXT    NOT NULL,
                    recipient  TEXT    NOT NULL,
                    body       TEXT    NOT NULL,
                    timestamp  TEXT    NOT NULL,
                    status     TEXT    DEFAULT 'sent'
                );

                CREATE TABLE IF NOT EXISTS files (
                    id         INTEGER PRIMARY KEY AUTOINCREMENT,
                    msg_id     TEXT    UNIQUE NOT NULL,
                    sender     TEXT    NOT NULL,
                    recipient  TEXT    NOT NULL,
                    filename   TEXT    NOT NULL,
                    file_path  TEXT    NOT NULL,
                    timestamp  TEXT    NOT NULL
                );
            """)
            self._conn.commit()

    # =========================================================================
    # User operations
    # =========================================================================

    def user_exists(self, username: str) -> bool:
        """Check whether a username is already registered."""
        with self._lock:
            row = self._conn.execute(
                "SELECT 1 FROM users WHERE username = ?", (username,)
            ).fetchone()
        return row is not None

    def create_user(self, username: str, password_hash: str) -> bool:
        """
        Insert a new user row.
        Returns True on success, False if the username was already taken.
        """
        try:
            with self._lock:
                self._conn.execute(
                    "INSERT INTO users (username, password_hash) VALUES (?, ?)",
                    (username, password_hash)
                )
                self._conn.commit()
            return True
        except sqlite3.IntegrityError:
            return False   # UNIQUE constraint failed — username taken

    def get_password_hash(self, username: str) -> Optional[str]:
        """Return the stored password hash for a user, or None if not found."""
        with self._lock:
            row = self._conn.execute(
                "SELECT password_hash FROM users WHERE username = ?", (username,)
            ).fetchone()
        return row["password_hash"] if row else None

    def update_last_seen(self, username: str):
        """Set the user's last_seen timestamp to right now."""
        now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        with self._lock:
            self._conn.execute(
                "UPDATE users SET last_seen = ? WHERE username = ?",
                (now, username)
            )
            self._conn.commit()

    def get_last_seen(self, username: str) -> Optional[str]:
        """Return the last_seen timestamp string, or None."""
        with self._lock:
            row = self._conn.execute(
                "SELECT last_seen FROM users WHERE username = ?", (username,)
            ).fetchone()
        return row["last_seen"] if row else None

    # =========================================================================
    # Message operations
    # =========================================================================

    def save_message(self, msg_id: str, sender: str, recipient: str,
                     body: str, timestamp: str) -> bool:
        """
        Persist a chat message to the database.
        Always call this BEFORE forwarding to the recipient — if the send
        fails, the message is still stored and can be retrieved later.
        Returns True on success.
        """
        try:
            with self._lock:
                self._conn.execute(
                    """INSERT INTO messages
                       (msg_id, sender, recipient, body, timestamp, status)
                       VALUES (?, ?, ?, ?, ?, 'sent')""",
                    (msg_id, sender, recipient, body, timestamp)
                )
                self._conn.commit()
            return True
        except sqlite3.IntegrityError:
            return False   # duplicate msg_id — already saved

    def update_message_status(self, msg_id: str, status: str):
        """
        Update a message's delivery status.
        Valid statuses: 'sent'  →  'delivered'  →  'seen'
        """
        with self._lock:
            self._conn.execute(
                "UPDATE messages SET status = ? WHERE msg_id = ?",
                (status, msg_id)
            )
            self._conn.commit()

    def get_message(self, msg_id: str) -> Optional[Dict]:
        """Retrieve a single message row by its ID."""
        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM messages WHERE msg_id = ?", (msg_id,)
            ).fetchone()
        return dict(row) if row else None

    def get_conversation(self, user_a: str, user_b: str, limit: int = 50) -> List[Dict]:
        """
        Return the last `limit` messages exchanged between two users,
        oldest first.  Used to load chat history when a user connects.
        """
        with self._lock:
            rows = self._conn.execute(
                """SELECT * FROM messages
                   WHERE (sender = ? AND recipient = ?)
                      OR (sender = ? AND recipient = ?)
                   ORDER BY id DESC LIMIT ?""",
                (user_a, user_b, user_b, user_a, limit)
            ).fetchall()
        return [dict(r) for r in reversed(rows)]

    def get_global_conversation(self, limit: int = 50) -> List[Dict]:
        """Return the last `limit` messages sent to the ALL channel."""
        with self._lock:
            rows = self._conn.execute(
                """SELECT * FROM messages
                   WHERE recipient = 'ALL'
                   ORDER BY id DESC LIMIT ?""",
                (limit,)
            ).fetchall()
        return [dict(r) for r in reversed(rows)]

    # =========================================================================
    # File operations
    # =========================================================================

    def save_file_record(self, msg_id: str, sender: str, recipient: str,
                         filename: str, file_path: str, timestamp: str):
        """Record that a file was transferred (stores metadata only, not bytes)."""
        with self._lock:
            self._conn.execute(
                """INSERT OR IGNORE INTO files
                   (msg_id, sender, recipient, filename, file_path, timestamp)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                (msg_id, sender, recipient, filename, file_path, timestamp)
            )
            self._conn.commit()

    # =========================================================================
    # Search
    # =========================================================================

    def search_messages(self, query: str, username: str, limit: int = 30) -> List[Dict]:
        """
        Full-text search: find messages where the body contains `query`
        AND the requesting user was either the sender or recipient.
        Returns up to `limit` results, newest first.
        """
        pattern = f"%{query}%"
        with self._lock:
            rows = self._conn.execute(
                """SELECT * FROM messages
                   WHERE body LIKE ?
                     AND (sender = ? OR recipient = ?)
                   ORDER BY id DESC LIMIT ?""",
                (pattern, username, username, limit)
            ).fetchall()
        return [dict(r) for r in rows]

    # =========================================================================
    # Housekeeping
    # =========================================================================

    def close(self):
        """Close the database connection gracefully."""
        with self._lock:
            self._conn.close()
