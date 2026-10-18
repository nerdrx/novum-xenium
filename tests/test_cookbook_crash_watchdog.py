import asyncio
import threading
import time

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool


@pytest.fixture
def endpoint_db(monkeypatch):
    from core import database

    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    database.Base.metadata.create_all(engine)
    monkeypatch.setattr(database, "SessionLocal", sessionmaker(bind=engine))
    with database.SessionLocal() as db:
        db.add(database.ModelEndpoint(id="cookbook-test", name="Test", base_url="http://old"))
        db.commit()
    yield database
    engine.dispose()


def test_watchdog_probe_is_off_loop_and_does_not_delete_edited_endpoint(monkeypatch, endpoint_db):
    from routes import cookbook_routes

    entered = threading.Event()
    release = threading.Event()
    release_time = []
    heartbeat_time = []

    def gated_urlopen(url, timeout):
        assert url == "http://old/models"
        assert timeout == 3
        entered.set()
        release.wait(2)
        release_time.append(time.monotonic())

        class Response:
            status = 503
            def __enter__(self): return self
            def __exit__(self, *args): return False

        return Response()

    monkeypatch.setattr(cookbook_routes.urllib.request, "urlopen", gated_urlopen)

    async def run():
        loop = asyncio.get_running_loop()
        heartbeat = asyncio.Event()
        loop.call_later(0.01, lambda: (heartbeat_time.append(time.monotonic()), heartbeat.set()))
        timer = threading.Timer(0.25, release.set)
        timer.start()
        cleanup = asyncio.create_task(
            cookbook_routes._cleanup_unreachable_model_endpoint("cookbook-test")
        )
        assert await asyncio.to_thread(entered.wait, 1)
        await heartbeat.wait()
        with endpoint_db.SessionLocal() as db:
            endpoint = db.query(endpoint_db.ModelEndpoint).filter_by(id="cookbook-test").one()
            endpoint.base_url = "http://repaired"
            db.commit()
        release.set()
        result = await cleanup
        timer.cancel()
        return result

    result = asyncio.run(run())
    assert heartbeat_time[0] < release_time[0]
    assert result[0] == "changed"
    with endpoint_db.SessionLocal() as db:
        endpoint = db.query(endpoint_db.ModelEndpoint).filter_by(id="cookbook-test").one()
        assert endpoint.base_url == "http://repaired"


@pytest.mark.parametrize(("status", "expected"), [(200, "reachable"), (503, "deleted")])
def test_watchdog_preserves_reachable_and_drops_unreachable_endpoint(
    monkeypatch, endpoint_db, status, expected
):
    from routes import cookbook_routes

    class Response:
        def __enter__(self): return self
        def __exit__(self, *args): return False

    monkeypatch.setattr(
        cookbook_routes.urllib.request,
        "urlopen",
        lambda url, timeout: type("FakeResponse", (Response,), {"status": status})(),
    )
    result = asyncio.run(
        cookbook_routes._cleanup_unreachable_model_endpoint("cookbook-test")
    )
    assert result[0] == expected
    with endpoint_db.SessionLocal() as db:
        exists = db.query(endpoint_db.ModelEndpoint).filter_by(id="cookbook-test").first() is not None
    assert exists is (expected == "reachable")


def test_watchdog_capture_timeout_terminates_then_kills_owned_child(monkeypatch):
    from routes import cookbook_routes

    class FakeProcess:
        returncode = None

        def __init__(self):
            self.terminated = False
            self.killed = False
            self.waits = 0
            self.communication_started = asyncio.Event()

        def terminate(self):
            self.terminated = True

        def kill(self):
            self.killed = True

        async def communicate(self):
            self.communication_started.set()
            await asyncio.Event().wait()

        async def wait(self):
            self.waits += 1
            if self.killed:
                self.returncode = -9
                return self.returncode
            await asyncio.Event().wait()

    original_wait_for = asyncio.wait_for

    async def quick_wait_for(awaitable, timeout):
        return await original_wait_for(awaitable, min(timeout, 0.01))

    monkeypatch.setattr(cookbook_routes.asyncio, "wait_for", quick_wait_for)
    proc = FakeProcess()

    async def create_process(*args, **kwargs):
        return proc

    monkeypatch.setattr(cookbook_routes.asyncio, "create_subprocess_exec", create_process)

    async def run():
        with pytest.raises(asyncio.TimeoutError):
            await cookbook_routes._capture_watchdog_pane_output(["fake-capture"])
        return proc

    proc = asyncio.run(run())
    assert proc.terminated and proc.killed
    assert proc.waits == 2
    assert proc.returncode == -9


def test_watchdog_capture_cancellation_cleans_up_owned_child(monkeypatch):
    from routes import cookbook_routes

    class FakeProcess:
        returncode = None

        def __init__(self):
            self.terminated = False
            self.killed = False
            self.communication_started = asyncio.Event()

        async def communicate(self):
            self.communication_started.set()
            await asyncio.Event().wait()

        def terminate(self):
            self.terminated = True

        def kill(self):
            self.killed = True

        async def wait(self):
            if self.killed:
                self.returncode = -9
                return self.returncode
            await asyncio.Event().wait()

    original_wait_for = asyncio.wait_for

    async def quick_wait_for(awaitable, timeout):
        return await original_wait_for(awaitable, min(timeout, 0.01))

    monkeypatch.setattr(cookbook_routes.asyncio, "wait_for", quick_wait_for)
    proc = FakeProcess()

    async def create_process(*args, **kwargs):
        return proc

    monkeypatch.setattr(cookbook_routes.asyncio, "create_subprocess_exec", create_process)

    async def run():
        task = asyncio.create_task(
            cookbook_routes._capture_watchdog_pane_output(["fake-capture"])
        )
        await proc.communication_started.wait()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    asyncio.run(run())
    assert proc.terminated and proc.killed
    assert proc.returncode == -9
