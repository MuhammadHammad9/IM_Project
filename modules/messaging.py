# =============================================================================
# modules/messaging.py  —  Packet Helpers & Message ID Generator
# =============================================================================
#
# Every packet sent over the wire in this system is a JSON object.
# This module provides helper functions that build those objects
# consistently so no part of the code hand-crafts dicts by hand.
#
# PACKET TYPES (used as the "type" field):
#
#   chat           — user-to-user text message
#   system         — server-generated status notification
#   status         — delivery/seen update for a specific message
#   typing         — "X is typing..." notification
#   userlist       — updated list of who is online
#   file           — binary file transfer (base64-encoded data)
#   search_results — response to a search query
#   login_ok       — successful authentication confirmation
#   login_error    — failed authentication
# =============================================================================

import uuid
import datetime


# ─── ID generation ────────────────────────────────────────────────────────────

def new_msg_id() -> str:
    """
    Generate a unique message ID.
    Format: "msg_" + first 12 hex chars of a UUID4.
    Example: "msg_3f9bc12e5d04"

    UUIDs are random 128-bit numbers — the chance of two being identical
    is astronomically small (1 in 2^122).
    """
    return "msg_" + uuid.uuid4().hex[:12]


# ─── Timestamp helpers ────────────────────────────────────────────────────────

def now_timestamp() -> str:
    """Full timestamp for database storage: 'YYYY-MM-DD HH:MM:SS'"""
    return datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def now_display() -> str:
    """Short time for GUI display: 'HH:MM'"""
    return datetime.datetime.now().strftime("%H:%M")


# ─── Packet builders ──────────────────────────────────────────────────────────

def build_chat_packet(sender: str, recipient: str, body: str,
                      msg_id: str = None) -> dict:
    """
    Build a complete chat message packet.
    The server stamps the time (not the client) so all timestamps use
    a single consistent clock regardless of the client's timezone.
    """
    return {
        "type":      "chat",
        "msg_id":    msg_id or new_msg_id(),
        "sender":    sender,
        "recipient": recipient,
        "body":      body,
        "time":      now_display(),
        "timestamp": now_timestamp(),
        "status":    "sent"
    }


def build_system_packet(body: str) -> dict:
    """Build a grey-italic server notification packet (join, leave, etc.)."""
    return {
        "type": "system",
        "body": body,
        "time": now_display()
    }


def build_status_packet(msg_id: str, status: str) -> dict:
    """
    Build a delivery-status update packet.
    Sent from server → original sender to update the tick marks.
    status values:  'delivered'  or  'seen'
    """
    return {
        "type":   "status",
        "msg_id": msg_id,
        "status": status,
        "time":   now_display()
    }


def build_typing_packet(sender: str, recipient: str) -> dict:
    """
    Notify a recipient that `sender` is currently typing.
    The client shows "X is typing…" and hides it after 3 seconds.
    """
    return {
        "type":      "typing",
        "sender":    sender,
        "recipient": recipient
    }


def build_userlist_packet(users: list) -> dict:
    """
    Send the full list of currently-online users to all clients.
    Clients use this to refresh their recipient dropdown.
    """
    return {
        "type":  "userlist",
        "users": sorted(users)
    }


def build_file_packet(sender: str, recipient: str, filename: str,
                      data_b64: str, msg_id: str = None) -> dict:
    """
    Build a file-transfer packet.
    `data_b64` is the file's raw bytes encoded as a base64 string.
    """
    return {
        "type":      "file",
        "msg_id":    msg_id or new_msg_id(),
        "sender":    sender,
        "recipient": recipient,
        "filename":  filename,
        "data":      data_b64,
        "time":      now_display(),
        "timestamp": now_timestamp()
    }


def build_search_results_packet(query: str, results: list) -> dict:
    """Package search results to send back to the requesting client."""
    return {
        "type":    "search_results",
        "query":   query,
        "results": results
    }


def build_login_ok_packet(username: str) -> dict:
    return {
        "type": "login_ok",
        "body": f"Welcome back, {username}!  You are now connected.",
        "time": now_display()
    }


def build_login_error_packet(reason: str) -> dict:
    return {
        "type": "login_error",
        "body": reason
    }


def build_signup_ok_packet(username: str) -> dict:
    return {
        "type": "login_ok",
        "body": f"Account created!  Welcome, {username}.",
        "time": now_display()
    }


def build_history_packet(contact: str, messages: list) -> dict:
    """Send back a batch of past messages to populate the UI on load."""
    return {
        "type": "history",
        "contact": contact,
        "messages": messages
    }
