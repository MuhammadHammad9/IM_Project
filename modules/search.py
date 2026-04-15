# =============================================================================
# modules/search.py  —  Message Search
# =============================================================================
#
# The search feature allows a user to query their own message history.
#
# HOW IT WORKS:
#   Client sends:  {"type": "search", "query": "hello"}
#   Server calls:  db.search_messages(query, username)
#   SQLite runs:   SELECT * FROM messages WHERE body LIKE '%hello%'
#                    AND (sender = ? OR recipient = ?)
#   Server returns the matching rows as a list of dicts
#   Client displays them in the chat area with a distinct header
#
# DESIGN DECISIONS:
#   - Only searches messages where the requesting user was involved
#     (sender OR recipient).  Users cannot search other people's chats.
#   - Results are capped at 30 to avoid flooding the client.
#   - SQL LIKE is case-insensitive in SQLite by default for ASCII text.
# =============================================================================

from modules.db import Database


def search(db: Database, query: str, username: str) -> list[dict]:
    """
    Search the database for messages matching `query` visible to `username`.

    Returns a list of message dicts with keys:
        msg_id, sender, recipient, body, timestamp, status

    The caller (server.py) forwards the results to the client.
    """
    query = query.strip()

    if not query:
        return []

    if len(query) < 2:
        # Reject single-character searches — they return too many results
        return []

    results = db.search_messages(query, username, limit=30)
    return results
