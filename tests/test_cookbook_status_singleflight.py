"""Cancelling one status client must not cancel shared worker-thread polling."""
import asyncio
import threading

import pytest

import routes.cookbook_routes as cookbook


def _status_endpoint(monkeypatch, worker):
    monkeypatch.setattr(cookbook, "require_admin", lambda _request: None)
    endpoint = next(route.endpoint for route in cookbook.setup_cookbook_routes().routes
                    if route.path == "/api/cookbook/tasks/status")
    closure = dict(zip(endpoint.__code__.co_freevars, endpoint.__closure__))
    closure["_cookbook_tasks_status_sync"].cell_contents = worker
    return endpoint, closure


@pytest.mark.asyncio
async def test_cancelled_status_client_does_not_cancel_shared_poll_or_duplicate_worker(monkeypatch):
    entered, release = threading.Event(), threading.Event()
    calls = []
    result = {"tasks": [{"session_id": "fixture-download", "status": "running"}]}

    def worker():
        calls.append(True)
        entered.set()
        assert release.wait(3)
        return result

    endpoint, _ = _status_endpoint(monkeypatch, worker)
    first = asyncio.create_task(endpoint(None))
    clients = [first]
    try:
        assert await asyncio.to_thread(entered.wait, 1)
        second = asyncio.create_task(endpoint(None))
        clients.append(second)
        await asyncio.sleep(0)
        first.cancel()
        with pytest.raises(asyncio.CancelledError):
            await first
        assert not second.done(), "one cancelled client cancelled another client's shared poll"
        third = asyncio.create_task(endpoint(None))
        clients.append(third)
        await asyncio.sleep(0)
        release.set()
        assert await asyncio.wait_for(second, 2) is result
        assert await asyncio.wait_for(third, 2) is result
        assert len(calls) == 1, "cancellation started another scan while the first still ran"
        assert await endpoint(None) is result
        assert len(calls) == 1
    finally:
        release.set()
        await asyncio.gather(*clients, return_exceptions=True)


@pytest.mark.asyncio
async def test_abandoned_status_worker_finishes_and_next_poll_can_recover(monkeypatch):
    entered, release = threading.Event(), threading.Event()

    def worker():
        entered.set()
        assert release.wait(3)
        raise ValueError("fixture scan failed")

    endpoint, closure = _status_endpoint(monkeypatch, worker)
    client = asyncio.create_task(endpoint(None))
    try:
        assert await asyncio.to_thread(entered.wait, 1)
        shared = closure["_tasks_status_inflight"].cell_contents["task"]
        client.cancel()
        with pytest.raises(asyncio.CancelledError):
            await client
        assert not shared.cancelled(), "client cancellation abandoned its running scan"
        release.set()
        with pytest.raises(ValueError, match="fixture scan failed"):
            await asyncio.wait_for(asyncio.shield(shared), 2)
        await asyncio.sleep(0)
        assert closure["_tasks_status_inflight"].cell_contents["task"] is None
        closure["_cookbook_tasks_status_sync"].cell_contents = lambda: {"tasks": []}
        assert await endpoint(None) == {"tasks": []}
    finally:
        release.set()
        await asyncio.gather(client, return_exceptions=True)
