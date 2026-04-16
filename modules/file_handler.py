# =============================================================================
# modules/file_handler.py  —  File Transfer Helpers
# =============================================================================
#
# HOW FILE SHARING WORKS:
#
#   Binary files cannot be sent as raw bytes inside a JSON string because
#   JSON only supports UTF-8 text.  We solve this with Base64 encoding:
#
#     Raw bytes (any file)
#         ↓  base64.b64encode()
#     ASCII string (safe inside JSON)
#         ↓  json.dumps()
#     JSON packet  →  sent over TCP
#
#   The receiver does the reverse:
#
#     JSON packet  →  json.loads()
#         ↓  base64.b64decode()
#     Original raw bytes  →  saved to disk
#
# FILE SIZE LIMIT:
#   We cap file transfers at MAX_FILE_BYTES (10 MB).
#   Larger files would make the JSON packet enormous and slow down
#   the entire server.  In a real app you would use a separate file
#   upload protocol (e.g. HTTP), but 10 MB is fine for a student project.
#
# STORAGE:
#   The server saves every received file into the  uploads/  folder
#   with a unique name (original name + msg_id prefix) to avoid collisions.
# =============================================================================

import base64
import os
import mimetypes

# ─── Configuration ────────────────────────────────────────────────────────────

# Absolute path so uploads/ is always created inside the project root,
# regardless of which directory the user runs `python server.py` from.
_MODULE_DIR    = os.path.dirname(os.path.abspath(__file__))
UPLOADS_DIR    = os.path.join(_MODULE_DIR, '..', 'uploads')
MAX_FILE_BYTES = 10 * 1024 * 1024   # 10 MB

# Allowlist of safe file extensions.
# SVG is intentionally excluded — it can contain embedded JavaScript.
# Executable / script extensions (exe, py, sh, php, js, …) are also excluded.
ALLOWED_EXTENSIONS = {
    # Images
    'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'tiff',
    # Documents
    'pdf', 'txt', 'md', 'csv',
    'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp',
    # Archives
    'zip', 'tar', 'gz', '7z', 'rar',
    # Audio / Video
    'mp3', 'wav', 'ogg', 'flac', 'aac',
    'mp4', 'webm', 'avi', 'mov', 'mkv',
}


# ─── Setup ────────────────────────────────────────────────────────────────────

def ensure_uploads_dir():
    """Create the uploads/ folder if it does not already exist."""
    os.makedirs(UPLOADS_DIR, exist_ok=True)


# ─── Encoding (client → server) ───────────────────────────────────────────────

def encode_file(file_path: str) -> tuple[str, str, int]:
    """
    Read a file from disk and return (filename, base64_string, size_bytes).

    Raises ValueError if the file exceeds MAX_FILE_BYTES.
    Raises FileNotFoundError if the path does not exist.
    """
    if not os.path.isfile(file_path):
        raise FileNotFoundError(f"File not found: {file_path}")

    size = os.path.getsize(file_path)
    if size > MAX_FILE_BYTES:
        mb = MAX_FILE_BYTES // (1024 * 1024)
        raise ValueError(f"File is too large ({size // 1024} KB).  Limit is {mb} MB.")

    with open(file_path, "rb") as f:
        raw_bytes = f.read()

    filename  = os.path.basename(file_path)
    b64_str   = base64.b64encode(raw_bytes).decode("ascii")
    return filename, b64_str, size


# ─── Decoding & saving (server side) ─────────────────────────────────────────

import re

def save_file_from_b64(msg_id: str, filename: str, b64_data: str) -> str:
    """
    Decode a base64 string and save the resulting bytes into uploads/.
    Includes robust path traversal and sanitization checks.
    """
    ensure_uploads_dir()

    # Extract filename and validate
    safe_name = os.path.basename(filename)
    
    # Remove all potentially dangerous characters
    safe_name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', '_', safe_name)
    safe_name = re.sub(r'^\.+', '_', safe_name)  # Remove leading dots
    safe_name = safe_name.replace('..', '_')
    
    if not safe_name or len(safe_name) > 255:
        safe_name = "file"

    # Enforce extension allowlist — rejects SVG (can embed JS), executables,
    # scripts, and any other type not explicitly permitted.
    _ext = safe_name.rsplit('.', 1)[-1].lower() if '.' in safe_name else ''
    if _ext not in ALLOWED_EXTENSIONS:
        raise ValueError(
            f"File type '.{_ext}' is not allowed. "
            f"Permitted types: {', '.join(sorted(ALLOWED_EXTENSIONS))}"
        )

    # Prefix with msg_id so two people can send files with the same name
    stored_name = f"{msg_id[:8]}_{safe_name}"
    full_path   = os.path.join(UPLOADS_DIR, stored_name)

    # Security check: ensure the resolved path is within UPLOADS_DIR
    real_path = os.path.realpath(full_path)
    real_uploads = os.path.realpath(UPLOADS_DIR)
    
    if not real_path.startswith(real_uploads):
        raise ValueError("Invalid file path")

    raw_bytes = base64.b64decode(b64_data)

    with open(real_path, "wb") as f:
        f.write(raw_bytes)

    return real_path


# ─── Client-side saving ────────────────────────────────────────────────────────

def decode_file(b64_data: str) -> bytes:
    """
    Decode a base64 string back to raw bytes.
    The client calls this when the user clicks 'Save File'.
    """
    return base64.b64decode(b64_data)


def human_readable_size(num_bytes: int) -> str:
    """Format a byte count as a human-readable string: '2.4 MB', '345 KB'."""
    if num_bytes < 1024:
        return f"{num_bytes} B"
    elif num_bytes < 1024 * 1024:
        return f"{num_bytes / 1024:.1f} KB"
    else:
        return f"{num_bytes / (1024 * 1024):.1f} MB"
