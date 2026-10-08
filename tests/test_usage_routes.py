"""Usage history must be honest, date-scoped, and private across owners."""
import json
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from core.database import Base, ChatMessage, Session
from routes import usage_routes as usage


@pytest.fixture
def db_factory(monkeypatch):
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine)
    monkeypatch.setattr(usage, "SessionLocal", factory)
    yield factory
    engine.dispose()


def test_usage_counts_dates_sources_models_and_owner(db_factory):
    now = datetime(2026, 10, 8, 12, tzinfo=timezone.utc)
    stamp = now.replace(tzinfo=None)
    with db_factory() as db:
        for sid, owner, name, archived in (("a", "alice", "My chat", False),
                                           ("archive", "alice", "Archived", True),
                                           ("b", "bob", "Secret", False),
                                           ("n", None, "Legacy", False),
                                           ("private", "alice", "Nobody", False)):
            db.add(Session(id=sid, owner=owner, name=name, endpoint_url="secret-url", model="selected",
                           archived=archived, total_input_tokens=999999))
        def message(mid, sid, role, when, metadata=None, content="never send my content"):
            db.add(ChatMessage(id=mid, session_id=sid, role=role, timestamp=when,
                               content=content, meta_data=json.dumps(metadata) if metadata else None))
        message("u", "a", "user", stamp, content=json.dumps([
            {"type": "text", "text": "hello there friend"},
            {"type": "image_url", "image_url": {"url": "data:hugebase64"}}]))
        message("real", "a", "assistant", stamp, {"input_tokens": 100, "output_tokens": 20,
                                                    "usage_source": "real", "model": "actual"})
        message("mixed", "a", "assistant", stamp - timedelta(days=1),
                {"input_tokens": 50, "output_tokens": 10, "usage_source": "mixed", "failed": True,
                 "usage_buckets": [{"model": "actual", "input_tokens": 30, "output_tokens": 6},
                                   {"model": "fallback", "input_tokens": 20, "output_tokens": 4}]})
        message("old-source", "archive", "assistant", stamp, {"input_tokens": "7", "output_tokens": 3})
        message("missing", "a", "assistant", stamp - timedelta(days=6))
        message("old", "a", "assistant", stamp - timedelta(days=7), {"input_tokens": 10000})
        message("future", "a", "assistant", stamp + timedelta(days=1), {"input_tokens": 20000})
        for sid in ("b", "n", "private"):
            message("hidden-" + sid, sid, "assistant", stamp, {"input_tokens": 90000})
        db.commit()
        result = usage.collect_usage(db, "alice", 7, now=now)
        assert result["totals"]["messages"] == 5
        assert result["totals"]["input_tokens"] == 157
        assert result["totals"]["output_tokens"] == 33
        assert result["totals"]["total_tokens"] == 190
        assert result["totals"]["measured_messages"] == 1
        assert result["totals"]["estimated_messages"] == 1
        assert result["totals"]["unknown_metrics_messages"] == 1
        assert result["totals"]["missing_metrics_messages"] == 1
        assert result["totals"]["failed_messages"] == 1
        assert result["totals"]["sessions"] == 2
        assert len(result["daily"]) == 7
        assert result["daily"][0]["date"] == "2026-10-02"
        models = {m["model"]: m for m in result["models"]}
        assert models["actual"]["total_tokens"] == 156
        assert models["fallback"]["total_tokens"] == 24
        assert "actual" == result["insights"]["favourite_model"]
        assert result["insights"]["words_written"] == 3
        assert [s["id"] for s in result["recent_sessions"]] == ["a"]
        encoded = json.dumps(result)
        assert "never send my content" not in encoded
        assert "secret-url" not in encoded
        assert "Secret" not in encoded
        assert usage.collect_usage(db, None, 7, now=now)["totals"]["messages"] == 0


def test_empty_usage_and_streak(db_factory):
    now = datetime(2026, 10, 8, 12, tzinfo=timezone.utc)
    with db_factory() as db:
        result = usage.collect_usage(db, "alice", 30, now=now)
        assert len(result["daily"]) == 30
        assert not any(result["totals"].values())
        assert result["models"] == result["recent_sessions"] == []
        assert result["insights"]["busiest_day"] is None
        assert result["provider_limits"] is None
        db.add(Session(id="a", owner="alice", name="Chat", model="m", endpoint_url="local"))
        for days_ago in (1, 2, 4):
            db.add(ChatMessage(id=str(days_ago), session_id="a", role="user", content="hey",
                               timestamp=now.replace(tzinfo=None) - timedelta(days=days_ago)))
        db.commit()
        result = usage.collect_usage(db, "alice", 7, now=now)
        assert result["insights"]["streak_days"] == 2
        assert result["insights"]["active_days"] == 3


def test_route_authentication_days_validation_and_local_owner(db_factory, monkeypatch):
    monkeypatch.setenv("AUTH_ENABLED", "true")
    monkeypatch.setenv("LOCALHOST_BYPASS", "false")
    app = FastAPI()
    app.include_router(usage.setup_usage_routes())
    client = TestClient(app)
    assert client.get("/api/usage").status_code == 401
    async def identity(request, call_next):
        request.state.current_user = "alice"
        return await call_next(request)
    # A fresh app avoids adding middleware after TestClient started it.
    app2 = FastAPI()
    app2.middleware("http")(identity)
    app2.include_router(usage.setup_usage_routes())
    client = TestClient(app2)
    assert client.get("/api/usage").status_code == 200
    assert client.get("/api/usage?days=30").json()["days"] == 30
    for invalid in ("8", "0", "999", "nope"):
        assert client.get("/api/usage?days=" + invalid).status_code == 422
    app3 = FastAPI()
    app3.include_router(usage.setup_usage_routes())
    monkeypatch.setenv("AUTH_ENABLED", "false")
    with db_factory() as db:
        db.add(Session(id="local", owner="__odysseus_local__", name="Local", model="m", endpoint_url="local"))
        db.add(ChatMessage(id="local", session_id="local", role="user", content="hey"))
        db.commit()
    assert TestClient(app3).get("/api/usage").json()["totals"]["user_messages"] == 1


@pytest.mark.parametrize("value", [-1, "nan", "inf", True, {}, []])
def test_bad_legacy_numbers_are_not_tokens(value):
    assert usage._number(value) is None
