"""Short-lived in-memory transcript storage for incognito chats."""

import logging
import threading
import time
from typing import Any

logger = logging.getLogger(__name__)

INCOGNITO_CONTEXTS: dict[tuple[str, str], dict[str, Any]] = {}
INCOGNITO_CONTEXT_LOCK = threading.RLock()
OWNER_UNSET = object()
_CONTEXT_TTL_SECONDS = 6 * 60 * 60
_CONTEXT_MAX_MESSAGES = 80


def _key(session_id: str, owner: Any) -> tuple[str, str]:
    return str(owner or ""), str(session_id or "")


def session_matches_owner(session_id: str, owner: Any) -> bool:
    """Fail closed unless the durable session exists with the supplied owner."""
    if owner is OWNER_UNSET:
        return False
    db = None
    try:
        from core.database import Session as DBSession, SessionLocal

        db = SessionLocal()
        row = db.query(DBSession.owner).filter(DBSession.id == str(session_id)).first()
        return row is not None and str(row[0] or "") == str(owner or "")
    except Exception:
        logger.warning("Could not validate incognito session %s", session_id, exc_info=True)
        return False
    finally:
        if db is not None:
            db.close()


def _prune(now: float | None = None) -> None:
    now = now or time.time()
    stale = [
        key for key, bundle in INCOGNITO_CONTEXTS.items()
        if now - float(bundle.get("updated_at") or 0) > _CONTEXT_TTL_SECONDS
    ]
    for key in stale:
        INCOGNITO_CONTEXTS.pop(key, None)


def incognito_messages(session_id: str, *, owner: Any = OWNER_UNSET) -> list[dict[str, Any]]:
    sid = str(session_id or "")
    if not sid:
        return []
    with INCOGNITO_CONTEXT_LOCK:
        _prune()
        if not session_matches_owner(sid, owner):
            return []
        bundle = INCOGNITO_CONTEXTS.get(_key(sid, owner))
        if not bundle:
            return []
        return [dict(message) for message in bundle.get("messages", []) if isinstance(message, dict)]


def append_incognito_message(
    session_id: str,
    role: str,
    content: Any,
    metadata: dict | None = None,
    *,
    owner: Any = OWNER_UNSET,
) -> None:
    sid = str(session_id or "").strip()
    if not sid:
        return
    with INCOGNITO_CONTEXT_LOCK:
        _prune()
        if not session_matches_owner(sid, owner):
            return
        bundle = INCOGNITO_CONTEXTS.setdefault(_key(sid, owner), {"messages": [], "updated_at": time.time()})
        message: dict[str, Any] = {"role": role, "content": content}
        if metadata:
            message["metadata"] = dict(metadata)
        messages = bundle.setdefault("messages", [])
        messages.append(message)
        if len(messages) > _CONTEXT_MAX_MESSAGES:
            del messages[:-_CONTEXT_MAX_MESSAGES]
        bundle["updated_at"] = time.time()


def clear_incognito_context(session_id: str, owner: Any = None) -> None:
    with INCOGNITO_CONTEXT_LOCK:
        INCOGNITO_CONTEXTS.pop(_key(session_id, owner), None)
