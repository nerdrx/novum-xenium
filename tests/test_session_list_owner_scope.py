"""list_sessions must return only the authenticated user's sessions.

Regression for the enrichment query at routes/session_routes.py:265 which
previously fetched rows for all owners on every GET /api/sessions call.
"""
import sys
import tempfile
import types
import uuid
from datetime import timedelta

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import NullPool

import core.database as cdb
from core.database import ChatMessage as DbMessage
from core.database import Session as DbSession

_TMPDB = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_ENGINE = create_engine(
    f"sqlite:///{_TMPDB.name}",
    connect_args={"check_same_thread": False},
    poolclass=NullPool,
)
cdb.Base.metadata.create_all(_ENGINE)
_TS = sessionmaker(bind=_ENGINE, autoflush=False, autocommit=False)


def _stub_multipart_if_missing(monkeypatch):
    try:
        import python_multipart  # noqa: F401
        return
    except ImportError:
        pass
    stub = types.ModuleType("python_multipart")
    stub.__version__ = "0.0.20"
    monkeypatch.setitem(sys.modules, "python_multipart", stub)


def test_list_sessions_excludes_other_users_sessions(monkeypatch):
    import routes.session_routes as sr
    from unittest.mock import MagicMock

    _stub_multipart_if_missing(monkeypatch)
    monkeypatch.setattr(sr, "SessionLocal", _TS)
    monkeypatch.setattr(sr, "effective_user", lambda request: "alice")

    alice_id = str(uuid.uuid4())
    bob_id = str(uuid.uuid4())
    db = _TS()
    try:
        db.query(DbSession).delete()
        db.add(DbSession(id=alice_id, owner="alice", name="alice session",
                         endpoint_url="http://localhost", model="gpt-4", archived=False))
        db.add(DbSession(id=bob_id, owner="bob", name="bob session",
                         endpoint_url="http://localhost", model="gpt-4", archived=False))
        db.commit()
    finally:
        db.close()

    alice_session = MagicMock(id=alice_id, model="gpt-4", endpoint_url="http://localhost",
                              rag=False, archived=False)
    alice_session.name = "alice session"
    sm = MagicMock()
    sm.get_sessions_for_user.return_value = {alice_id: alice_session}
    router = sr.setup_session_routes(sm, {})
    endpoint = [r.endpoint for r in router.routes
                if getattr(r, "path", "") == "/api/sessions"
                and "GET" in getattr(r, "methods", set())][-1]

    result = endpoint(request=MagicMock())
    returned_ids = {s["id"] for s in result}
    assert alice_id in returned_ids
    assert bob_id not in returned_ids


def test_list_sessions_derives_only_owned_legacy_placeholder_titles(monkeypatch):
    import routes.session_routes as sr
    from unittest.mock import MagicMock

    _stub_multipart_if_missing(monkeypatch)
    monkeypatch.setattr(sr, "SessionLocal", _TS)
    monkeypatch.setattr(sr, "effective_user", lambda request: "alice")
    alice_id, bob_id, manual_id = [str(uuid.uuid4()) for _ in range(3)]
    db = _TS()
    try:
        db.query(DbMessage).delete()
        db.query(DbSession).delete()
        for sid, owner, name, custom in (
            (alice_id, "alice", "gpt-4", None),
            (bob_id, "bob", "gpt-4", None),
            (manual_id, "alice", "gpt-4", True),
        ):
            db.add(DbSession(id=sid, owner=owner, name=name, endpoint_url="http://localhost",
                             model="gpt-4", archived=False, name_is_custom=custom))
        tie_time = cdb.utcnow_naive()
        for msg_id, sid, text, timestamp in (
            ("z-second", alice_id, "Second message", tie_time),
            ("a-first", alice_id, "Fix my workspace snapshot", tie_time),
            ("bob-first", bob_id, "Secret bob request", tie_time),
            ("manual-first", manual_id, "Keep model as my chosen title", tie_time),
        ):
            db.add(DbMessage(id=msg_id, session_id=sid,
                             role="user", content=text, timestamp=timestamp))
        db.commit()
    finally:
        db.close()

    def cached(sid, custom=None):
        result = MagicMock(id=sid, model="gpt-4", endpoint_url="http://localhost",
                           rag=False, archived=False, name_is_custom=custom)
        result.name = "gpt-4"
        return result
    sm = MagicMock()
    sm.get_sessions_for_user.return_value = {
        alice_id: cached(alice_id), manual_id: cached(manual_id, True),
    }
    router = sr.setup_session_routes(sm, {})
    endpoint = [r.endpoint for r in router.routes
                if getattr(r, "path", "") == "/api/sessions"
                and "GET" in getattr(r, "methods", set())][-1]
    result = {row["id"]: row["name"] for row in endpoint(request=MagicMock())}
    assert result.get(alice_id) == "Chat: Fix my workspace snapshot", result
    assert result[manual_id] == "gpt-4"
    assert bob_id not in result


def test_auto_sort_skip_llm_cleans_owner_stamped_sessions_when_auth_disabled(monkeypatch):
    import routes.session_routes as sr
    from unittest.mock import MagicMock

    _stub_multipart_if_missing(monkeypatch)
    monkeypatch.setenv("AUTH_ENABLED", "false")
    monkeypatch.setattr(sr, "SessionLocal", _TS)
    monkeypatch.setattr(sr, "effective_user", lambda request: None)

    sid = str(uuid.uuid4())
    old_time = cdb.utcnow_naive() - timedelta(hours=2)
    db = _TS()
    try:
        db.query(DbMessage).delete()
        db.query(DbSession).delete()
        db.add(DbSession(
            id=sid,
            owner="alice",
            name="New chat",
            endpoint_url="http://localhost",
            model="gpt-4",
            archived=False,
            message_count=1,
            created_at=old_time,
            updated_at=old_time,
            last_message_at=old_time,
            last_accessed=old_time,
        ))
        db.add(DbMessage(
            id="m-" + uuid.uuid4().hex,
            session_id=sid,
            role="user",
            content="hi",
            timestamp=old_time,
        ))
        db.commit()
    finally:
        db.close()

    session = MagicMock(id=sid, name="New chat", model="gpt-4", endpoint_url="http://localhost", rag=False, archived=False)
    sm = MagicMock()
    sm.get_sessions_for_user.return_value = {sid: session}
    router = sr.setup_session_routes(sm, {})
    endpoint = next(r.endpoint for r in router.routes
                    if getattr(r, "path", "") == "/api/sessions/auto-sort"
                    and "POST" in getattr(r, "methods", set()))

    result = endpoint(request=MagicMock(), skip_llm=True)

    assert result["deleted_throwaway"] == 1
    db = _TS()
    try:
        assert db.query(DbSession).filter(DbSession.id == sid).first() is None
    finally:
        db.close()
