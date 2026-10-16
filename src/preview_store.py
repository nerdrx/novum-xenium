"""Private, short-lived screenshots captured from chat preview events."""
from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import sqlite3
import threading
import time
import uuid
from contextlib import contextmanager
from pathlib import Path

from src.constants import DATA_DIR

_ROOT = Path(DATA_DIR) / "previews"
_DB = _ROOT / "history.sqlite3"
_TTL = 7 * 24 * 60 * 60
_MAX_IMAGE = 3 * 1024 * 1024
_MAX_OWNER_BYTES = 256 * 1024 * 1024
_MAX_TOTAL_BYTES = 1024 * 1024 * 1024
_LOCK = threading.RLock()
_UUID = re.compile(r"^[0-9a-f]{32}$")
_MIMES = {"image/png": (b"\x89PNG\r\n\x1a\n", ".png"),
          "image/jpeg": (b"\xff\xd8\xff", ".jpg"),
          "image/webp": (b"RIFF", ".webp")}


def _connect():
    _DB.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if _DB.parent.is_symlink() or _DB.is_symlink():
        raise OSError("Preview history path cannot be a symlink")
    try:
        os.chmod(_DB.parent, 0o700)
    except OSError:
        pass
    conn = sqlite3.connect(_DB, timeout=5)
    conn.execute("PRAGMA secure_delete=ON")
    try:
        os.chmod(_DB, 0o600)
    except OSError:
        pass
    conn.execute("""CREATE TABLE IF NOT EXISTS previews (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, session_id TEXT NOT NULL,
        kind TEXT NOT NULL, title TEXT NOT NULL, mime TEXT NOT NULL,
        digest TEXT NOT NULL, image BLOB NOT NULL, created REAL NOT NULL,
        expires REAL NOT NULL, UNIQUE(owner, session_id, digest))""")
    conn.execute("CREATE INDEX IF NOT EXISTS previews_scope ON previews(owner, session_id, created DESC)")
    return conn


@contextmanager
def _connection():
    conn = _connect()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def _valid_image(data: str, mime: str) -> bytes | None:
    spec = _MIMES.get(mime)
    if not spec or not isinstance(data, str) or len(data) > (_MAX_IMAGE * 4 // 3 + 8):
        return None
    try:
        raw = base64.b64decode(data, validate=True)
    except (ValueError, TypeError):
        return None
    if not raw or len(raw) > _MAX_IMAGE or not raw.startswith(spec[0]):
        return None
    if mime == "image/webp" and raw[8:12] != b"WEBP":
        return None
    return raw


def cleanup(now: float | None = None) -> int:
    now = time.time() if now is None else now
    with _LOCK:
        with _connection() as conn:
            cur = conn.execute("DELETE FROM previews WHERE expires <= ?", (now,))
            removed = cur.rowcount
        if removed:
            conn = _connect()
            try:
                try:
                    conn.execute("VACUUM")
                except sqlite3.OperationalError:
                    pass  # Another server process may briefly hold a read lock.
            finally:
                conn.close()
        return removed


def add(owner: str, session_id: str, kind: str, title: str, mime: str,
        data: str, now: float | None = None, *, reject_deleting: bool = False) -> dict | None:
    if not isinstance(owner, str) or not owner.strip() or not isinstance(session_id, str) or not session_id.strip():
        return None
    if kind not in {"browser", "desktop"}:
        return None
    image = _valid_image(data, mime)
    if image is None:
        return None
    now = time.time() if now is None else now
    digest = hashlib.sha256(image).hexdigest()
    with _LOCK:
        if reject_deleting:
            try:
                from src.agent_runs import _session_deletion_pending
                if _session_deletion_pending(session_id):
                    return None
            except ImportError:
                pass
        with _connection() as conn:
            conn.execute("DELETE FROM previews WHERE expires <= ?", (now,))
            existing = conn.execute(
                "SELECT id FROM previews WHERE owner=? AND session_id=? AND digest=?",
                (owner, session_id, digest),
            ).fetchone()
            if existing:
                conn.execute("UPDATE previews SET created=?, expires=?, kind=?, title=? WHERE id=?",
                              (now, now + _TTL, kind, str(title)[:200], existing[0]))
                preview_id = existing[0]
            else:
                preview_id = uuid.uuid4().hex
                conn.execute("INSERT INTO previews VALUES(?,?,?,?,?,?,?,?,?,?)",
                             (preview_id, owner, session_id, kind, str(title)[:200], mime,
                              digest, image, now, now + _TTL))
            # Evict oldest entries to bound both account and app storage.
            for scope, limit, max_count in (("owner", _MAX_OWNER_BYTES, 500), ("all", _MAX_TOTAL_BYTES, 2000)):
                while True:
                    where = "owner=?" if scope == "owner" else "1=1"
                    args = (owner,) if scope == "owner" else ()
                    total, count = conn.execute(f"SELECT COALESCE(SUM(length(image)),0),COUNT(*) FROM previews WHERE {where}", args).fetchone()
                    if total <= limit and count <= max_count:
                        break
                    oldest = conn.execute(f"SELECT id FROM previews WHERE {where} ORDER BY created ASC LIMIT 1", args).fetchone()
                    if not oldest or oldest[0] == preview_id:
                        conn.execute("DELETE FROM previews WHERE id=?", (preview_id,))
                        return None
                    conn.execute("DELETE FROM previews WHERE id=?", (oldest[0],))
            row = conn.execute("SELECT id,kind,title,mime,created,expires FROM previews WHERE id=?", (preview_id,)).fetchone()
    return _row_dict(row)


def _row_dict(row) -> dict:
    preview_id, kind, title, mime, created, expires = row
    return {"id": preview_id, "kind": kind, "title": title, "mime": mime,
            "created_at": int(created), "expires_at": int(expires)}


def list_for(owner: str, session_id: str, limit: int = 30, offset: int = 0,
             now: float | None = None) -> tuple[list[dict], bool]:
    now = time.time() if now is None else now
    cleanup(now)
    with _LOCK, _connection() as conn:
        page_size = max(1, min(int(limit), 30))
        offset = max(0, min(int(offset), 2000))
        rows = conn.execute(
            "SELECT id,kind,title,mime,created,expires FROM previews WHERE owner=? AND session_id=? AND expires>? ORDER BY created DESC LIMIT ? OFFSET ?",
            (owner, session_id, now, page_size + 1, offset),
        ).fetchall()
    return [_row_dict(row) for row in rows[:page_size]], len(rows) > page_size


def get(owner: str, session_id: str, preview_id: str, now: float | None = None) -> tuple[bytes, str] | None:
    if not _UUID.fullmatch(str(preview_id)):
        return None
    now = time.time() if now is None else now
    cleanup(now)
    with _LOCK, _connection() as conn:
        row = conn.execute("SELECT image,mime FROM previews WHERE id=? AND owner=? AND session_id=? AND expires>?",
                           (preview_id, owner, session_id, now)).fetchone()
    return (bytes(row[0]), row[1]) if row else None


def delete_session(session_id: str) -> int:
    with _LOCK:
        with _connection() as conn:
            cur = conn.execute("DELETE FROM previews WHERE session_id=?", (session_id,))
            removed = cur.rowcount
        if removed:
            conn = _connect()
            try:
                try:
                    conn.execute("VACUUM")
                except sqlite3.OperationalError:
                    pass
            finally:
                conn.close()
        return removed


def record_sse_preview(owner: str | None, session_id: str, event: str) -> dict | None:
    """Persist actual preview payloads from the single server-side SSE drain."""
    if not owner or len(event) > 5 * 1024 * 1024 or not any(key in event for key in ("browser_preview", "native_preview")):
        return None
    try:
        payload = next((line[6:] for line in event.splitlines() if line.startswith("data: ")), None)
        value = json.loads(payload) if payload else None
    except (ValueError, TypeError):
        return None
    if not isinstance(value, dict):
        return None
    browser = value.get("browser_preview")
    if isinstance(browser, dict) and browser.get("state") == "updated":
        image = browser.get("screenshot", "")
        match = re.fullmatch(r"data:(image/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})", image) if isinstance(image, str) else None
        if match:
            return add(owner, session_id, "browser", str(browser.get("title") or "Browser preview"), match[1], match[2], reject_deleting=True)
    if value.get("tool") == "native_preview" and value.get("exit_code") == 0:
        image = value.get("screenshot", "")
        match = re.fullmatch(r"data:(image/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})", image) if isinstance(image, str) else None
        if match:
            return add(owner, session_id, "desktop", "Desktop preview", match[1], match[2], reject_deleting=True)
    return None
