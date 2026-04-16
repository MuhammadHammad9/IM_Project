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
        self._migrate_schema()

    # =========================================================================
    # Schema creation and migration
    # =========================================================================

    def _migrate_schema(self):
        """Automatically add columns to existing tables if they are missing."""
        with self._lock:
            cursor = self._conn.cursor()
            
            # Check for is_edited in messages
            cursor.execute("PRAGMA table_info(messages)")
            columns = [info[1] for info in cursor.fetchall()]
            
            if 'is_edited' not in columns:
                cursor.execute("ALTER TABLE messages ADD COLUMN is_edited INTEGER DEFAULT 0")
                
            self._conn.commit()

    def _create_tables(self):
        """Create all tables if they do not already exist."""
        with self._lock:
            self._conn.executescript("""
                CREATE TABLE IF NOT EXISTS users (
                    id            INTEGER PRIMARY KEY AUTOINCREMENT,
                    username      TEXT    UNIQUE NOT NULL,
                    password_hash TEXT    NOT NULL,
                    last_seen     TEXT    DEFAULT NULL,
                    joined_at     TEXT    DEFAULT NULL,
                    is_admin      INTEGER DEFAULT 0,
                    bio           TEXT    DEFAULT '',
                    avatar        TEXT    DEFAULT '',
                    public_key    TEXT    DEFAULT NULL,
                    presence      TEXT    DEFAULT 'online',
                    status_text   TEXT    DEFAULT ''
                );

                CREATE TABLE IF NOT EXISTS messages (
                    id          INTEGER PRIMARY KEY AUTOINCREMENT,
                    msg_id      TEXT    UNIQUE NOT NULL,
                    sender      TEXT    NOT NULL,
                    recipient   TEXT    NOT NULL,
                    body        TEXT    NOT NULL,
                    timestamp   TEXT    NOT NULL,
                    status      TEXT    DEFAULT 'sent',
                    is_pinned   INTEGER DEFAULT 0,
                    reply_to    TEXT    DEFAULT NULL,
                    scheduled_at TEXT   DEFAULT NULL,
                    is_edited   INTEGER DEFAULT 0
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

                CREATE TABLE IF NOT EXISTS message_reactions (
                    id         INTEGER PRIMARY KEY AUTOINCREMENT,
                    msg_id     TEXT    NOT NULL,
                    username   TEXT    NOT NULL,
                    emoji      TEXT    NOT NULL,
                    UNIQUE(msg_id, username)
                );

                -- Full-Text Search (FTS5) table for lightning-fast search
                CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
                    msg_id UNINDEXED,
                    body,
                    sender UNINDEXED,
                    recipient UNINDEXED,
                    content='messages',
                    content_rowid='id'
                );

                -- Triggers to keep FTS in sync with messages table
                CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
                  INSERT INTO messages_fts(rowid, msg_id, body, sender, recipient)
                  VALUES (new.id, new.msg_id, new.body, new.sender, new.recipient);
                END;
                CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
                  INSERT INTO messages_fts(messages_fts, rowid, msg_id, body, sender, recipient)
                  VALUES('delete', old.id, old.msg_id, old.body, old.sender, old.recipient);
                END;
                CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
                  INSERT INTO messages_fts(messages_fts, rowid, msg_id, body, sender, recipient)
                  VALUES('delete', old.id, old.msg_id, old.body, old.sender, old.recipient);
                  INSERT INTO messages_fts(rowid, msg_id, body, sender, recipient)
                  VALUES (new.id, new.msg_id, new.body, new.sender, new.recipient);
                END;
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
            joined = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            with self._lock:
                self._conn.execute(
                    "INSERT INTO users (username, password_hash, joined_at) VALUES (?, ?, ?)",
                    (username, password_hash, joined)
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

    def get_joined_at(self, username: str) -> Optional[str]:
        """Return the joined_at timestamp string, or None."""
        with self._lock:
            row = self._conn.execute(
                "SELECT joined_at FROM users WHERE username = ?", (username,)
            ).fetchone()
        return row["joined_at"] if row else None

    # =========================================================================
    # Profile & Admin
    # =========================================================================

    def update_profile(self, username: str, bio: str = None, avatar: str = None, public_key: str = None, **kwargs):
        """Update user profile fields."""
        with self._lock:
            if bio is not None:
                self._conn.execute("UPDATE users SET bio = ? WHERE username = ?", (bio, username))
            if avatar is not None:
                self._conn.execute("UPDATE users SET avatar = ? WHERE username = ?", (avatar, username))
            if public_key is not None:
                self._conn.execute("UPDATE users SET public_key = ? WHERE username = ?", (public_key, username))
            if "presence" in kwargs:
                self._conn.execute("UPDATE users SET presence = ? WHERE username = ?", (kwargs["presence"], username))
            if "status_text" in kwargs:
                self._conn.execute("UPDATE users SET status_text = ? WHERE username = ?", (kwargs["status_text"], username))
            self._conn.commit()

    def get_user_profile(self, username: str) -> Optional[Dict]:
        """Fetch user profile and status."""
        with self._lock:
            row = self._conn.execute(
                "SELECT username, bio, avatar, public_key, is_admin, presence, status_text, last_seen FROM users WHERE username = ?",
                (username,)
            ).fetchone()
        return dict(row) if row else None

    def set_admin(self, username: str, is_admin: bool = True):
        """Promote or demote a user to admin."""
        with self._lock:
            self._conn.execute("UPDATE users SET is_admin = ? WHERE username = ?", (1 if is_admin else 0, username))
            self._conn.commit()

    def delete_user(self, username: str):
        """
        Permanently delete a user account.
        Note: Messages are kept for history (sender/recipient name remains),
        but the auth entry and profile are gone.
        """
        with self._lock:
            self._conn.execute("DELETE FROM users WHERE username = ?", (username,))
            self._conn.commit()

    def get_all_users(self) -> List[Dict]:
        """Fetch a list of all registered users."""
        with self._lock:
            rows = self._conn.execute(
                "SELECT username, bio, avatar, is_admin, presence, status_text, last_seen FROM users ORDER BY id ASC"
            ).fetchall()
        return [dict(r) for r in rows]

    def get_admin_stats(self) -> Dict:
        """Fetch global server statistics."""
        # Measure file size BEFORE acquiring the lock — os.path.getsize() is a
        # blocking syscall and must never execute while holding the DB lock,
        # as it would stall every other thread that needs database access.
        db_size = os.path.getsize(self._path)
        with self._lock:
            total_users = self._conn.execute("SELECT COUNT(*) FROM users").fetchone()[0]
            total_msgs  = self._conn.execute("SELECT COUNT(*) FROM messages").fetchone()[0]
            total_files = self._conn.execute("SELECT COUNT(*) FROM files").fetchone()[0]
            
        # Fetch all users for the dashboard (takes its own lock)
        all_users = self.get_all_users()

        return {
            "total_users": total_users,
            "total_msgs":  total_msgs,
            "total_files": total_files,
            "storage_size": db_size,
            "user_list": all_users
        }

    # =========================================================================
    # Message operations
    # =========================================================================

    def save_message(self, msg_id: str, sender: str, recipient: str,
                     body: str, timestamp: str, reply_to: str = None,
                     scheduled_at: str = None) -> bool:
        """
        Persist a chat message to the database.
        If scheduled_at is set (ISO format string), status is 'scheduled' until the server flushes it.
        Returns True on success.
        """
        try:
            status = 'scheduled' if scheduled_at else 'sent'
            with self._lock:
                self._conn.execute(
                    """INSERT INTO messages
                       (msg_id, sender, recipient, body, timestamp, status, reply_to, scheduled_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                    (msg_id, sender, recipient, body, timestamp, status, reply_to, scheduled_at)
                )
                self._conn.commit()
            return True
        except sqlite3.IntegrityError:
            return False   # duplicate msg_id — already saved

    def get_due_scheduled_messages(self, now: str) -> List[Dict]:
        """Return all scheduled messages whose scheduled_at <= now."""
        with self._lock:
            rows = self._conn.execute(
                """SELECT * FROM messages
                   WHERE status = 'scheduled' AND scheduled_at <= ?
                   ORDER BY scheduled_at ASC""",
                (now,)
            ).fetchall()
        return [dict(r) for r in rows]

    def mark_scheduled_dispatched(self, msg_id: str):
        """Mark a scheduled message as sent after dispatching."""
        with self._lock:
            self._conn.execute(
                "UPDATE messages SET status = 'sent', scheduled_at = NULL WHERE msg_id = ?",
                (msg_id,)
            )
            self._conn.commit()

    def edit_message(self, msg_id: str, sender: str, new_body: str) -> bool:
        """Edit a message body. Returns True if successful (and sender matches)."""
        with self._lock:
            row = self._conn.execute("SELECT sender FROM messages WHERE msg_id = ?", (msg_id,)).fetchone()
            if not row or row['sender'] != sender:
                return False
            
            self._conn.execute(
                "UPDATE messages SET body = ?, is_edited = 1 WHERE msg_id = ?",
                (new_body, msg_id)
            )
            self._conn.commit()
            return True

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

    def toggle_pin(self, msg_id: str):
        """Toggle the pinned state of a message."""
        with self._lock:
            self._conn.execute("UPDATE messages SET is_pinned = 1 - is_pinned WHERE msg_id = ?", (msg_id,))
            self._conn.commit()

    def get_pinned_messages(self, recipient: str) -> List[Dict]:
        """Fetch all pinned messages for a specific chat or group."""
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM messages WHERE recipient = ? AND is_pinned = 1 ORDER BY id DESC",
                (recipient,)
            ).fetchall()
        return [dict(r) for r in rows]

    def get_message(self, msg_id: str) -> Optional[Dict]:
        """Retrieve a single message row by its ID."""
        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM messages WHERE msg_id = ?", (msg_id,)
            ).fetchone()
        return dict(row) if row else None

    def get_conversation(self, user_a: str, user_b: str, limit: int = 50, after_ts: str = None) -> List[Dict]:
        """
        Return the last `limit` messages exchanged between two users,
        oldest first.  If after_ts is given, only return messages at or after that timestamp.
        """
        with self._lock:
            if after_ts:
                rows = self._conn.execute(
                    """SELECT * FROM messages
                       WHERE ((sender = ? AND recipient = ?)
                           OR (sender = ? AND recipient = ?))
                         AND timestamp >= ?
                       ORDER BY id DESC LIMIT ?""",
                    (user_a, user_b, user_b, user_a, after_ts, limit)
                ).fetchall()
            else:
                rows = self._conn.execute(
                    """SELECT * FROM messages
                       WHERE (sender = ? AND recipient = ?)
                          OR (sender = ? AND recipient = ?)
                       ORDER BY id DESC LIMIT ?""",
                    (user_a, user_b, user_b, user_a, limit)
                ).fetchall()
        return [dict(r) for r in reversed(rows)]

    def get_global_conversation(self, limit: int = 50, after_ts: str = None) -> List[Dict]:
        """Return the last `limit` messages sent to the ALL channel (optionally filtered by join date)."""
        with self._lock:
            if after_ts:
                rows = self._conn.execute(
                    """SELECT * FROM messages
                       WHERE recipient = 'ALL' AND timestamp >= ?
                       ORDER BY id DESC LIMIT ?""",
                    (after_ts, limit)
                ).fetchall()
            else:
                rows = self._conn.execute(
                    """SELECT * FROM messages
                       WHERE recipient = 'ALL'
                       ORDER BY id DESC LIMIT ?""",
                    (limit,)
                ).fetchall()
        return [dict(r) for r in reversed(rows)]

    # =========================================================================
    # Reactions
    # =========================================================================

    def add_reaction(self, msg_id: str, username: str, emoji: str):
        """Add or update a reaction to a message."""
        with self._lock:
            self._conn.execute(
                "INSERT OR REPLACE INTO message_reactions (msg_id, username, emoji) VALUES (?, ?, ?)",
                (msg_id, username, emoji)
            )
            self._conn.commit()

    def remove_reaction(self, msg_id: str, username: str):
        """Remove a user's reaction from a message."""
        with self._lock:
            self._conn.execute(
                "DELETE FROM message_reactions WHERE msg_id = ? AND username = ?",
                (msg_id, username)
            )
            self._conn.commit()

    def get_reactions(self, msg_id: str) -> List[Dict]:
        """Fetch all reactions for a given message."""
        with self._lock:
            rows = self._conn.execute(
                "SELECT username, emoji FROM message_reactions WHERE msg_id = ?", (msg_id,)
            ).fetchall()
        return [dict(r) for r in rows]

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
        Full-text search: find messages where the body contains `query`.
        Uses FTS5 for efficient searching, returning a snippet and rank.
        """
        with self._lock:
            # Note: snippet args: table, column, start_match, end_match, ellipsis, limit
            rows = self._conn.execute(
                """SELECT m.msg_id, m.sender, m.recipient, m.body, m.timestamp, m.status, m.is_pinned, m.reply_to,
                          snippet(messages_fts, 1, '**', '**', '...', 10) AS snippet,
                          bm25(messages_fts) AS rank
                   FROM messages_fts
                   JOIN messages m USING (msg_id)
                   WHERE messages_fts MATCH ?
                     AND (m.sender = ? OR m.recipient = ? OR m.recipient = 'ALL')
                   ORDER BY rank
                   LIMIT ?""",
                (query, username, username, limit)
            ).fetchall()
        return [dict(r) for r in rows]

    # =========================================================================
    # Housekeeping
    # =========================================================================

    def close(self):
        """Close the database connection gracefully."""
        with self._lock:
            self._conn.close()
