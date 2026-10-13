"""Small durable checkpoints for detached agent runs."""
from __future__ import annotations

import json
import logging
import os
import re
import sqlite3
import time
from pathlib import Path
from typing import Any, Optional

from src.constants import DATA_DIR

logger = logging.getLogger(__name__)

_MAX_TEXT = 32_000
_MAX_OUTCOMES = 64
_MAX_RUNS_PER_SESSION = 10


def _clip(value: Any, limit: int = 4_000) -> str:
    return str(value or "")[:limit]


def checkpoint_event(event: str) -> dict:
    """Extract bounded recovery metadata from one SSE event."""
    result: dict = {"event_count": 1}
    if not event.startswith("data: "):
        return result
    raw = event[6:].split("\n", 1)[0].strip()
    if raw == "[DONE]":
        result["last_event"] = "done"
        return result
    try:
        item = json.loads(raw)
    except (ValueError, TypeError):
        return result
    if not isinstance(item, dict):
        return result
    kind = item.get("type")
    if kind in (None, "delta") and isinstance(item.get("delta"), str):
        result["output_delta"] = item["delta"]
    if kind == "tool_output":
        outcome = {
            key: _clip(item[key]) if key in {"tool", "command", "output"} else item[key]
            for key in ("tool", "command", "output", "exit_code", "doc_id", "document_action", "document_version")
            if key in item and isinstance(item[key], (str, int, float, bool, type(None)))
        }
        result["tool_outcome"] = outcome
        result["clear_pending_tool"] = True
    elif kind == "metrics":
        data = item.get("data")
        refs = []
        if isinstance(data, dict) and isinstance(data.get("tool_events"), list):
            for event in data["tool_events"]:
                if not isinstance(event, dict) or event.get("tool") != "web_fetch":
                    continue
                result_id = event.get("context_result_id")
                source_url = event.get("context_source_url")
                if (type(event.get("exit_code")) is int and event["exit_code"] == 0
                        and isinstance(result_id, str)
                        and re.fullmatch(r"[0-9a-f]{32}", result_id)):
                    ref = {"tool_name": "web_fetch", "result_id": result_id}
                    if (
                        isinstance(source_url, str)
                        and source_url.startswith(("http://", "https://"))
                        and len(source_url) <= 2_048
                        and not any(ord(char) < 32 for char in source_url)
                    ):
                        ref["source_url"] = source_url
                    refs.append(ref)
        if refs:
            result["tool_result_refs"] = refs[-64:]
    elif kind == "tool_start":
        result["pending_tool"] = {
            key: _clip(item[key], 512)
            for key in ("tool", "command") if isinstance(item.get(key), str)
        }
    if kind:
        result["last_event"] = _clip(kind, 80)
    return result


def text_delta(event: str) -> Optional[str]:
    """Return assistant text carried by an SSE data event, if any."""
    change = checkpoint_event(event)
    delta = change.get("output_delta")
    return delta if isinstance(delta, str) else None


class CheckpointStore:
    """SQLite store; every write is a small atomic upsert, keyed by opaque run id."""

    def __init__(self, path: Optional[str] = None, *, recover_on_open: bool = True):
        self.path = path or os.getenv(
            "ODYSSEUS_RUN_CHECKPOINTS_DB", os.path.join(DATA_DIR, "agent_runs.db")
        )
        Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as db:
            db.execute(
                "CREATE TABLE IF NOT EXISTS agent_run_checkpoints ("
                "run_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, owner TEXT NOT NULL, "
                "status TEXT NOT NULL, payload TEXT NOT NULL, updated REAL NOT NULL)"
            )
            db.execute(
                "CREATE INDEX IF NOT EXISTS idx_agent_run_session_owner "
                "ON agent_run_checkpoints(session_id, owner, updated)"
            )
            if recover_on_open:
                db.execute(
                    "UPDATE agent_run_checkpoints SET status='interrupted', updated=? "
                    "WHERE status='running'", (time.time(),)
                )
        if os.name == "posix":
            os.chmod(self.path, 0o600)

    def _connect(self):
        db = sqlite3.connect(self.path, timeout=5)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA busy_timeout=5000")
        return db

    def begin(self, run_id: str, session_id: str, owner: Optional[str], context=None) -> None:
        context = context if isinstance(context, dict) else {}
        saved_context = {
            key: _clip(context.get(key), limit)
            for key, limit in {
                "original_request": 50_000,
                "workspace": 32_768,
                "model": 256, "endpoint_id": 256, "endpoint_url": 2_048,
                "chat_mode": 16,
            }.items() if isinstance(context.get(key), str)
        }
        original_request = context.get("original_request")
        if isinstance(original_request, str):
            completeness = context.get("original_request_complete")
            if isinstance(completeness, bool):
                saved_context["original_request_complete"] = (
                    completeness and len(original_request) <= 50_000
                )
            elif "original_request_complete" in context:
                # None carries the unknown state from a pre-marker legacy
                # checkpoint; do not turn its clipped prefix into a claim.
                saved_context["original_request_complete"] = None
            else:
                saved_context["original_request_complete"] = len(original_request) <= 50_000
        if isinstance(context.get("plan_mode"), bool):
            saved_context["plan_mode"] = context["plan_mode"]
        payload = {
            "last_output": "", "tool_outcomes": [], "event_count": 0,
            "context": saved_context,
        }
        with self._connect() as db:
            db.execute(
                "INSERT OR REPLACE INTO agent_run_checkpoints "
                "(run_id, session_id, owner, status, payload, updated) VALUES (?, ?, ?, 'running', ?, ?)",
                (run_id, session_id, str(owner or ""), json.dumps(payload), time.time()),
            )
            db.execute(
                "DELETE FROM agent_run_checkpoints WHERE session_id=? AND owner=? AND run_id NOT IN ("
                "SELECT run_id FROM agent_run_checkpoints WHERE session_id=? AND owner=? "
                "ORDER BY updated DESC LIMIT ?)",
                (session_id, str(owner or ""), session_id, str(owner or ""), _MAX_RUNS_PER_SESSION),
            )

    def record(self, run_id: str, event: str) -> None:
        change = checkpoint_event(event)
        with self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute(
                "SELECT payload FROM agent_run_checkpoints WHERE run_id=?", (run_id,)
            ).fetchone()
            if row is None:
                return
            try:
                payload = json.loads(row["payload"])
                if not isinstance(payload, dict):
                    payload = {}
            except (ValueError, TypeError):
                # A damaged checkpoint cannot be used to replay prior actions.
                payload = {"corrupt": True, "last_output": "", "tool_outcomes": [], "event_count": 0}
            payload["event_count"] = min(1_000_000, int(payload.get("event_count", 0)) + 1)
            if change.get("last_event"):
                payload["last_event"] = change["last_event"]
            if "output_delta" in change:
                payload["last_output"] = (str(payload.get("last_output", "")) + change["output_delta"])[-_MAX_TEXT:]
            if "tool_outcome" in change:
                outcomes = payload.setdefault("tool_outcomes", [])
                if not isinstance(outcomes, list):
                    outcomes = payload["tool_outcomes"] = []
                outcomes.append(change["tool_outcome"])
                del outcomes[:-_MAX_OUTCOMES]
            if "tool_result_refs" in change:
                refs = payload.setdefault("tool_result_refs", [])
                if not isinstance(refs, list):
                    refs = payload["tool_result_refs"] = []
                seen = {ref.get("result_id") for ref in refs if isinstance(ref, dict)}
                refs.extend(ref for ref in change["tool_result_refs"]
                            if ref["result_id"] not in seen)
                del refs[:-64]
            if "pending_tool" in change:
                payload["pending_tool"] = change["pending_tool"]
            if change.get("clear_pending_tool"):
                payload.pop("pending_tool", None)
            db.execute(
                "UPDATE agent_run_checkpoints SET payload=?, updated=? WHERE run_id=?",
                (json.dumps(payload, ensure_ascii=False), time.time(), run_id),
            )

    def record_delta(self, run_id: str, delta: str) -> None:
        if not delta:
            return
        with self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute(
                "SELECT payload FROM agent_run_checkpoints WHERE run_id=?", (run_id,)
            ).fetchone()
            if row is None:
                return
            try:
                payload = json.loads(row["payload"])
                if not isinstance(payload, dict):
                    payload = {}
            except (ValueError, TypeError):
                payload = {"corrupt": True, "last_output": "", "tool_outcomes": [], "event_count": 0}
            payload["last_output"] = (str(payload.get("last_output", "")) + delta)[-_MAX_TEXT:]
            payload["event_count"] = min(1_000_000, int(payload.get("event_count", 0)) + 1)
            db.execute(
                "UPDATE agent_run_checkpoints SET payload=?, updated=? WHERE run_id=?",
                (json.dumps(payload, ensure_ascii=False), time.time(), run_id),
            )

    def record_coding_work(self, run_id: str, session_id: str, owner: Optional[str], state: dict) -> bool:
        return self._record_coding_state(run_id, session_id, owner, state, "coding_work_packet")

    def record_coding_grounding(self, run_id: str, session_id: str, owner: Optional[str], state: dict) -> bool:
        return self._record_coding_state(run_id, session_id, owner, state, "coding_grounding")

    def _record_coding_state(self, run_id, session_id, owner, state, field):
        """Save server-observed evidence in its exact run/session scope."""
        if not all(isinstance(value, str) and value.strip() for value in (run_id, session_id)):
            return False
        try:
            encoded_state = json.dumps(state, ensure_ascii=False)
        except (TypeError, ValueError):
            return False
        if not isinstance(state, dict) or len(encoded_state) > 64_000:
            return False
        with self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute(
                "SELECT payload FROM agent_run_checkpoints "
                "WHERE run_id=? AND session_id=? AND owner=?",
                (run_id, session_id, str(owner or "")),
            ).fetchone()
            if row is None:
                return False
            try:
                payload = json.loads(row["payload"])
                if not isinstance(payload, dict) or payload.get("corrupt"):
                    return False
            except (ValueError, TypeError):
                return False
            payload[field] = json.loads(encoded_state)
            db.execute(
                "UPDATE agent_run_checkpoints SET payload=?, updated=? "
                "WHERE run_id=? AND session_id=? AND owner=?",
                (json.dumps(payload, ensure_ascii=False), time.time(), run_id, session_id, str(owner or "")),
            )
        return True

    def finish(self, run_id: str, status: str) -> None:
        if status not in {"done", "error", "stopped", "interrupted", "continued"}:
            return
        with self._connect() as db:
            db.execute(
                "UPDATE agent_run_checkpoints SET status=?, updated=? WHERE run_id=?",
                (status, time.time(), run_id),
            )

    def get(self, session_id: str, owner: Optional[str]) -> Optional[dict]:
        with self._connect() as db:
            row = db.execute(
                "SELECT run_id, status, payload, updated FROM agent_run_checkpoints "
                "WHERE session_id=? AND owner=? ORDER BY updated DESC LIMIT 1",
                (session_id, str(owner or "")),
            ).fetchone()
        if row is None:
            return None
        try:
            payload = json.loads(row["payload"])
            if not isinstance(payload, dict):
                raise ValueError("checkpoint is not an object")
        except (ValueError, TypeError):
            payload = {"corrupt": True, "last_output": "", "tool_outcomes": [], "event_count": 0}
            return {
                "run_id": row["run_id"], "status": "corrupt", "updated": row["updated"],
                **payload, "can_continue": False, "replay_tools": False,
            }
        status = row["status"]
        if payload.get("corrupt"):
            status = "corrupt"
        return {
            "run_id": row["run_id"], "status": status, "updated": row["updated"],
            **payload, "can_continue": status == "interrupted", "replay_tools": False,
            "uncertain_tool_outcome": bool(payload.get("pending_tool")) and status in {"interrupted", "stopped", "error"},
        }

    def get_run(self, run_id: str, session_id: str, owner: Optional[str]) -> Optional[dict]:
        """Read one exact run checkpoint within its owner/session scope."""
        if not all(isinstance(value, str) and value.strip()
                   for value in (run_id, session_id)):
            return None
        with self._connect() as db:
            row = db.execute(
                "SELECT run_id, session_id, owner, status, payload, updated FROM agent_run_checkpoints "
                "WHERE run_id=? AND session_id=? AND owner=?",
                (run_id, session_id, str(owner or "")),
            ).fetchone()
        if row is None:
            return None
        try:
            payload = json.loads(row["payload"])
            if not isinstance(payload, dict) or payload.get("corrupt"):
                return None
        except (ValueError, TypeError):
            return None
        # Payload is recovery data, never authority for the checkpoint's
        # identity or lifecycle state. Put canonical columns last so even a
        # damaged/legacy payload cannot redirect a scoped lookup.
        return {**payload, "run_id": row["run_id"], "session_id": row["session_id"],
                "owner": row["owner"], "status": row["status"], "updated": row["updated"]}

    def claim_recovery(self, session_id: str, owner: Optional[str], run_id: str) -> Optional[dict]:
        """Consume one explicit recovery request; concurrent repeats fail closed."""
        with self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute(
                "SELECT status, payload FROM agent_run_checkpoints "
                "WHERE run_id=? AND session_id=? AND owner=?",
                (run_id, session_id, str(owner or "")),
            ).fetchone()
            if row is None or row["status"] != "interrupted":
                return None
            try:
                payload = json.loads(row["payload"])
                if not isinstance(payload, dict) or payload.get("corrupt"):
                    return None
            except (ValueError, TypeError):
                return None
            now = time.time()
            updated = db.execute(
                "UPDATE agent_run_checkpoints SET status='continued', updated=? "
                "WHERE run_id=? AND session_id=? AND owner=? AND status='interrupted'",
                (now, run_id, session_id, str(owner or "")),
            )
            if updated.rowcount != 1:
                return None
        return {
            "run_id": run_id, "status": "continued", "updated": now,
            **payload, "can_continue": False, "replay_tools": False,
        }

    def delete_session(self, session_id: str, owner: Optional[str]) -> None:
        with self._connect() as db:
            db.execute(
                "DELETE FROM agent_run_checkpoints WHERE session_id=? AND owner=?",
                (session_id, str(owner or "")),
            )


_STORE = CheckpointStore()


def begin(run_id: str, session_id: str, owner: Optional[str] = None, context=None) -> None:
    try:
        _STORE.begin(run_id, session_id, owner, context)
    except Exception:
        logger.exception("Could not create agent run checkpoint")


def record(run_id: str, event: str) -> None:
    try:
        _STORE.record(run_id, event)
    except Exception:
        logger.exception("Could not update agent run checkpoint")


def record_delta(run_id: str, delta: str) -> None:
    try:
        _STORE.record_delta(run_id, delta)
    except Exception:
        logger.exception("Could not checkpoint agent output")


def record_coding_work(run_id: str, session_id: str, owner: Optional[str], state: dict) -> bool:
    try:
        return _STORE.record_coding_work(run_id, session_id, owner, state)
    except Exception:
        logger.exception("Could not checkpoint coding work packet")
        return False


def record_coding_grounding(run_id: str, session_id: str, owner: Optional[str], state: dict) -> bool:
    try:
        return _STORE.record_coding_grounding(run_id, session_id, owner, state)
    except Exception:
        logger.exception("Could not checkpoint coding grounding")
        return False


def finish(run_id: str, status: str) -> None:
    try:
        _STORE.finish(run_id, status)
    except Exception:
        logger.exception("Could not finalize agent run checkpoint")


def get_checkpoint(session_id: str, owner: Optional[str] = None) -> Optional[dict]:
    try:
        return _STORE.get(session_id, owner)
    except Exception:
        logger.exception("Could not read agent run checkpoint")
        return None


def get_run_checkpoint(run_id: str, session_id: str, owner: Optional[str] = None) -> Optional[dict]:
    try:
        return _STORE.get_run(run_id, session_id, owner)
    except Exception:
        logger.exception("Could not read exact agent run checkpoint")
        return None


def claim_recovery(session_id: str, owner: Optional[str], run_id: str) -> Optional[dict]:
    try:
        return _STORE.claim_recovery(session_id, owner, run_id)
    except Exception:
        logger.exception("Could not claim agent run recovery")
        return None


def delete_session(session_id: str, owner: Optional[str] = None) -> None:
    try:
        _STORE.delete_session(session_id, owner)
    except Exception:
        logger.exception("Could not delete agent run checkpoints")
