# =============================================================================
# client.py  —  Instant Messaging Client  (Full Version)
# =============================================================================
# Run after the server:   python client.py
# You can open multiple windows at the same time.
#
# IMPORTANT — folder structure required:
#   IM_Project/
#   ├── server.py
#   ├── client.py        ← this file
#   └── modules/
#       ├── auth.py, db.py, file_handler.py, logger.py, messaging.py, search.py
# =============================================================================

# Make sure Python can find the modules/ folder even if you run this
# script from a different working directory
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
#
# NEW FEATURES vs basic version:
#   ✓  Login screen with username + password (Login / Sign Up buttons)
#   ✓  Message IDs — every sent message has a unique identifier
#   ✓  Tick marks — ✓ delivered,  ✓✓ seen
#   ✓  Typing indicator — "Bob is typing…" appears and auto-hides
#   ✓  File sending — attach any file up to 10 MB
#   ✓  File receiving — Save button appears inline in chat
#   ✓  Search bar — Ctrl+F or top-bar search box
#   ✓  Online/offline display with last-seen info
#   ✓  Safe window close — no hanging threads
#
# THREADING ARCHITECTURE (unchanged from basic version):
#   Main thread      → Tkinter GUI event loop + queue processor (every 100 ms)
#   Receive thread   → recv() loop, puts packets into msg_queue
#   Connect thread   → runs during login to avoid freezing the GUI
# =============================================================================

import socket
import threading
import json
import queue
import time
import os
import datetime
import base64
import tkinter as tk
from tkinter import scrolledtext, ttk, messagebox, filedialog

from modules.file_handler import encode_file, decode_file, human_readable_size, MAX_FILE_BYTES
from modules.messaging    import new_msg_id, now_display

# ─── Connection defaults ──────────────────────────────────────────────────────

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 5555


# =============================================================================
# Main application class
# =============================================================================

class IMClient:

    def __init__(self):
        # ── Network ───────────────────────────────────────────────────────────
        self.sock: socket.socket = None
        self.username: str       = ""
        self.connected: bool     = False

        # ── Thread-safe incoming-message queue ────────────────────────────────
        # The receive thread puts dicts here.
        # The main thread reads them every 100 ms via root.after().
        self.msg_queue: queue.Queue = queue.Queue()

        # ── Typing-indicator state ────────────────────────────────────────────
        # We throttle typing packets to at most one every 2 seconds.
        self._last_typing_sent: float = 0
        self._typing_hide_job         = None   # root.after handle

        # ── Message status tracking ───────────────────────────────────────────
        # Maps msg_id → the Tkinter Text index where the status tick lives.
        # We use this to find and update the tick when a status packet arrives.
        self._msg_tick_ranges: dict = {}   # { "msg_id": tkinter_mark_name }

        # ── Build the root window ─────────────────────────────────────────────
        self.root = tk.Tk()
        self.root.title("Instant Messenger")
        self.root.geometry("700x560")
        self.root.minsize(520, 420)
        self.root.configure(bg="#f2f2f2")
        self.root.protocol("WM_DELETE_WINDOW", self._on_close)

        # Show login screen first
        self._build_login_screen()

        # Start the recurring queue-poller (runs on main thread every 100 ms)
        self.root.after(100, self._process_queue)

        # Bind global keyboard shortcut for search
        self.root.bind_all("<Control-f>", lambda _: self._focus_search())

        self.root.mainloop()

    # =========================================================================
    # LOGIN SCREEN
    # =========================================================================

    def _build_login_screen(self):
        """Construct the initial login / sign-up form."""
        self.login_frame = tk.Frame(self.root, bg="#f2f2f2", padx=48, pady=24)
        self.login_frame.pack(fill=tk.BOTH, expand=True)

        # Title
        tk.Label(self.login_frame, text="Instant Messenger",
                 font=("Helvetica", 24, "bold"), bg="#f2f2f2", fg="#111111"
                 ).pack(pady=(20, 4))
        tk.Label(self.login_frame, text="Connect to a chat server",
                 font=("Helvetica", 11), bg="#f2f2f2", fg="#666666"
                 ).pack(pady=(0, 24))

        def row(label, default="", show=""):
            """Helper — labelled entry in a frame."""
            f = tk.Frame(self.login_frame, bg="#f2f2f2")
            f.pack(fill=tk.X, pady=(0, 10))
            tk.Label(f, text=label, width=14, anchor="w",
                     bg="#f2f2f2", font=("Helvetica", 10), fg="#333333"
                     ).pack(side=tk.LEFT)
            e = tk.Entry(f, font=("Helvetica", 12), relief=tk.SOLID,
                         bd=1, show=show)
            e.insert(0, default)
            e.pack(side=tk.LEFT, fill=tk.X, expand=True, ipady=5)
            return e

        self.le_host  = row("Server address", DEFAULT_HOST)
        self.le_port  = row("Port",           str(DEFAULT_PORT))
        self.le_user  = row("Username")
        self.le_pass  = row("Password",       show="•")

        # Password field sends on Enter
        self.le_pass.bind("<Return>", lambda _: self._attempt_login("login"))

        # Two buttons side by side: Login / Sign Up
        btn_row = tk.Frame(self.login_frame, bg="#f2f2f2")
        btn_row.pack(pady=14)

        self.btn_login = tk.Button(
            btn_row, text="Login",
            font=("Helvetica", 11, "bold"),
            bg="#0055cc", fg="white",
            activebackground="#0044aa", activeforeground="white",
            relief=tk.FLAT, bd=0, padx=22, pady=9, cursor="hand2",
            command=lambda: self._attempt_login("login")
        )
        self.btn_login.pack(side=tk.LEFT, padx=(0, 10))

        self.btn_signup = tk.Button(
            btn_row, text="Sign Up",
            font=("Helvetica", 11),
            bg="#f2f2f2", fg="#0055cc",
            activebackground="#e8e8e8", activeforeground="#0044aa",
            relief=tk.SOLID, bd=1, padx=22, pady=9, cursor="hand2",
            command=lambda: self._attempt_login("signup")
        )
        self.btn_signup.pack(side=tk.LEFT)

        # Status label
        self.login_status = tk.Label(
            self.login_frame, text="",
            font=("Helvetica", 10), bg="#f2f2f2", fg="red", wraplength=380
        )
        self.login_status.pack()

        self.le_user.focus_set()

    def _attempt_login(self, auth_type: str):
        """Validate form inputs and start the connection in a background thread."""
        host     = self.le_host.get().strip()
        port_str = self.le_port.get().strip()
        username = self.le_user.get().strip()
        password = self.le_pass.get().strip()

        if not username:
            self._set_login_status("Please enter a username.", "red"); return
        if not password:
            self._set_login_status("Please enter a password.", "red"); return
        if len(username) > 20:
            self._set_login_status("Username must be 20 chars or fewer.", "red"); return
        if " " in username:
            self._set_login_status("Username cannot contain spaces.", "red"); return
        if len(password) < 4:
            self._set_login_status("Password must be at least 4 characters.", "red"); return
        if not host:
            self._set_login_status("Please enter a server address.", "red"); return
        try:
            port = int(port_str)
            assert 1 <= port <= 65535
        except Exception:
            self._set_login_status("Port must be a number 1–65535.", "red"); return

        # Disable buttons while connecting
        self.btn_login.config(state=tk.DISABLED, text="Connecting…")
        self.btn_signup.config(state=tk.DISABLED)
        self._set_login_status("Reaching the server…", "#666666")

        t = threading.Thread(
            target=self._connect_thread,
            args=(host, port, username, password, auth_type),
            daemon=True
        )
        t.start()

    def _connect_thread(self, host, port, username, password, auth_type):
        """Background thread: create socket, authenticate, hand off to GUI."""
        try:
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.settimeout(7)
            sock.connect((host, port))
            sock.settimeout(None)

            # Send the auth packet
            packet = {"type": auth_type, "username": username, "password": password}
            sock.send((json.dumps(packet) + "\n").encode("utf-8"))

            # Read response
            raw  = self._read_line(sock)
            if not raw:
                raise ConnectionError("Server closed connection before responding.")
            resp = json.loads(raw)

            if resp.get("type") == "login_error":
                sock.close()
                self.root.after(0, lambda: self._login_failed(resp.get("body", "Auth failed.")))
                return

            if resp.get("type") == "login_ok":
                self.sock      = sock
                self.username  = username
                self.connected = True
                self.root.after(0, self._show_chat_screen)
                threading.Thread(target=self._receive_loop, daemon=True).start()
                return

            raise ConnectionError(f"Unexpected response: {resp}")

        except socket.timeout:
            self.root.after(0, lambda: self._login_failed(
                "Connection timed out.  Is the server running?"))
        except ConnectionRefusedError:
            self.root.after(0, lambda: self._login_failed(
                "Connection refused.  Check address/port and make sure the server is running."))
        except json.JSONDecodeError:
            self.root.after(0, lambda: self._login_failed(
                "Received unreadable data from server."))
        except Exception as e:
            self.root.after(0, lambda: self._login_failed(f"Error: {e}"))

    def _login_failed(self, msg: str):
        self.btn_login.config(state=tk.NORMAL, text="Login")
        self.btn_signup.config(state=tk.NORMAL)
        self._set_login_status(msg, "red")

    def _set_login_status(self, text: str, color: str):
        self.login_status.config(text=text, fg=color)

    # =========================================================================
    # CHAT SCREEN
    # =========================================================================

    def _show_chat_screen(self):
        """Tear down the login frame and build the chat interface."""
        self.login_frame.destroy()
        self.root.title(f"Instant Messenger  —  {self.username}")
        self._build_chat_screen()

    def _build_chat_screen(self):
        """Construct every widget in the main chat window."""

        # ── Top bar ───────────────────────────────────────────────────────────
        topbar = tk.Frame(self.root, bg="#e0e0e0", padx=10, pady=5)
        topbar.pack(fill=tk.X, side=tk.TOP)

        tk.Label(topbar, text="Online:", bg="#e0e0e0",
                 font=("Helvetica", 10, "bold"), fg="#333333"
                 ).pack(side=tk.LEFT)

        self.lbl_users = tk.Label(
            topbar, text="", bg="#e0e0e0",
            font=("Helvetica", 10), fg="#555555"
        )
        self.lbl_users.pack(side=tk.LEFT, padx=8)

        # You label on the right
        tk.Label(topbar, text=f"You: {self.username}", bg="#e0e0e0",
                 font=("Helvetica", 10, "italic"), fg="#0055cc"
                 ).pack(side=tk.RIGHT, padx=4)

        # Search box (Ctrl+F focuses it)
        tk.Label(topbar, text="Search:", bg="#e0e0e0",
                 font=("Helvetica", 10), fg="#555555"
                 ).pack(side=tk.RIGHT, padx=(12, 2))
        self.search_entry = tk.Entry(
            topbar, font=("Helvetica", 10), width=18, relief=tk.SOLID, bd=1
        )
        self.search_entry.pack(side=tk.RIGHT)
        self.search_entry.bind("<Return>", lambda _: self._do_search())

        # ── Chat display area ─────────────────────────────────────────────────
        self.chat_box = scrolledtext.ScrolledText(
            self.root, state=tk.DISABLED, wrap=tk.WORD,
            font=("Helvetica", 11), bg="white", relief=tk.FLAT,
            padx=14, pady=8
        )
        self.chat_box.pack(fill=tk.BOTH, expand=True, padx=6, pady=(4, 0))

        # Text tags for visual styling
        self.chat_box.tag_config("timestamp",
            foreground="#bbbbbb", font=("Helvetica", 9))
        self.chat_box.tag_config("sender_self",
            foreground="#0055cc", font=("Helvetica", 11, "bold"))
        self.chat_box.tag_config("sender_other",
            foreground="#cc4400", font=("Helvetica", 11, "bold"))
        self.chat_box.tag_config("private_label",
            foreground="#998800", font=("Helvetica", 9, "italic"))
        self.chat_box.tag_config("body",
            foreground="#222222", font=("Helvetica", 11))
        self.chat_box.tag_config("tick",
            foreground="#aaaaaa", font=("Helvetica", 10))
        self.chat_box.tag_config("tick_seen",
            foreground="#00aa55", font=("Helvetica", 10))
        self.chat_box.tag_config("system",
            foreground="#999999", font=("Helvetica", 10, "italic"),
            spacing1=2, spacing3=2)
        self.chat_box.tag_config("search_header",
            foreground="#0055cc", font=("Helvetica", 10, "bold"),
            spacing1=4, spacing3=4)
        self.chat_box.tag_config("search_result",
            foreground="#444444", font=("Helvetica", 10),
            lmargin1=20, lmargin2=20, spacing1=1, spacing3=1)

        # ── Typing indicator ──────────────────────────────────────────────────
        self.lbl_typing = tk.Label(
            self.root, text="", bg="#f2f2f2",
            font=("Helvetica", 9, "italic"), fg="#888888", anchor="w"
        )
        self.lbl_typing.pack(fill=tk.X, padx=12)

        # ── Bottom panel ──────────────────────────────────────────────────────
        bottom = tk.Frame(self.root, bg="#f2f2f2", padx=6, pady=6)
        bottom.pack(fill=tk.X, side=tk.BOTTOM)

        # Recipient row
        recv_row = tk.Frame(bottom, bg="#f2f2f2")
        recv_row.pack(fill=tk.X, pady=(0, 5))

        tk.Label(recv_row, text="Send to:", bg="#f2f2f2",
                 font=("Helvetica", 10), fg="#444444", width=8, anchor="w"
                 ).pack(side=tk.LEFT)

        self.recipient_var = tk.StringVar(value="ALL")
        self.recipient_cb  = ttk.Combobox(
            recv_row, textvariable=self.recipient_var,
            state="readonly", width=20, font=("Helvetica", 11)
        )
        self.recipient_cb["values"] = ["ALL"]
        self.recipient_cb.pack(side=tk.LEFT, padx=(4, 0))

        tk.Label(recv_row, text=' "ALL" sends to everyone',
                 bg="#f2f2f2", fg="#aaaaaa",
                 font=("Helvetica", 9, "italic")
                 ).pack(side=tk.LEFT, padx=8)

        # Message input row
        msg_row = tk.Frame(bottom, bg="#f2f2f2")
        msg_row.pack(fill=tk.X)

        # Attach file button
        self.btn_attach = tk.Button(
            msg_row, text="Attach",
            font=("Helvetica", 10),
            bg="#f2f2f2", fg="#444444",
            activebackground="#e0e0e0",
            relief=tk.SOLID, bd=1,
            padx=10, pady=6,
            cursor="hand2",
            command=self._attach_file
        )
        self.btn_attach.pack(side=tk.LEFT, padx=(0, 6))

        self.msg_entry = tk.Entry(
            msg_row, font=("Helvetica", 12), relief=tk.SOLID, bd=1
        )
        self.msg_entry.pack(side=tk.LEFT, fill=tk.X, expand=True, ipady=6)
        self.msg_entry.bind("<Return>",   lambda _: self._send_message())
        self.msg_entry.bind("<KeyPress>", self._on_keypress)   # typing indicator

        self.btn_send = tk.Button(
            msg_row, text="Send",
            font=("Helvetica", 11, "bold"),
            bg="#0055cc", fg="white",
            activebackground="#0044aa", activeforeground="white",
            relief=tk.FLAT, bd=0,
            padx=18, pady=7,
            cursor="hand2",
            command=self._send_message
        )
        self.btn_send.pack(side=tk.LEFT, padx=(8, 0))

        self.msg_entry.focus_set()
        self._display_system(f"Logged in as '{self.username}'.  Say hello!")

    # =========================================================================
    # MESSAGE DISPLAY HELPERS
    # =========================================================================

    def _display_system(self, text: str):
        """Insert a grey italic system/status line."""
        self.chat_box.config(state=tk.NORMAL)
        self.chat_box.insert(tk.END, f"  {text}\n", "system")
        self.chat_box.config(state=tk.DISABLED)
        self.chat_box.see(tk.END)

    def _display_chat(self, data: dict):
        """
        Insert a chat message with sender name, body, and a status tick.

        Format:   [14:32]  Alice → Bob    Hello there!  ✓

        For messages the current user sent, the tick is trackable — when the
        server later sends a status update we find and replace it.
        """
        sender    = data.get("sender", "?")
        body      = data.get("body", "")
        time_str  = data.get("time", "")
        recipient = data.get("recipient", "ALL")
        msg_id    = data.get("msg_id", "")
        status    = data.get("status", "sent")

        self.chat_box.config(state=tk.NORMAL)

        self.chat_box.insert(tk.END, f"[{time_str}]  ", "timestamp")

        sender_tag = "sender_self" if sender == self.username else "sender_other"
        self.chat_box.insert(tk.END, sender, sender_tag)

        if recipient != "ALL":
            self.chat_box.insert(tk.END, f" → {recipient}", "private_label")

        self.chat_box.insert(tk.END, "    ", "body")
        self.chat_box.insert(tk.END, body, "body")

        # Tick mark — only on messages WE sent (so only we track their updates)
        if sender == self.username and msg_id:
            tick_char = "  ✓✓" if status == "seen" else "  ✓"
            # Insert the tick and immediately record the range of chars we used
            tick_start = self.chat_box.index(tk.INSERT)
            self.chat_box.insert(tk.END, tick_char, "tick")
            tick_end   = self.chat_box.index(tk.INSERT)
            # Create a named mark pair so we can find and replace this tick later
            mark = f"tick_{msg_id}"
            self.chat_box.mark_set(f"{mark}_s", tick_start)
            self.chat_box.mark_set(f"{mark}_e", tick_end)
            self._msg_tick_ranges[msg_id] = mark

        self.chat_box.insert(tk.END, "\n", "body")
        self.chat_box.config(state=tk.DISABLED)
        self.chat_box.see(tk.END)

        # If we RECEIVED this message, immediately send a 'seen' acknowledgement
        # (we rendered it, so the user sees it)
        if sender != self.username and msg_id and self.connected:
            self._send_status(msg_id, "seen")

    def _update_tick(self, msg_id: str, status: str):
        """
        Replace the tick mark on a previously sent message.
        ✓ (delivered) → ✓✓ (seen)
        Uses the named marks set in _display_chat to find the right chars.
        """
        mark = self._msg_tick_ranges.get(msg_id)
        if not mark:
            return

        try:
            s = f"{mark}_s"
            e = f"{mark}_e"
            self.chat_box.config(state=tk.NORMAL)
            self.chat_box.delete(s, e)

            tick_char = "  ✓✓" if status == "seen" else "  ✓"
            tick_tag  = "tick_seen" if status == "seen" else "tick"
            self.chat_box.insert(s, tick_char, tick_tag)

            # Move the end mark to the new end of the inserted text
            new_end = self.chat_box.index(s + f" + {len(tick_char)} chars")
            self.chat_box.mark_set(e, new_end)
            self.chat_box.config(state=tk.DISABLED)
        except tk.TclError:
            pass   # marks may have been invalidated — ignore

    def _display_file_message(self, data: dict):
        """
        Show a file-transfer notification with an inline 'Save' button.
        Tkinter's window_create() lets us embed real widgets inside a Text widget.
        """
        sender   = data.get("sender", "?")
        filename = data.get("filename", "file")
        time_str = data.get("time", "")
        size_b64 = len(data.get("data", ""))
        # Approximate the decoded size: base64 encodes 3 bytes as 4 chars
        approx_bytes = int(size_b64 * 3 / 4)

        self.chat_box.config(state=tk.NORMAL)

        self.chat_box.insert(tk.END, f"[{time_str}]  ", "timestamp")
        sender_tag = "sender_self" if sender == self.username else "sender_other"
        self.chat_box.insert(tk.END, sender, sender_tag)
        self.chat_box.insert(tk.END,
            f"    sent a file:  {filename}  ({human_readable_size(approx_bytes)})   ",
            "body")

        if sender != self.username:
            # Embed a Save button inline
            save_btn = tk.Button(
                self.chat_box, text="Save",
                font=("Helvetica", 9, "bold"),
                bg="#0055cc", fg="white",
                activebackground="#0044aa", activeforeground="white",
                relief=tk.FLAT, bd=0,
                padx=8, pady=2, cursor="hand2",
                command=lambda d=data: self._save_received_file(d)
            )
            self.chat_box.window_create(tk.END, window=save_btn)
        else:
            self.chat_box.insert(tk.END, "(sent)", "tick")

        self.chat_box.insert(tk.END, "\n", "body")
        self.chat_box.config(state=tk.DISABLED)
        self.chat_box.see(tk.END)

    def _display_search_results(self, data: dict):
        """Render search results with a distinct header inside the chat area."""
        results = data.get("results", [])
        query   = data.get("query", "")

        self.chat_box.config(state=tk.NORMAL)
        count = len(results)
        self.chat_box.insert(tk.END,
            f"\n── Search results for '{query}'  ({count} found) ──\n",
            "search_header")

        if not results:
            self.chat_box.insert(tk.END, "  (no messages matched)\n", "search_result")
        else:
            for msg in results:
                ts = msg.get("timestamp", "")[:16]   # YYYY-MM-DD HH:MM
                s  = msg.get("sender", "")
                r  = msg.get("recipient", "")
                b  = msg.get("body", "")
                self.chat_box.insert(tk.END,
                    f"  [{ts}]  {s} → {r}: {b}\n",
                    "search_result")

        self.chat_box.insert(tk.END, "── End of results ──\n\n", "search_header")
        self.chat_box.config(state=tk.DISABLED)
        self.chat_box.see(tk.END)

    # =========================================================================
    # SENDING
    # =========================================================================

    def _send_message(self):
        """Build a chat packet from the entry field and send it."""
        body = self.msg_entry.get().strip()
        if not body:
            return
        if not self.connected:
            self._display_system("Not connected.")
            return

        recipient = self.recipient_var.get() or "ALL"
        packet = {
            "type":      "chat",
            "sender":    self.username,
            "recipient": recipient,
            "body":      body,
            "time":      now_display(),
            "msg_id":    new_msg_id()   # client generates a preliminary ID;
                                        # server will stamp the authoritative one
        }

        try:
            self.sock.send((json.dumps(packet) + "\n").encode("utf-8"))
            self.msg_entry.delete(0, tk.END)
        except OSError:
            self.connected = False
            self._display_system("Connection lost — message not sent.")

    def _send_status(self, msg_id: str, status: str):
        """Send a delivery/seen acknowledgement to the server."""
        if not self.connected or not msg_id:
            return
        packet = {"type": "status", "msg_id": msg_id, "status": status}
        try:
            self.sock.send((json.dumps(packet) + "\n").encode("utf-8"))
        except OSError:
            pass

    def _send_typing_indicator(self):
        """Tell the server we are typing (throttled to once per 2 seconds)."""
        recipient = self.recipient_var.get()
        if not recipient or recipient == "ALL" or not self.connected:
            return
        packet = {"type": "typing", "sender": self.username, "recipient": recipient}
        try:
            self.sock.send((json.dumps(packet) + "\n").encode("utf-8"))
        except OSError:
            pass

    def _on_keypress(self, event):
        """Fired on every key press in the message entry — throttles typing packets."""
        now = time.time()
        if now - self._last_typing_sent > 2.0:
            self._last_typing_sent = now
            self._send_typing_indicator()

    # ─── File attachment ──────────────────────────────────────────────────────

    def _attach_file(self):
        """Open a file picker, encode the chosen file, and send it."""
        if not self.connected:
            messagebox.showwarning("Not connected", "You are not connected to a server.")
            return

        path = filedialog.askopenfilename(title="Choose a file to send")
        if not path:
            return   # user cancelled

        try:
            filename, b64_str, size = encode_file(path)
        except ValueError as e:
            messagebox.showerror("File too large", str(e))
            return
        except FileNotFoundError as e:
            messagebox.showerror("File not found", str(e))
            return

        recipient = self.recipient_var.get() or "ALL"
        packet = {
            "type":      "file",
            "sender":    self.username,
            "recipient": recipient,
            "filename":  filename,
            "data":      b64_str,
            "time":      now_display(),
            "msg_id":    new_msg_id()
        }

        try:
            raw = json.dumps(packet) + "\n"
            self.sock.send(raw.encode("utf-8"))
            self._display_system(f"Sending '{filename}' ({human_readable_size(size)})…")
        except OSError:
            self.connected = False
            self._display_system("Connection lost — file not sent.")

    def _save_received_file(self, data: dict):
        """Decode a received file and save it where the user chooses."""
        filename = data.get("filename", "file")
        b64_data = data.get("data", "")

        save_path = filedialog.asksaveasfilename(
            title="Save file as",
            initialfile=filename,
            defaultextension=""
        )
        if not save_path:
            return   # user cancelled

        try:
            raw_bytes = decode_file(b64_data)
            with open(save_path, "wb") as f:
                f.write(raw_bytes)
            self._display_system(f"File saved to: {save_path}")
        except Exception as e:
            messagebox.showerror("Save failed", str(e))

    # ─── Search ───────────────────────────────────────────────────────────────

    def _do_search(self):
        """Send a search request to the server."""
        query = self.search_entry.get().strip()
        if not query:
            return
        if not self.connected:
            return
        packet = {"type": "search", "query": query}
        try:
            self.sock.send((json.dumps(packet) + "\n").encode("utf-8"))
        except OSError:
            self.connected = False

    def _focus_search(self):
        """Ctrl+F — move keyboard focus to the search box."""
        if hasattr(self, "search_entry"):
            self.search_entry.focus_set()
            self.search_entry.select_range(0, tk.END)

    # ─── Online users ─────────────────────────────────────────────────────────

    def _update_user_list(self, users: list):
        """Refresh the top bar and recipient dropdown whenever the user list changes."""
        self.lbl_users.config(text=", ".join(users) if users else "(nobody)")

        options = ["ALL"] + [u for u in users if u != self.username]
        self.recipient_cb["values"] = options

        if self.recipient_var.get() not in options:
            self.recipient_var.set("ALL")

    # =========================================================================
    # RECEIVE THREAD + QUEUE PROCESSOR
    # =========================================================================

    def _receive_loop(self):
        """
        Background daemon thread: read packets from the server forever.
        Puts every packet into msg_queue — NEVER touches any Tkinter widget.
        """
        while self.connected:
            raw = self._read_line(self.sock)
            if not raw:
                self.msg_queue.put({"type": "_disconnected"})
                break
            try:
                self.msg_queue.put(json.loads(raw))
            except json.JSONDecodeError:
                pass

    def _process_queue(self):
        """
        Called on the MAIN THREAD every 100 ms.
        Drains msg_queue and dispatches each packet to the correct handler.
        Then reschedules itself.
        """
        try:
            while True:
                data = self.msg_queue.get_nowait()
                self._dispatch(data)
        except queue.Empty:
            pass
        self.root.after(100, self._process_queue)

    def _dispatch(self, data: dict):
        """Route an incoming packet to the right display/update function."""
        t = data.get("type", "")

        if   t == "chat":           self._display_chat(data)
        elif t == "file":           self._display_file_message(data)
        elif t == "system":         self._display_system(data.get("body", ""))
        elif t == "userlist":       self._update_user_list(data.get("users", []))
        elif t == "search_results": self._display_search_results(data)
        elif t == "status":         self._handle_status_update(data)
        elif t == "typing":         self._handle_typing(data)
        elif t == "_disconnected":  self._handle_disconnect()

    def _handle_status_update(self, data: dict):
        """Update a message's tick mark when the server tells us it was delivered/seen."""
        self._update_tick(data.get("msg_id", ""), data.get("status", ""))

    def _handle_typing(self, data: dict):
        """
        Show 'X is typing…' and auto-hide it after 3 seconds.
        Uses root.after() to schedule the hide — cancels previous timer if
        another typing event arrives before the 3 seconds are up.
        """
        sender = data.get("sender", "")
        if not hasattr(self, "lbl_typing"):
            return

        self.lbl_typing.config(text=f"{sender} is typing…")

        if self._typing_hide_job:
            self.root.after_cancel(self._typing_hide_job)

        self._typing_hide_job = self.root.after(
            3000, lambda: self.lbl_typing.config(text="")
        )

    def _handle_disconnect(self):
        """Called when the server closes the connection."""
        self.connected = False
        self._display_system("Disconnected from server.")
        if hasattr(self, "btn_send"):
            self.btn_send.config(state=tk.DISABLED)
        if hasattr(self, "msg_entry"):
            self.msg_entry.config(state=tk.DISABLED)
        if hasattr(self, "btn_attach"):
            self.btn_attach.config(state=tk.DISABLED)

    # =========================================================================
    # SOCKET HELPER
    # =========================================================================

    @staticmethod
    def _read_line(sock: socket.socket) -> str:
        """Read one newline-terminated message. Returns '' on closed socket."""
        data = b""
        while True:
            try:
                byte = sock.recv(1)
            except OSError:
                return ""
            if not byte or byte == b"\n":
                break
            data += byte
        return data.decode("utf-8", errors="replace")

    # =========================================================================
    # WINDOW CLOSE
    # =========================================================================

    def _on_close(self):
        """
        Gracefully shut down when the user clicks the X button.
        Closing the socket unblocks recv() in the receive thread so it exits.
        """
        self.connected = False
        if self.sock:
            try:
                self.sock.shutdown(socket.SHUT_RDWR)
                self.sock.close()
            except OSError:
                pass
        self.root.destroy()


# =============================================================================
# Entry point
# =============================================================================

if __name__ == "__main__":
    IMClient()
