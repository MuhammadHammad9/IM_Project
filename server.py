# =============================================================================
# server.py  —  Instant Messaging Server  (Full Version)
# =============================================================================
# Run this first:   python server.py
#
# IMPORTANT — folder structure required:
#   IM_Project/
#   ├── server.py        ← this file
#   ├── client.py
#   └── modules/
#       ├── auth.py
#       ├── db.py
#       ├── file_handler.py
#       ├── logger.py
#       ├── messaging.py
#       └── search.py
# =============================================================================

# Make sure Python can find the modules/ folder even if you run this
# script from a different working directory (e.g. python C:\Users\...\server.py)
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
#
# What changed from the basic version:
#   ✓  Real authentication  (signup + login with hashed passwords)
#   ✓  SQLite persistence   (all messages stored in database.db)
#   ✓  Message IDs          (every message has a unique ID)
#   ✓  Delivered / Seen     (tick-mark status updates)
#   ✓  Typing indicators    (forwarded to recipient in real time)
#   ✓  File sharing         (base64-encoded files saved to uploads/)
#   ✓  Message search       (full-text search over own message history)
#   ✓  Last-seen tracking   (updated on every disconnect)
#   ✓  Structured logging   (to server.log + console)
#   ✓  Input validation     (reject oversized messages, bad usernames)
#
# PACKET TYPES this server handles:
#   login    — username + password (or signup flag)
#   chat     — text message (unicast or broadcast)
#   file     — binary file encoded as base64
#   search   — full-text message search request
#   typing   — "user is typing" notification
#   status   — 'delivered' / 'seen' acknowledgement
# =============================================================================

import socket
import threading
import json
import re
import base64
import urllib.parse

from modules.logger      import get_logger
from modules.db          import Database
from modules.auth        import hash_password, verify_password
from modules.messaging   import (
    new_msg_id, now_timestamp, now_display,
    build_chat_packet, build_system_packet, build_status_packet,
    build_typing_packet, build_userlist_packet, build_file_packet,
    build_search_results_packet, build_history_packet,
    build_login_ok_packet, build_login_error_packet, build_signup_ok_packet,
    build_reaction_packet, build_profile_packet, build_admin_stats_packet,
    build_pin_packet, build_voice_packet, build_webrtc_packet,
    build_key_exchange_packet
)
from modules.file_handler import save_file_from_b64, MAX_FILE_BYTES
from modules.search       import search as do_search
import time
import urllib.request
import urllib.error
from html.parser import HTMLParser

# Compiled regex for username validation (letters, digits, underscore, hyphen)
_USERNAME_RE = re.compile(r'^[A-Za-z0-9_-]+$')

# ── In-memory link preview cache ──────────────────────────────────────────────
_preview_cache: dict = {}  # url -> {title, description, image}
_preview_cache_lock = threading.Lock()


class _OGParser(HTMLParser):
    """Minimal Open Graph meta tag scraper."""
    def __init__(self):
        super().__init__()
        self.og = {}

    def handle_starttag(self, tag, attrs):
        if tag == "meta":
            a = dict(attrs)
            prop = a.get("property", a.get("name", ""))
            content = a.get("content", "")
            if prop in ("og:title", "og:description", "og:image", "twitter:title", "twitter:description", "twitter:image"):
                key = prop.split(":", 1)[1]  # "title", "description", "image"
                if key not in self.og:
                    self.og[key] = content


DISALLOWED_IP_PREFIXES = [
    '127.',        # loopback (covers 127.0.0.1 – 127.255.255.255)
    '0.',          # 0.0.0.0/8 reserved
    '10.',         # RFC 1918 private
    '172.16.', '172.17.', '172.18.', '172.19.', '172.20.',
    '172.21.', '172.22.', '172.23.', '172.24.', '172.25.', '172.26.',
    '172.27.', '172.28.', '172.29.', '172.30.', '172.31.',
    '192.168.',    # RFC 1918 private
    '169.254.',    # link-local
    '100.64.',     # Shared Address Space (RFC 6598)
]
DISALLOWED_HOSTNAMES = {'localhost', 'localhost.'}

# IPv6 prefixes to block (lowercase, colon-terminated for precise matching).
# fc00::/7  → ULA (unique local addresses, private IPv6 equivalent)
# fe80::/10 → link-local
# ::1       → loopback
DISALLOWED_IPV6_PREFIXES = ('::1', 'fc00:', 'fd00:', 'fe80:')

# Maximum number of URLs to keep in the in-memory preview cache
_PREVIEW_CACHE_MAX = 500

def _is_internal_ip(ip: str) -> bool:
    """Return True if `ip` is an internal / reserved address."""
    ip_lower = ip.lower().strip('[]')
    # IPv6 loopback and ULA/link-local
    for prefix in DISALLOWED_IPV6_PREFIXES:
        if ip_lower.startswith(prefix):
            return True
    # IPv4 reserved ranges
    for prefix in DISALLOWED_IP_PREFIXES:
        if ip.startswith(prefix):
            return True
    return False


def _check_url_hostname(hostname: str) -> str | None:
    """
    Validate that `hostname` does not point to an internal address.
    Returns an error string if blocked, or None if allowed.
    """
    hostname = hostname.lower()
    if hostname in DISALLOWED_HOSTNAMES:
        return "URL points to internal network"
    if _is_internal_ip(hostname):
        return "URL points to internal network"
    try:
        addr_infos = socket.getaddrinfo(hostname, None)
    except socket.gaierror:
        return "Could not resolve hostname"
    for info in addr_infos:
        if _is_internal_ip(info[4][0]):
            return "URL resolves to internal network"
    return None


def _fetch_link_preview(url: str) -> dict:
    """Fetch OG metadata with security checks against SSRF and DoS."""
    with _preview_cache_lock:
        if url in _preview_cache:
            return _preview_cache[url]

    try:
        parsed = urllib.parse.urlparse(url)
        if parsed.scheme not in ('http', 'https'):
            return {"url": url, "error": "Invalid URL scheme"}

        if len(url) > 2048:
            return {"url": url, "error": "URL too long"}

        hostname = parsed.hostname or ""
        if not hostname:
            return {"url": url, "error": "Missing hostname"}

        # Block based on literal hostname/IP string and DNS resolution
        err = _check_url_hostname(hostname)
        if err:
            return {"url": url, "error": err}

        # NOTE: timeout= belongs on urlopen(), NOT on Request()
        req = urllib.request.Request(
            url,
            headers={"User-Agent": "Mozilla/5.0 (StitchIM LinkPreview/1.0)"},
        )

        with urllib.request.urlopen(req, timeout=5) as resp:
            # Enforce max response size (~1 MB) to avoid DoS
            raw = b""
            chunk_size = 8192
            for _ in range(128):
                chunk = resp.read(chunk_size)
                if not chunk:
                    break
                raw += chunk

            html = raw.decode("utf-8", errors="replace")

        parser = _OGParser()
        parser.feed(html[:50000])  # Only parse first 50 KB to protect parser
        result = {"url": url, **parser.og}
        with _preview_cache_lock:
            # Evict the first-inserted (FIFO) entry when the cache is full
            # to keep memory usage bounded at _PREVIEW_CACHE_MAX entries.
            if len(_preview_cache) >= _PREVIEW_CACHE_MAX:
                _preview_cache.pop(next(iter(_preview_cache)))
            _preview_cache[url] = result
        return result
    except Exception as e:
        log.warning(f"Link preview fetch failed for {url}: {e}")
        return {"url": url}

# ─── Configuration ────────────────────────────────────────────────────────────

HOST             = "0.0.0.0"
PORT             = 5555
MAX_MSG_CHARS    = 2000    # reject messages longer than this
MAX_USERNAME_LEN = 20

# ─── Global state ─────────────────────────────────────────────────────────────

log = get_logger("IM-Server")
db  = Database("database.db")

# Online users dictionary:  { "Alice": <socket>, "Bob": <socket>, ... }
# Protected by clients_lock — any thread that reads or writes this dict
# must hold the lock to prevent race conditions.
clients: dict       = {}
clients_lock        = threading.Lock()


# =============================================================================
# Socket I/O helpers
# =============================================================================

AUTH_TIMEOUT_SECS = 30   # seconds to wait for a login/signup packet before closing the connection

def receive_line(conn: socket.socket) -> str:
    """
    Thin wrapper kept for auth phase — in handle_client we use makefile()
    for proper buffering. This reads until newline, one byte at a time.
    Only used for the first (auth) packet.

    The socket MUST have a timeout set before calling this to avoid
    blocking the auth thread forever on idle proxy connections.
    """
    data = b""
    while True:
        try:
            byte = conn.recv(1)
        except OSError:
            return ""
        if not byte or byte == b"\n":
            break
        data += byte
    return data.decode("utf-8", errors="replace")


def send_packet(conn: socket.socket, data: dict) -> bool:
    """
    Serialise dict → JSON → bytes, append newline, and send.
    Returns False if the socket is broken (client already gone).
    """
    try:
        raw = json.dumps(data, ensure_ascii=False) + "\n"
        conn.sendall(raw.encode("utf-8"))
        return True
    except OSError:
        return False


# =============================================================================
# Routing helpers
# =============================================================================

def send_to_user(username: str, packet: dict) -> bool:
    """Deliver a packet to one specific online user. Returns False if offline."""
    with clients_lock:
        sock = clients.get(username)
    if sock is None:
        return False
    return send_packet(sock, packet)


def broadcast_to_all(packet: dict, exclude: str = None):
    """
    Deliver a packet to ALL online users.
    Take a snapshot of the dict first so we don't hold the lock while
    doing (potentially slow) network sends.
    """
    with clients_lock:
        snapshot = list(clients.items())
    for name, sock in snapshot:
        if name == exclude:
            continue
        try:
            send_packet(sock, packet)
        except OSError:
            pass


def broadcast_system(body: str):
    """Send a server-generated status notification to everyone."""
    broadcast_to_all(build_system_packet(body))


def push_user_list():
    """
    Broadcast the current online-user list with profile info to all clients.
    """
    with clients_lock:
        online_names = list(clients.keys())
    
    user_profiles = []
    for name in online_names:
        prof = db.get_user_profile(name)
        if prof:
            user_profiles.append(prof)
        else:
            user_profiles.append({"username": name, "avatar": "", "bio": "", "is_admin": 0})
            
    broadcast_to_all(build_userlist_packet(user_profiles))


# =============================================================================
# Packet handlers  (one function per packet type)
# =============================================================================

def handle_chat(data: dict, username: str):
    """
    Route a text message.

    Steps:
      1. Validate length
      2. Stamp server time and assign msg_id
      3. Save to database  ← do this BEFORE sending, so it's never lost
      4. Route to recipient(s)
      5. Send 'delivered' status back to sender
    """
    body      = data.get("body", "").strip()
    recipient = data.get("recipient", "ALL")
    reply_to  = data.get("reply_to")  # optional: msg_id being replied to

    # ── Validation ────────────────────────────────────────────────────────────
    if not db.get_user_profile(username):
        log.warning(f"Ghost session detected for deleted user {username}. Terminating.")
        with clients_lock:
            sock = clients.pop(username, None)
        if sock:
            try:
                sock.close()
            except Exception:
                pass
        return

    if not body or len(body.strip()) == 0:
        send_to_user(username, build_system_packet("Message cannot be empty"))
        return
    if len(body) > MAX_MSG_CHARS:
        send_to_user(username, build_system_packet(f"Message too long. Max {MAX_MSG_CHARS} characters."))
        return
    if '\x00' in body:
        send_to_user(username, build_system_packet("Message contains invalid characters"))
        return
    body = body.strip()

    # ── Build the canonical packet (server stamps the time and ID) ────────────
    msg_id = new_msg_id()
    packet = build_chat_packet(
        sender    = username,
        recipient = recipient,
        body      = body,
        msg_id    = msg_id
    )
    if reply_to:
        packet["reply_to"] = reply_to

    # ── Persist to database ───────────────────────────────────────────────────
    db.save_message(msg_id, username, recipient, body, now_timestamp(), reply_to=reply_to)
    log.info(f"MSG  {username} → {recipient}: {body[:60]}")

    # ── Route ─────────────────────────────────────────────────────────────────
    if recipient == "ALL":
        broadcast_to_all(packet)           # send to everyone (including sender)

    else:
        delivered = send_to_user(recipient, packet)
        send_to_user(username, packet)     # echo back to sender too

        if delivered:
            # Tell sender the message reached the server and recipient
            db.update_message_status(msg_id, "delivered")
            send_to_user(username, build_status_packet(msg_id, "delivered"))
        else:
            send_to_user(username, build_system_packet(
                f"'{recipient}' is not online right now.  Your message was saved."))


def handle_link_preview(data: dict, username: str):
    """
    Fetch Open Graph metadata for a URL and return it only to the requesting client.
    """
    url = data.get("url", "").strip()
    if not url:
        return
    preview = _fetch_link_preview(url)
    conn = None
    with clients_lock:
        conn = clients.get(username)
    if conn:
        send_packet(conn, {"type": "link_preview_result", **preview})


def handle_edit(data: dict, username: str):
    """
    Route a message edit request.
    """
    msg_id    = data.get("msg_id")
    new_body  = data.get("body", "").strip()
    
    if not msg_id or not new_body:
        return
        
    if db.edit_message(msg_id, username, new_body):
        # Successfully edited in DB, broadcast it to all or specific users
        packet = {"type": "edit_message", "msg_id": msg_id, "body": new_body}
        
        # We need to dispatch it. For simplicity, broadcast to all. 
        # (Clients will only update if they hold the original message)
        broadcast_to_all(packet)


def handle_file(data: dict, username: str):
    """
    Save a file to disk, record it in the database, and forward to recipient.

    Files arrive as base64-encoded strings inside the JSON packet.
    We decode and save to  uploads/  on the server, then forward the
    full packet (including the base64 data) to the recipient so they
    can save it locally.
    """
    filename  = data.get("filename", "file")
    b64_data  = data.get("data", "")
    recipient = data.get("recipient", "ALL")

    # ── Size check ────────────────────────────────────────────────────────────
    try:
        decoded_size = len(base64.b64decode(b64_data, validate=True))
        if decoded_size > MAX_FILE_BYTES:
            send_to_user(username, build_system_packet(
                f"File too large. Limit is {MAX_FILE_BYTES // (1024*1024)} MB."))
            return
    except Exception:
        send_to_user(username, build_system_packet("Invalid file data."))
        return

    # ── Save to uploads/ ──────────────────────────────────────────────────────
    msg_id = new_msg_id()
    try:
        file_path = save_file_from_b64(msg_id, filename, b64_data)
    except Exception as e:
        log.error(f"File save failed for {username}: {e}")
        send_to_user(username, build_system_packet(f"File transfer failed: {e}"))
        return

    # ── Record in database ────────────────────────────────────────────────────
    db.save_file_record(msg_id, username, recipient, filename, file_path, now_timestamp())
    log.info(f"FILE {username} → {recipient}: {filename} saved to {file_path}")

    # ── Build and send the packet ─────────────────────────────────────────────
    packet = build_file_packet(username, recipient, filename, b64_data, msg_id)

    if recipient == "ALL":
        broadcast_to_all(packet)
    else:
        send_to_user(recipient, packet)
        send_to_user(username, packet)   # echo back to sender so their UI shows the sent file
        db.update_message_status(msg_id, "delivered")
        send_to_user(username, build_status_packet(msg_id, "delivered"))


def handle_typing(data: dict, username: str):
    """
    Forward a typing-indicator to the relevant recipient.
    Does not touch the database — typing events are ephemeral.
    """
    recipient = data.get("recipient", "")
    if not recipient or recipient == "ALL":
        return   # don't broadcast typing to everyone (too noisy)

    packet = build_typing_packet(username, recipient)
    send_to_user(recipient, packet)


def handle_status(data: dict, username: str):
    """
    Handle a 'seen' acknowledgement from a client.

    When the recipient renders a message in their chat window they send:
      {"type":"status", "msg_id":"msg_...", "status":"seen"}

    We update the database and forward the status to the original sender
    so their GUI can upgrade  ✓  to  ✓✓.
    """
    msg_id = data.get("msg_id", "")
    status = data.get("status", "")

    if status not in ("delivered", "seen"):
        return
    if not msg_id:
        return

    # Update the database record
    db.update_message_status(msg_id, status)

    # Find who sent this message so we can notify them
    original = db.get_message(msg_id)
    if original:
        sender = original["sender"]
        if sender != username:   # no point notifying yourself
            send_to_user(sender, build_status_packet(msg_id, status))
            log.debug(f"STATUS {msg_id} → {status} (notified {sender})")


def handle_search(data: dict, username: str):
    """
    Full-text search over the user's own message history.
    Results are sent back only to the requesting user.
    """
    query = data.get("query", "").strip()
    if not query:
        return

    results = do_search(db, query, username)
    log.info(f"SEARCH '{query}' by {username} → {len(results)} results")
    send_to_user(username, build_search_results_packet(query, results))


def handle_history_request(data: dict, username: str):
    """
    Fetch up to 50 messages for a given contact.
    If contact == "ALL", grabs global conversation.
    Otherwise, grabs direct messages between user and contact.
    New users only see messages sent after they joined.
    """
    contact = data.get("contact", "")
    if not contact:
        return

    # Get the user's join date so new users don't see old history
    joined_at = db.get_joined_at(username)

    if contact == "ALL":
        msgs = db.get_global_conversation(50, after_ts=joined_at)
    else:
        msgs = db.get_conversation(username, contact, 50, after_ts=joined_at)
    
    # Format them cleanly before sending
    formatted_msgs = []
    for m in msgs:
        ts = m.get("timestamp") or ""
        formatted_msgs.append({
            "id": m["msg_id"],
            "sender": m["sender"],
            "recipient": m["recipient"],
            "body": m["body"],
            "time": ts[11:16] if len(ts) >= 16 else "",   # safe HH:MM slice
            "status": m["status"],
            "reply_to": m.get("reply_to"),
        })

    packet = build_history_packet(contact, formatted_msgs)
    send_to_user(username, packet)
    log.info(f"HISTORY served for {contact} to {username} ({len(formatted_msgs)} msgs)")


def handle_reaction(data: dict, username: str):
    msg_id = data.get("msg_id")
    emoji  = data.get("emoji")
    action = data.get("action", "add")
    if not msg_id or not emoji: return

    if action == "add":
        db.add_reaction(msg_id, username, emoji)
    else:
        db.remove_reaction(msg_id, username)

    # Broadcast to recipients
    msg = db.get_message(msg_id)
    if msg:
        packet = build_reaction_packet(msg_id, username, emoji, action)
        if msg["recipient"] == "ALL":
            broadcast_to_all(packet)
        else:
            send_to_user(msg["sender"], packet)
            send_to_user(msg["recipient"], packet)


def handle_profile_update(data: dict, username: str):
    bio = data.get("bio")
    avatar = data.get("avatar")
    public_key = data.get("public_key")
    presence = data.get("presence")
    status_text = data.get("status_text")

    # Validate avatar URL: must be empty or an http/https URL pointing to an
    # external host (prevents javascript:, data:, file: and other dangerous
    # URI schemes, and guards against server-side request forgery).
    if avatar is not None and avatar != "":
        if not avatar.lower().startswith(("http://", "https://")):
            send_to_user(username, build_system_packet("Invalid avatar URL. Must be an http/https URL."))
            avatar = None
        else:
            parsed_av = urllib.parse.urlparse(avatar)
            av_hostname = parsed_av.hostname or ""
            if av_hostname and _check_url_hostname(av_hostname) is not None:
                send_to_user(username, build_system_packet("Avatar URL points to an internal address."))
                avatar = None
    
    kwargs = {}
    if presence is not None: kwargs["presence"] = presence
    if status_text is not None: kwargs["status_text"] = status_text
    
    db.update_profile(username, bio, avatar, public_key, **kwargs)
    
    # Notify user that profile is updated
    send_to_user(username, build_profile_packet(db.get_user_profile(username)))
    # Because presence is public to all users, push user list if presence changed
    if presence is not None or status_text is not None:
        push_user_list()


def handle_pin(data: dict, username: str):
    msg_id = data.get("msg_id")
    if not msg_id: return
    db.toggle_pin(msg_id)
    msg = db.get_message(msg_id)
    if msg:
        packet = build_pin_packet(msg_id, bool(msg["is_pinned"]))
        if msg["recipient"] == "ALL":
            broadcast_to_all(packet)
        else:
            send_to_user(msg["sender"], packet)
            send_to_user(msg["recipient"], packet)


def handle_admin_stats(username: str):
    profile = db.get_user_profile(username)
    if profile and profile.get("is_admin"):
        stats = db.get_admin_stats()
        send_to_user(username, build_admin_stats_packet(stats))

def handle_admin_action(data: dict, username: str):
    """
    Handle administrative destructive or management actions.
    Must verify admin status before executing.
    """
    profile = db.get_user_profile(username)
    if not profile or not profile.get("is_admin"):
        send_to_user(username, build_system_packet("Permission denied: Admin only."))
        return

    action = data.get("action")
    target = data.get("target")

    if action == "delete_user":
        if target == username:
            send_to_user(username, build_system_packet("Error: You cannot delete yourself."))
            return
        
        try:
            db.log_admin_action(username, "delete_user", target)
            db.delete_user(target)
            log.info(f"ADMIN {username} deleted user {target}")
            
            # If the target is online, kick them
            with clients_lock:
                if target in clients:
                    target_sock = clients[target]
                    try:
                        send_packet(target_sock, build_system_packet("Your account has been deleted by an administrator."))
                        target_sock.close()
                    except Exception as e:
                        log.warning(f"Error kicking deleted user: {e}")
            
            # Refresh stats for the admin
            handle_admin_stats(username)
            # Notify globally about the user leaving
            broadcast_system(f"Account '{target}' has been removed from the platform.")
            push_user_list()
            send_to_user(username, build_system_packet(f"Successfully deleted user: {target}"))
        except Exception as e:
            err_msg = f"Failed to delete {target}. Backend error: {e}"
            log.error(err_msg)
            send_to_user(username, build_system_packet(err_msg))

    elif action == "broadcast":
        body = data.get("body", "")
        if body:
            log.info(f"ADMIN {username} broadcasted: {body}")
            broadcast_to_all(build_system_packet(f"📣 ADMIN ANNOUNCEMENT: {body}"))


def handle_voice(data: dict, username: str):
    recipient = data.get("recipient", "ALL")
    data_b64 = data.get("data")
    if not data_b64: return

    # Validate size of voice data (same limit as regular files)
    try:
        decoded_size = len(base64.b64decode(data_b64, validate=True))
        if decoded_size > MAX_FILE_BYTES:
            send_to_user(username, build_system_packet(
                f"Voice message too large. Limit is {MAX_FILE_BYTES // (1024*1024)} MB."))
            return
    except Exception:
        send_to_user(username, build_system_packet("Invalid voice data."))
        return

    msg_id = new_msg_id()
    # Save as file too for persistence
    db.save_message(msg_id, username, recipient, "[Voice Message]", now_timestamp())
    packet = build_voice_packet(username, recipient, data_b64, msg_id)
    if recipient == "ALL":
        broadcast_to_all(packet)
    else:
        send_to_user(recipient, packet)
        send_to_user(username, build_status_packet(msg_id, "delivered"))


def handle_webrtc(data: dict, username: str):
    recipient = data.get("recipient")
    signal = data.get("signal")
    if not recipient or not signal: return
    send_to_user(recipient, build_webrtc_packet(username, recipient, signal))


def handle_schedule(data: dict, username: str):
    """Save a message with a future scheduled_at timestamp."""
    body         = data.get("body", "").strip()
    recipient    = data.get("recipient", "ALL")
    scheduled_at = data.get("scheduled_at")  # ISO string e.g. '2024-12-31T18:00'
    reply_to     = data.get("reply_to")
    if not body or not scheduled_at:
        return
    msg_id = new_msg_id()
    db.save_message(msg_id, username, recipient, body, now_timestamp(),
                    reply_to=reply_to, scheduled_at=scheduled_at)
    # Confirm to sender that it was scheduled
    send_to_user(username, build_system_packet(
        f"⏰ Message scheduled for {scheduled_at}: \"{body[:40]}\""))


def scheduled_flush_loop():
    """Background thread: every 30 s dispatch any due scheduled messages."""
    while True:
        try:
            now_str = time.strftime('%Y-%m-%dT%H:%M', time.localtime())
            due = db.get_due_scheduled_messages(now_str)
            for msg in due:
                packet = build_chat_packet(
                    sender=msg['sender'],
                    recipient=msg['recipient'],
                    body=msg['body'],
                    msg_id=msg['msg_id']
                )
                if msg['reply_to']:
                    packet['reply_to'] = msg['reply_to']
                if msg['recipient'] == 'ALL':
                    broadcast_to_all(packet)
                else:
                    send_to_user(msg['recipient'], packet)
                    send_to_user(msg['sender'], packet)
                db.mark_scheduled_dispatched(msg['msg_id'])
                log.info(f"SCHEDULED dispatch: {msg['sender']} → {msg['recipient']}: {msg['body'][:40]}")
        except Exception as e:
            log.error(f"scheduled_flush_loop error: {e}")
        time.sleep(30)



def handle_key_exchange(data: dict, username: str):
    public_key = data.get("public_key")
    if not public_key: return
    db.update_profile(username, public_key=public_key)
    # When a key is updated, we could broadcast it, or let others fetch it.
    # For now, we'll let others fetch it via user profiles or just send it to current chats.
    broadcast_to_all(build_key_exchange_packet(username, public_key))


# =============================================================================
# Per-client thread
# =============================================================================

def handle_client(conn: socket.socket, addr, username: str):
    """
    Runs in its own daemon thread for each connected client.
    Uses socket.makefile() for properly buffered, lossless line reading —
    critical for large file payloads that span multiple TCP segments.
    """
    log.info(f"CONNECT  {username}  from  {addr[0]}:{addr[1]}")
    broadcast_system(f"{username} joined the chat")
    push_user_list()

    # makefile gives us a buffered file-like object — readline() on it
    # correctly handles multi-packet TCP chunks without losing data.
    conn_file = conn.makefile('rb', buffering=65536)

    import time
    RATE_LIMIT_MSGS = 50
    RATE_LIMIT_WINDOW = 1.0
    msg_count = 0
    window_start = time.time()

    try:
        while True:
            try:
                line = conn_file.readline()
            except OSError:
                break

            if not line:
                break

            raw = line.decode("utf-8", errors="replace").strip()
            if not raw:
                continue

            # Rate Limiting Logic
            now = time.time()
            if now - window_start > RATE_LIMIT_WINDOW:
                msg_count = 0
                window_start = now
            msg_count += 1
            if msg_count > RATE_LIMIT_MSGS:
                log.warning(f"Rate Limiting triggered for {username}")
                send_packet(conn, build_system_packet("You are sending messages too fast. Connection closed."))
                break

            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                log.warning(f"Malformed packet from {username}: {raw[:80]}")
                continue

            msg_type = data.get("type", "")

            if   msg_type == "chat":         handle_chat(data, username)
            elif msg_type == "file":         handle_file(data, username)
            elif msg_type == "typing":       handle_typing(data, username)
            elif msg_type == "status":       handle_status(data, username)
            elif msg_type == "search":       handle_search(data, username)
            elif msg_type == "sync_history": handle_history_request(data, username)
            elif msg_type == "reaction":     handle_reaction(data, username)
            elif msg_type == "profile_upd":  handle_profile_update(data, username)
            elif msg_type == "pin":          handle_pin(data, username)
            elif msg_type == "admin_stats":  handle_admin_stats(username)
            elif msg_type == "admin_action": handle_admin_action(data, username)
            elif msg_type == "voice":         handle_voice(data, username)
            elif msg_type == "webrtc":       handle_webrtc(data, username)
            elif msg_type == "key_exchange": handle_key_exchange(data, username)
            elif msg_type == "schedule":     handle_schedule(data, username)
            elif msg_type == "edit":         handle_edit(data, username)
            elif msg_type == "link_preview": handle_link_preview(data, username)

    except Exception as e:
        log.error(f"Unhandled error in thread for {username}: {e}")

    finally:
        conn_file.close()
        with clients_lock:
            clients.pop(username, None)
        conn.close()
        db.update_last_seen(username)
        log.info(f"DISCONNECT  {username}")
        broadcast_system(f"{username} left the chat")
        push_user_list()


# =============================================================================
# Authentication  (runs before spawning the client thread)
# =============================================================================

def do_login_or_signup(conn: socket.socket) -> str | None:
    """
    Read the first packet from a new connection and handle login/signup.

    Expected packet:
      {"type": "login",  "username": "Alice", "password": "secret"}
      {"type": "signup", "username": "Alice", "password": "secret"}

    Returns the authenticated username on success, or None on failure.
    """
    raw = receive_line(conn)
    if not raw:
        return None

    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        send_packet(conn, build_login_error_packet("Invalid packet format."))
        return None

    auth_type = data.get("type", "")
    username  = data.get("username", "").strip()
    password  = data.get("password", "").strip()

    # ── Input validation ──────────────────────────────────────────────────────
    if not username or not password:
        send_packet(conn, build_login_error_packet("Username and password are required."))
        return None
    if len(username) > MAX_USERNAME_LEN:
        send_packet(conn, build_login_error_packet(
            f"Username too long.  Maximum is {MAX_USERNAME_LEN} characters."))
        return None
    if not _USERNAME_RE.match(username):
        send_packet(conn, build_login_error_packet(
            "Username may only contain letters, digits, underscores and hyphens."))
        return None
    if len(password) < 8:
        send_packet(conn, build_login_error_packet(
            "Password must be at least 8 characters."))
        return None

    # ── Check if already logged in ────────────────────────────────────────────
    with clients_lock:
        already_online = username in clients

    if already_online:
        send_packet(conn, build_login_error_packet(
            f"'{username}' is already connected.  Use a different name."))
        return None

    # ── Login ──────────────────────────────────────────────────────────────────
    if auth_type == "login":
        if db.get_recent_failed_logins(username, 15) > 5:
            send_packet(conn, build_login_error_packet("Too many failed attempts. Try again in 15 minutes."))
            return None

        stored_hash = db.get_password_hash(username)
        if stored_hash is None:
            db.increment_failed_login(username)
            send_packet(conn, build_login_error_packet(
                f"No account found for '{username}'.  Sign up first."))
            return None
        if not verify_password(password, stored_hash):
            db.increment_failed_login(username)
            send_packet(conn, build_login_error_packet("Incorrect password."))
            log.warning(f"Failed login attempt for '{username}'")
            return None
            
        db.clear_failed_logins(username)
        send_packet(conn, build_login_ok_packet(username))
        log.info(f"LOGIN  {username}")
        return username

    # ── Signup ──────────────────────────────────────────────────────────────
    elif auth_type == "signup":
        hashed = hash_password(password)
        created = db.create_user(username, hashed)
        if not created:
            send_packet(conn, build_login_error_packet(
                f"Username '{username}' is already taken.  Choose another."))
            return None
        send_packet(conn, build_signup_ok_packet(username))
        log.info(f"SIGNUP  {username}  (new account created)")
        return username

    else:
        send_packet(conn, build_login_error_packet(
            f"Unknown auth type '{auth_type}'.  Use 'login' or 'signup'."))
        return None


# =============================================================================
# Per-connection auth thread  (fixes the accept-loop blocking bug)
# =============================================================================

def auth_and_launch(conn: socket.socket, addr):
    """
    Runs in its own daemon thread for EACH incoming TCP connection.

    WHY THIS EXISTS (critical bug fix):
    -----------------------------------
    The old code called do_login_or_signup() directly in the accept loop.
    do_login_or_signup() calls receive_line() which does a BLOCKING socket
    read — waiting for the client to send the first packet.

    Because the WebSocket proxy opens a new TCP connection for every WS
    client (including idle reconnects from the browser), the accept loop
    was permanently stuck waiting for a login packet on the first idle
    connection.  No further TCP connections could be processed, so actual
    login attempts were silently queued and never handled.

    The fix: every accepted connection gets its own auth thread.  The
    accept loop returns to accept() immediately, so many connections can
    authenticate concurrently without blocking each other.

    A socket timeout is set so that idle connections that never send a
    login packet are cleaned up after AUTH_TIMEOUT_SECS seconds.
    """
    # Set a timeout so idle proxy connections don't hang this thread forever
    conn.settimeout(AUTH_TIMEOUT_SECS)

    try:
        username = do_login_or_signup(conn)
    except Exception as e:
        log.warning(f"Auth error from {addr}: {e}")
        username = None
    finally:
        # Remove the timeout — the client thread uses blocking I/O again
        conn.settimeout(None)

    if username is None:
        conn.close()
        return

    # Register and launch the main client thread
    with clients_lock:
        clients[username] = conn

    t = threading.Thread(
        target=handle_client,
        args=(conn, addr, username),
        daemon=True
    )
    t.start()


# =============================================================================
# Main accept loop
# =============================================================================

def start_server():
    server_sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server_sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server_sock.bind((HOST, PORT))
    server_sock.listen(50)   # increased backlog to handle burst connections from the proxy

    log.info("=" * 52)
    log.info(f"  IM Server started  —  listening on port {PORT}")
    log.info(f"  Database  : database.db")
    log.info(f"  Log file  : server.log")
    log.info(f"  Uploads   : uploads/")
    log.info(f"  Ctrl+C to stop.")
    log.info("=" * 52)

    try:
        while True:
            try:
                conn, addr = server_sock.accept()
            except OSError:
                break   # server socket was closed (Ctrl+C)

            # ── Spawn auth thread immediately so the accept loop stays free ───
            t = threading.Thread(
                target=auth_and_launch,
                args=(conn, addr),
                daemon=True
            )
            t.start()

    except KeyboardInterrupt:
        log.info("Keyboard interrupt — shutting down.")
    finally:
        server_sock.close()
        db.close()
        log.info("Server stopped.  Goodbye.")


# =============================================================================
# Entry point
# =============================================================================

if __name__ == "__main__":
    # Start the scheduled message flush background thread
    sched_thread = threading.Thread(target=scheduled_flush_loop, daemon=True)
    sched_thread.start()
    start_server()
