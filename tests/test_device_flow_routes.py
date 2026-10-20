"""Shared device-flow route helper regressions."""

import asyncio
import threading

import httpx
import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from routes import device_flow


def _client(monkeypatch, now_ref, start_flow, poll_flow):
    store = device_flow.PendingDeviceFlowStore(time_func=lambda: now_ref[0])
    router = device_flow.create_device_flow_router(
        prefix="/api/test-device",
        tags=["test-device"],
        store=store,
        start_flow=start_flow,
        poll_flow=poll_flow,
    )
    app = FastAPI()
    app.include_router(router)
    monkeypatch.setattr(device_flow, "require_admin", lambda request: None)
    return TestClient(app)


def _start(_request, _form):
    return device_flow.DeviceFlowStart(
        pending={"secret": "server-only", "owner": "alice"},
        response={"user_code": "ABCD-EFGH", "verification_uri": "https://example.test/device"},
        interval=5,
        expires_in=20,
    )


def test_pending_poll_is_throttled_until_interval(monkeypatch):
    now = [100.0]
    calls = []

    def poll(_request, pending):
        calls.append(dict(pending))
        return device_flow.DeviceFlowPoll.pending()

    client = _client(monkeypatch, now, _start, poll)
    start = client.post("/api/test-device/device/start").json()

    first = client.post("/api/test-device/device/poll", data={"poll_id": start["poll_id"]})
    assert first.json() == {"status": "pending"}
    assert calls == [{"secret": "server-only", "owner": "alice"}]

    second = client.post("/api/test-device/device/poll", data={"poll_id": start["poll_id"]})
    assert second.json() == {"status": "pending"}
    assert len(calls) == 1

    now[0] += 5
    third = client.post("/api/test-device/device/poll", data={"poll_id": start["poll_id"]})
    assert third.json() == {"status": "pending"}
    assert len(calls) == 2


def test_slow_down_updates_poll_interval(monkeypatch):
    now = [100.0]
    calls = []

    def poll(_request, _pending):
        calls.append(now[0])
        if len(calls) == 1:
            return device_flow.DeviceFlowPoll.slow_down(interval=10)
        return device_flow.DeviceFlowPoll.authorized({"id": "ep1", "models": ["gpt-4o"]})

    client = _client(monkeypatch, now, _start, poll)
    poll_id = client.post("/api/test-device/device/start").json()["poll_id"]

    assert client.post("/api/test-device/device/poll", data={"poll_id": poll_id}).json() == {"status": "pending"}
    now[0] += 9
    assert client.post("/api/test-device/device/poll", data={"poll_id": poll_id}).json() == {"status": "pending"}
    assert len(calls) == 1

    now[0] += 1
    assert client.post("/api/test-device/device/poll", data={"poll_id": poll_id}).json() == {
        "status": "authorized",
        "endpoint": {"id": "ep1", "models": ["gpt-4o"]},
    }


def test_authorized_and_failed_polls_remove_pending_session(monkeypatch):
    now = [100.0]
    outcomes = [
        device_flow.DeviceFlowPoll.authorized({"id": "ep1"}),
        device_flow.DeviceFlowPoll.failed("access_denied"),
    ]

    def poll(_request, _pending):
        return outcomes.pop(0)

    client = _client(monkeypatch, now, _start, poll)
    first = client.post("/api/test-device/device/start").json()["poll_id"]
    second = client.post("/api/test-device/device/start").json()["poll_id"]

    assert client.post("/api/test-device/device/poll", data={"poll_id": first}).json()["status"] == "authorized"
    assert client.post("/api/test-device/device/poll", data={"poll_id": first}).status_code == 404

    assert client.post("/api/test-device/device/poll", data={"poll_id": second}).json() == {
        "status": "failed",
        "error": "access_denied",
    }
    assert client.post("/api/test-device/device/poll", data={"poll_id": second}).status_code == 404


def test_cancel_and_expiry_remove_pending_session(monkeypatch):
    now = [100.0]

    def poll(_request, _pending):
        return device_flow.DeviceFlowPoll.pending()

    client = _client(monkeypatch, now, _start, poll)
    cancelled = client.post("/api/test-device/device/start").json()["poll_id"]
    assert client.post("/api/test-device/device/cancel", data={"poll_id": cancelled}).json() == {"status": "cancelled"}
    assert client.post("/api/test-device/device/poll", data={"poll_id": cancelled}).status_code == 404

    expired = client.post("/api/test-device/device/start").json()["poll_id"]
    now[0] += 21
    assert client.post("/api/test-device/device/poll", data={"poll_id": expired}).status_code == 404


def test_routes_are_admin_gated(monkeypatch):
    now = [100.0]

    def poll(_request, _pending):
        return device_flow.DeviceFlowPoll.pending()

    client = _client(monkeypatch, now, _start, poll)

    def deny(_request):
        raise HTTPException(403, "admin required")

    monkeypatch.setattr(device_flow, "require_admin", deny)
    assert client.post("/api/test-device/device/start").status_code == 403
    assert client.post("/api/test-device/device/poll", data={"poll_id": "missing"}).status_code == 403
    assert client.post("/api/test-device/device/cancel", data={"poll_id": "missing"}).status_code == 403


def test_sync_start_callback_does_not_block_heartbeat(monkeypatch):
    now = [100.0]
    entered = threading.Event()
    release = threading.Event()
    timer = threading.Timer(10, release.set)

    def start(_request, _form):
        entered.set()
        release.wait(12)
        return _start(_request, _form)

    store = device_flow.PendingDeviceFlowStore(time_func=lambda: now[0])
    router = device_flow.create_device_flow_router(
        prefix="/api/test-device", tags=[], store=store,
        start_flow=start, poll_flow=lambda *_: device_flow.DeviceFlowPoll.pending(),
    )
    app = FastAPI()
    app.include_router(router)

    async def heartbeat():
        return {"ok": True}

    app.get("/heartbeat")(heartbeat)
    monkeypatch.setattr(device_flow, "require_admin", lambda request: None)

    async def run():
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            timer.start()
            start_task = asyncio.create_task(client.post("/api/test-device/device/start"))
            assert await asyncio.wait_for(asyncio.to_thread(entered.wait), 5)
            assert not release.is_set()
            heartbeat = await client.get("/heartbeat")
            assert heartbeat.json() == {"ok": True}
            assert not release.is_set(), "heartbeat completes while provider callback is held"
            release.set()
            assert (await asyncio.wait_for(start_task, 2)).status_code == 200

    try:
        asyncio.run(run())
    finally:
        release.set()
        timer.cancel()


def test_poll_claim_blocks_duplicates_but_allows_independent_poll(monkeypatch):
    now = [100.0]
    entered_a = threading.Event()
    release_a = threading.Event()
    finished_a = threading.Event()
    watched_poll = [""]
    calls = {"a": 0, "b": 0}
    calls_lock = threading.Lock()
    timer = threading.Timer(10, release_a.set)

    def start(_request, form):
        label = str(form.get("label") or "")
        return device_flow.DeviceFlowStart(
            pending={"label": label}, response={"label": label}, interval=5, expires_in=20
        )

    def poll(_request, payload):
        label = payload["label"]
        with calls_lock:
            calls[label] += 1
            call_num = calls[label]
        if label == "a" and call_num == 1:
            entered_a.set()
            release_a.wait(12)
        return device_flow.DeviceFlowPoll.pending()

    class ObservedStore(device_flow.PendingDeviceFlowStore):
        def finish_poll(self, poll_id, outcome):
            response = super().finish_poll(poll_id, outcome)
            if poll_id == watched_poll[0]:
                finished_a.set()
            return response

    store = ObservedStore(time_func=lambda: now[0])
    router = device_flow.create_device_flow_router(
        prefix="/api/test-device", tags=[], store=store,
        start_flow=start, poll_flow=poll,
    )
    app = FastAPI()
    app.include_router(router)

    async def heartbeat():
        return {"ok": True}

    app.get("/heartbeat")(heartbeat)
    monkeypatch.setattr(device_flow, "require_admin", lambda request: None)

    async def run():
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            timer.start()
            a = (await client.post("/api/test-device/device/start", data={"label": "a"})).json()["poll_id"]
            b = (await client.post("/api/test-device/device/start", data={"label": "b"})).json()["poll_id"]
            watched_poll[0] = a
            poll_a = asyncio.create_task(client.post("/api/test-device/device/poll", data={"poll_id": a}))
            assert await asyncio.wait_for(asyncio.to_thread(entered_a.wait), 5)
            assert not release_a.is_set()

            heartbeat = await client.get("/heartbeat")
            duplicate = await client.post("/api/test-device/device/poll", data={"poll_id": a})
            independent = await client.post("/api/test-device/device/poll", data={"poll_id": b})
            assert not release_a.is_set(), "other requests complete while provider callback is held"
            assert heartbeat.json() == {"ok": True}
            assert duplicate.json() == {"status": "pending"}
            assert independent.json() == {"status": "pending"}
            assert calls == {"a": 1, "b": 1}

            poll_a.cancel()
            with pytest.raises(asyncio.CancelledError):
                await poll_a
            assert (await client.post("/api/test-device/device/poll", data={"poll_id": a})).json() == {"status": "pending"}
            assert calls["a"] == 1

            release_a.set()
            assert await asyncio.wait_for(asyncio.to_thread(finished_a.wait), 5)
            now[0] += 5
            await client.post("/api/test-device/device/poll", data={"poll_id": a})
            assert calls["a"] == 2

    try:
        asyncio.run(run())
    finally:
        release_a.set()
        timer.cancel()


def test_async_callbacks_remain_supported(monkeypatch):
    now = [100.0]

    async def start(request, form):
        await asyncio.sleep(0)
        return _start(request, form)

    async def poll(_request, _pending):
        await asyncio.sleep(0)
        return device_flow.DeviceFlowPoll.authorized({"id": "async-endpoint"})

    client = _client(monkeypatch, now, start, poll)
    poll_id = client.post("/api/test-device/device/start").json()["poll_id"]
    assert client.post("/api/test-device/device/poll", data={"poll_id": poll_id}).json() == {
        "status": "authorized", "endpoint": {"id": "async-endpoint"}
    }


def test_poll_exception_removes_claimed_session(monkeypatch):
    now = [100.0]

    def poll(_request, _pending):
        raise RuntimeError("synthetic provider failure")

    store = device_flow.PendingDeviceFlowStore(time_func=lambda: now[0])
    router = device_flow.create_device_flow_router(
        prefix="/api/test-device", tags=[], store=store,
        start_flow=_start, poll_flow=poll,
    )
    app = FastAPI()
    app.include_router(router)
    monkeypatch.setattr(device_flow, "require_admin", lambda request: None)

    async def run():
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app, raise_app_exceptions=False),
            base_url="http://test",
        ) as client:
            poll_id = (await client.post("/api/test-device/device/start")).json()["poll_id"]
            failed = await client.post("/api/test-device/device/poll", data={"poll_id": poll_id})
            missing = await client.post("/api/test-device/device/poll", data={"poll_id": poll_id})
            assert failed.status_code == 500
            assert missing.status_code == 404

    asyncio.run(run())
