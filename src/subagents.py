"""Owner-scoped metadata for delegated child chats."""

from __future__ import annotations

import json
import threading
from datetime import datetime, timezone, timedelta
from pathlib import Path

from core.atomic_io import atomic_write_json
from src.constants import DATA_DIR

_LOCK = threading.RLock()
_MAX_ACTIVE_PER_OWNER = 3
_MAX_ACTIVE_GLOBAL = 100
_MAX_RECORDS = 1000


def _recent_start(row):
    try:
        created = datetime.fromisoformat(str(row.get("created_at", "")))
        return datetime.now(timezone.utc) - created.astimezone(timezone.utc) < timedelta(minutes=2)
    except (TypeError, ValueError):
        return False


def _path():
    return Path(DATA_DIR) / "modules" / "subagents.json"


def _read():
    path = _path()
    if not path.exists():
        return {"children": []}
    try:
        state = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raise RuntimeError("Subagent registry is unreadable") from None
    if (not isinstance(state, dict) or not isinstance(state.get("children"), list)
            or any(not isinstance(row, dict) for row in state["children"])):
        raise RuntimeError("Subagent registry is invalid")
    return state


def _save(state):
    atomic_write_json(str(_path()), state, indent=2)


def _prune_deleted_sessions(state):
    ids = [str(row.get("session_id") or "") for row in state["children"]]
    if not ids:
        return
    db = None
    try:
        from core.database import Session as DbSession, SessionLocal
        db = SessionLocal()
        rows = db.query(DbSession.id).filter(DbSession.id.in_(ids)).all()
        live_ids = {str(row[0]) for row in rows}
        state["children"] = [row for row in state["children"] if str(row.get("session_id") or "") in live_ids]
    except Exception:
        # ponytail: keep all records if deletion cannot be verified; retaining
        # restrictions is safer than reclaiming space based on uncertain state.
        pass
    finally:
        if db is not None:
            db.close()


def register(record):
    with _LOCK:
        state = _read()
        _prune_deleted_sessions(state)
        if not any(row.get("session_id") == record["session_id"] for row in state["children"]) and len(state["children"]) >= _MAX_RECORDS:
            raise ValueError("The subagent history reached its 1000-chat limit; remove old child chats before spawning more")
        from src import agent_runs
        active_rows = [row for row in state["children"]
                       if agent_runs.is_active(str(row.get("session_id") or ""))
                       or (row.get("status") == "starting" and _recent_start(row))]
        if len(active_rows) >= _MAX_ACTIVE_GLOBAL:
            raise ValueError("The subagent service is at its active-run limit; try again later")
        if sum(str(row.get("owner") or "") == str(record.get("owner") or "")
               for row in active_rows) >= _MAX_ACTIVE_PER_OWNER:
            raise ValueError("At most three subagents can run at once for this account")
        state["children"] = [item for item in state["children"] if item.get("session_id") != record["session_id"]]
        state["children"].append(dict(record))
        _save(state)


def update_status(session_id, status):
    with _LOCK:
        state = _read()
        for item in state["children"]:
            if item.get("session_id") == session_id:
                item["status"] = status
                break
        _save(state)


def get_child(session_id, owner, parent_session_id=None):
    with _LOCK:
        item = next((row for row in _read()["children"]
                     if row.get("session_id") == session_id
                     and str(row.get("owner") or "") == str(owner or "")
                     and (parent_session_id is None or row.get("parent_session_id") == parent_session_id)), None)
        return dict(item) if item else None


def approval_resume_security(session_id, owner, *, approval_id=None, recovery_run_id=None):
    """Return the inherited envelope only for a registered approval continuation."""
    child = get_child(session_id, owner)
    if not child:
        return None
    if recovery_run_id or not approval_id:
        raise ValueError("Subagent chats accept only existing tool-approval controls")
    security = child.get("security")
    if not isinstance(security, dict):
        raise ValueError("Subagent approval security context is unavailable")
    return security


def list_subagents(owner, parent_session_id=None):
    with _LOCK:
        state = _read()
        rows = [dict(item) for item in state["children"]
                if str(item.get("owner") or "") == str(owner or "")
                and (parent_session_id is None or item.get("parent_session_id") == parent_session_id)]
        from src import agent_runs
        from src import run_checkpoints
        changed = False
        for item in rows:
            active = agent_runs.get_status(item["session_id"])
            if active:
                status = item.get("status") if active == "done" and item.get("status") in ("error", "waiting_approval") else active
            elif item.get("status") in ("running", "starting"):
                checkpoint = run_checkpoints.get_checkpoint(item["session_id"], owner)
                status = str((checkpoint or {}).get("status") or "interrupted")
            else:
                status = item.get("status") or "unknown"
            if item.get("status") != status:
                item["status"] = status
                changed = True
        if changed:
            by_id = {item["session_id"]: item["status"] for item in rows}
            for item in state["children"]:
                if item.get("session_id") in by_id:
                    item["status"] = by_id[item["session_id"]]
            _save(state)
        rows.sort(key=lambda item: str(item.get("created_at") or ""), reverse=True)
        return [{key: item.get(key) for key in ("session_id", "name", "status", "parent_session_id", "model")}
                for item in rows[:100]]


def subagents_enabled():
    from src.module_store import ModuleStore
    try:
        module = ModuleStore(DATA_DIR).get("subagents")
        return bool(module and module.get("enabled") and "subagents" in module.get("permissions", []))
    except Exception:
        return False
