import asyncio

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

    bob = asyncio.run(endpoint(_request("bob"), after=0, limit=50))
    assert [item["title"] for item in bob["notifications"]] == ["Private subject"]
    anonymous = asyncio.run(endpoint(_request(), after=0, limit=50))
    assert anonymous == {"notifications": [], "cursor": 0}

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
