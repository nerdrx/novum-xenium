"""Owner-scoped run metadata. Commands, prompts, tokens and tool output stay out."""
from __future__ import annotations

import json
import logging
import os
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path

from src.constants import DATA_DIR

logger = logging.getLogger(__name__)


@contextmanager
def _db():
    path = Path(os.getenv("ODYSSEUS_RUN_EVIDENCE_DB", str(Path(DATA_DIR) / "run_evidence.db")))
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path, timeout=5)
    os.chmod(path, 0o600)
    db.row_factory = sqlite3.Row
    db.executescript("""
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, session TEXT NOT NULL, owner TEXT NOT NULL,
        model TEXT, started REAL, finished REAL, status TEXT, events TEXT NOT NULL DEFAULT '[]'
      );
      CREATE INDEX IF NOT EXISTS run_scope ON runs(owner,session,started);
    """)
    try:
        with db:
            yield db
    finally:
        db.close()


def begin(run_id, session_id, owner, context=None):
    try:
        with _db() as db:
            db.execute("INSERT OR IGNORE INTO runs(id,session,owner,model,started,status) VALUES(?,?,?,?,?,'running')",
                       (run_id, session_id, owner or "", str((context or {}).get("model", ""))[:256], time.time()))
            db.execute("DELETE FROM runs WHERE owner=? AND session=? AND id NOT IN "
                       "(SELECT id FROM runs WHERE owner=? AND session=? ORDER BY started DESC LIMIT 20)",
                       (owner or "", session_id, owner or "", session_id))
    except Exception:
        logger.warning("Could not begin run evidence", exc_info=True)


def record(run_id, event):
    raw = next((line[6:] for line in event.splitlines() if line.startswith("data: ")), None)
    if not raw or raw == "[DONE]":
        return
    try:
        item = json.loads(raw)
        if not isinstance(item, dict):
            return
        kind = "error" if "error" in item or item.get("type") in {"agent_terminal", "chat_terminal"} else item.get("type")
        if kind not in {"tool_start", "tool_output", "error", "verification"}:
            return
        entry = {"type": kind, "at": time.time()}
        # No command/output/error text: it can contain credentials and private files.
        for key in ("tool", "exit_code", "status", "passed"):
            value = item.get(key)
            if isinstance(value, (str, int, bool)):
                entry[key] = value[:100] if isinstance(value, str) else value
        with _db() as db:
            row = db.execute("SELECT events FROM runs WHERE id=?", (run_id,)).fetchone()
            if row:
                events = (json.loads(row["events"]) + [entry])[-256:]
                db.execute("UPDATE runs SET events=? WHERE id=?", (json.dumps(events), run_id))
    except (ValueError, sqlite3.Error, OSError):
        logger.warning("Could not record run evidence", exc_info=True)


def finish(run_id, status):
    try:
        with _db() as db:
            db.execute("UPDATE runs SET status=?,finished=COALESCE(finished,?) WHERE id=?",
                       (status, time.time(), run_id))
    except (sqlite3.Error, OSError):
        logger.warning("Could not finish run evidence", exc_info=True)


def list_runs(session_id, owner):
    with _db() as db:
        rows = db.execute("SELECT * FROM runs WHERE session=? AND owner=? ORDER BY started DESC LIMIT 20",
                          (session_id, owner or "")).fetchall()
    return [{**dict(row), "events": json.loads(row["events"]),
             "duration_seconds": round((row["finished"] or time.time()) - row["started"], 2)} for row in rows]


def delete_session(session_id, owner):
    with _db() as db:
        db.execute("DELETE FROM runs WHERE session=? AND owner=?", (session_id, owner or ""))


def recover_interrupted():
    """Called once at application startup; never claim a lost process finished."""
    with _db() as db:
        db.execute("UPDATE runs SET status='interrupted',finished=? WHERE status='running'", (time.time(),))
