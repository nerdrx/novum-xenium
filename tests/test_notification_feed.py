import asyncio
from contextlib import asynccontextmanager
import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from starlette.requests import Request
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool


def _request(owner=None):
    request = Request({"type": "http", "headers": [], "method": "GET", "path": "/"})
    request.state.current_user = owner
    return request


def test_notification_feed_is_owner_scoped_non_destructive_and_starts_at_latest(monkeypatch):
    from core import database
    from src import notification_feed
    from routes.task import task_routes

    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    database.Base.metadata.create_all(engine)
    monkeypatch.setattr(database, "SessionLocal", sessionmaker(bind=engine))

    # Existing device and outbox rows stay untouched but are no longer used
    # to send remote messages or create new delivery records.
    with database.SessionLocal() as db:
        db.add(database.NotificationDevice(
            id="legacy-device", owner="alice", token="legacy-token",
        ))
        db.add(database.NotificationPushDelivery(
            event_id=9001, device_id="legacy-device", owner="alice", status="sent",
        ))
        db.commit()

    notification_feed.add_notification(
        "alice", "task", "Task done", source="task_run", source_id="run-1", body="result"
    )
    notification_feed.add_notification(
        "alice", "task", "duplicate", source="task_run", source_id="run-1"
    )
    notification_feed.add_notification(
        "bob", "email", "Private subject", source="email", source_id="msg-1"
    )

    router = task_routes.setup_task_routes(task_scheduler=object())
    endpoint = next(route.endpoint for route in router.routes if route.path.endswith("/notification-feed"))

    initial = asyncio.run(endpoint(_request("alice"), after=None, limit=50))
    assert initial["notifications"] == []
    assert initial["cursor"] == 1

    first = asyncio.run(endpoint(_request("alice"), after=0, limit=50))
    second = asyncio.run(endpoint(_request("alice"), after=0, limit=50))
    assert first == second
    assert [item["title"] for item in first["notifications"]] == ["Task done"]
    assert first["notifications"][0]["body"] == "result"
    detail_endpoint = next(
        route.endpoint for route in router.routes
        if route.path.endswith("/notification-feed/{event_id}")
    )
    detail = asyncio.run(detail_endpoint(_request("alice"), first["notifications"][0]["id"]))
    assert detail["title"] == "Task done"
    with pytest.raises(HTTPException) as missing_detail:
        asyncio.run(detail_endpoint(_request("bob"), first["notifications"][0]["id"]))
    assert missing_detail.value.status_code == 404

    bob = asyncio.run(endpoint(_request("bob"), after=0, limit=50))
    assert [item["title"] for item in bob["notifications"]] == ["Private subject"]
    with pytest.raises(HTTPException) as exc:
        asyncio.run(endpoint(_request(), after=0, limit=50))
    assert exc.value.status_code == 401

    with database.SessionLocal() as db:
        # Feed events no longer enqueue remote push deliveries. Keep the legacy
        # tables available so existing installations retain their stored rows.
        assert db.query(database.NotificationPushDelivery).count() == 1
        assert db.query(database.NotificationPushDelivery).filter_by(
            event_id=9001, status="sent"
        ).count() == 1
        legacy_device = db.query(database.NotificationDevice).filter_by(id="legacy-device").one()
        assert legacy_device.token == "legacy-token"
    paths = {route.path for route in router.routes}
    status_endpoint = next(route.endpoint for route in router.routes if route.path.endswith("/notification-status"))
    status = asyncio.run(status_endpoint(_request("alice")))
    assert status["self_hosted"] is True
    assert status["feed_ready"] is True
    assert status["server_id"]
    assert "push_configured" not in status
    assert not any("/notification-devices" in path for path in paths)
    with pytest.raises(HTTPException) as status_exc:
        asyncio.run(status_endpoint(_request()))
    assert status_exc.value.status_code == 401

    engine.dispose()


def test_desktop_email_watch_is_bounded_and_expires(monkeypatch):
    from src import notification_feed as feed
    monkeypatch.setattr(feed, "_email_watchers", {})
    now = [100.0]
    monkeypatch.setattr(feed.time, "monotonic", lambda: now[0])
    feed.watch_email_notifications("alice", True)
    feed.watch_email_notifications("bob", False)
    assert feed.active_email_watchers() == ["alice"]
    now[0] += 301
    assert feed.active_email_watchers() == []


def test_authenticated_feed_client_cursor_owner_and_server_identity(monkeypatch):
    from core import database
    from src import notification_feed
    from routes.task import task_routes
    from routes import email_pollers

    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    database.Base.metadata.create_all(engine)
    monkeypatch.setattr(database, "SessionLocal", sessionmaker(bind=engine))
    monkeypatch.setattr(email_pollers, "_inprocess_pollers_enabled", lambda: True)
    monkeypatch.setattr(email_pollers, "_notification_email_task", None)

    async def idle_notification_poller():
        await asyncio.Event().wait()

    monkeypatch.setattr(email_pollers, "_notification_email_poller", idle_notification_poller)
    notification_feed.add_notification(
        "alice", "task", "Alice event", source="task_run", source_id="alice-1"
    )
    notification_feed.add_notification(
        "bob", "chat", "Bob event", source="chat_run", source_id="bob-1"
    )

    @asynccontextmanager
    async def lifespan(app):
        yield
        task = email_pollers._notification_email_task
        if task is not None:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    app = FastAPI(lifespan=lifespan)

    @app.middleware("http")
    async def test_identity(request, call_next):
        owner = request.headers.get("x-test-owner")
        if owner:
            request.state.current_user = owner
        return await call_next(request)

    app.include_router(task_routes.setup_task_routes(task_scheduler=object()))
    with TestClient(app) as client:
        initial = client.get("/api/tasks/notification-feed", headers={"x-test-owner": "alice"})
        assert initial.status_code == 200
        assert initial.json() == {"notifications": [], "cursor": 1, "owner": "alice"}
        alice = client.get(
            "/api/tasks/notification-feed?after=0&limit=50&email=true",
            headers={"x-test-owner": "alice"},
        )
        assert alice.status_code == 200
        assert alice.json()["owner"] == "alice"
        assert [row["title"] for row in alice.json()["notifications"]] == ["Alice event"]
        bob = client.get(
            "/api/tasks/notification-feed?after=0",
            headers={"x-test-owner": "bob"},
        )
        assert [row["title"] for row in bob.json()["notifications"]] == ["Bob event"]
        assert bob.json()["owner"] == "bob"
        assert client.get("/api/tasks/notification-feed?after=0").status_code == 401

        status_path = "/api/tasks/notification-status"
        status1 = client.get(status_path, headers={"x-test-owner": "alice"})
        status2 = client.get(status_path, headers={"x-test-owner": "alice"})
        assert status1.status_code == status2.status_code == 200
        assert status1.json()["server_id"] == status2.json()["server_id"]
        assert status1.json()["self_hosted"] and status1.json()["feed_ready"]
        assert status1.json()["worker_enabled"] and status1.json()["worker_running"]
        assert status1.json()["email_scan_running"]
        assert client.get(status_path).status_code == 401

    engine.dispose()
