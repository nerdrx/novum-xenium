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
        kind = item.get("type")
        status = None
        payload = item.get("data") if isinstance(item.get("data"), dict) else {}
        if item.get("error") or (kind in {"agent_terminal", "chat_terminal"} and payload.get("failed")):
            kind, status = "terminal", "error"
        elif kind in {"agent_terminal", "chat_terminal"}:
            terminal_status = item.get("status") or payload.get("status")
            status = {
                "completed": "done", "done": "done", "success": "done",
                "failed": "error", "error": "error", "paused": "paused",
                "awaiting_approval": "awaiting_approval",
                "awaiting_input": "awaiting_input",
            }.get(terminal_status)
            if status:
                kind = "terminal"
        elif kind == "ask_user":
            ask = item.get("ask_user") or {}
            kind = "terminal"
            status = "awaiting_approval" if isinstance(ask, dict) and ask.get("kind") == "tool_approval" else "awaiting_input"
        elif kind == "loop_breaker_triggered":
            # A loop breaker can precede a successful synthesis terminal. Keep
            # it as an unresolved pause candidate until a later terminal event
            # confirms whether the run completed or remained paused.
            kind = "pause_candidate"
        elif kind in {"budget_exceeded", "rounds_exhausted", "intent_nudge_exhausted"}:
            kind = "paused"
        if kind not in {"tool_start", "tool_output", "error", "verification", "awaiting_approval", "awaiting_input", "paused", "pause_candidate", "terminal"}:
            return
        entry = {"type": kind, "at": time.time()}
        if status:
            entry["status"] = status
        # No command/output/error text: it can contain credentials and private files.
        for key in ("tool", "exit_code", "status", "passed"):
            if kind == "terminal" and key == "status":
                continue
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
            if status == "done":
                row = db.execute("SELECT events FROM runs WHERE id=?", (run_id,)).fetchone()
                events = json.loads(row["events"]) if row else []
                outcome = next((item for item in reversed(events)
                                if item.get("type") in {"terminal", "pause_candidate", "error", "awaiting_approval", "awaiting_input", "paused"}), None)
                if outcome:
                    if outcome.get("type") == "terminal":
                        status = outcome.get("status", status)
                    elif outcome.get("type") == "pause_candidate":
                        status = "paused"
                    else:
                        status = "error" if outcome["type"] == "error" else outcome["type"]
                elif any(item.get("type") == "verification" and item.get("passed") is False for item in events):
                    status = "unverified"
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
