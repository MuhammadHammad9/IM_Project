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

from modules.logger      import get_logger
from modules.db          import Database
from modules.auth        import hash_password, verify_password
from modules.messaging   import (
    new_msg_id, now_timestamp, now_display,
    build_chat_packet, build_system_packet, build_status_packet,
    build_typing_packet, build_userlist_packet, build_file_packet,
    build_search_results_packet, build_history_packet,
    build_login_ok_packet, build_login_error_packet, build_signup_ok_packet
)
from modules.file_handler import save_file_from_b64, MAX_FILE_BYTES
from modules.search       import search as do_search

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

def receive_line(conn: socket.socket) -> str:
    """
    Thin wrapper kept for auth phase — in handle_client we use makefile()
    for proper buffering. This reads until newline, one byte at a time.
    Only used for the first (auth) packet.
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
    Broadcast the current online-user list to all clients.
    Called whenever someone joins or leaves so every client's
    recipient dropdown stays current.
    """
    with clients_lock:
        online = list(clients.keys())
    broadcast_to_all(build_userlist_packet(online))


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

    # ── Validation ────────────────────────────────────────────────────────────
    if not body:
        return
    if len(body) > MAX_MSG_CHARS:
        send_to_user(username, build_system_packet(
            f"Message too long ({len(body)} chars).  Limit is {MAX_MSG_CHARS}."))
        return

    # ── Build the canonical packet (server stamps the time and ID) ────────────
    msg_id = new_msg_id()
    packet = build_chat_packet(
        sender    = username,
        recipient = recipient,
        body      = body,
        msg_id    = msg_id
    )

    # ── Persist to database ───────────────────────────────────────────────────
    db.save_message(msg_id, username, recipient, body, now_timestamp())
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
    # base64 expands size by ~33%, so the encoded string can be at most
    # (MAX_FILE_BYTES * 4/3) chars.
    max_b64_len = int(MAX_FILE_BYTES * 1.35)
    if len(b64_data) > max_b64_len:
        send_to_user(username, build_system_packet(
            f"File too large.  Limit is {MAX_FILE_BYTES // (1024*1024)} MB."))
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
        # Send a lightweight delivered status back to sender — NOT the full
        # base64 payload, which caused proxy LimitOverrunError & disconnects.
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
    """
    contact = data.get("contact", "")
    if not contact:
        return

    if contact == "ALL":
        msgs = db.get_global_conversation(50)
    else:
        msgs = db.get_conversation(username, contact, 50)
    
    # Format them cleanly before sending
    formatted_msgs = []
    for m in msgs:
        formatted_msgs.append({
            "id": m["msg_id"],
            "sender": m["sender"],
            "recipient": m["recipient"],
            "body": m["body"],
            "time": m["timestamp"][11:16],  # extract HH:MM
            "status": m["status"]
        })

    packet = build_history_packet(contact, formatted_msgs)
    send_to_user(username, packet)
    log.info(f"HISTORY served for {contact} to {username} ({len(formatted_msgs)} msgs)")


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
    if " " in username:
        send_packet(conn, build_login_error_packet("Username cannot contain spaces."))
        return None
    if len(password) < 4:
        send_packet(conn, build_login_error_packet(
            "Password must be at least 4 characters."))
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
        stored_hash = db.get_password_hash(username)
        if stored_hash is None:
            send_packet(conn, build_login_error_packet(
                f"No account found for '{username}'.  Sign up first."))
            return None
        if not verify_password(password, stored_hash):
            send_packet(conn, build_login_error_packet("Incorrect password."))
            log.warning(f"Failed login attempt for '{username}'")
            return None
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
# Main accept loop
# =============================================================================

def start_server():
    server_sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server_sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server_sock.bind((HOST, PORT))
    server_sock.listen(20)

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

            # ── Authentication ────────────────────────────────────────────────
            username = do_login_or_signup(conn)
            if username is None:
                conn.close()
                continue

            # ── Register and spawn thread ─────────────────────────────────────
            with clients_lock:
                clients[username] = conn

            t = threading.Thread(
                target=handle_client,
                args=(conn, addr, username),
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
    start_server()
