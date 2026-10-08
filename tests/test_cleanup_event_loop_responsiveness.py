"""Cleanup database and artifact work must not stall unrelated API requests."""
import asyncio
import threading

import httpx
import pytest
from fastapi import FastAPI

import routes.cleanup.cleanup_routes as cleanup_routes
import src.cleanup_service as cleanup_service


@pytest.mark.parametrize("operation", ["cleanup", "preview"])
async def test_cleanup_endpoints_keep_event_loop_responsive_while_worker_is_blocked(
    monkeypatch, operation
):
    entered_worker = threading.Event()
    release_worker = threading.Event()
    release_safety = threading.Timer(2, release_worker.set)

    def blocked_worker(*_args, **_kwargs):
        entered_worker.set()
        if not release_worker.wait(timeout=2):
            raise AssertionError("test did not release blocked cleanup worker")
        if operation == "preview":
            return {
                "sessions_to_archive": [],
                "sessions_to_delete": [],
                "preserved_sessions": [],
                "estimated_space_freed_mb": 0.0,
            }
        return 1, 0.0

    if operation == "preview":
        monkeypatch.setattr(cleanup_service, "_get_cleanup_preview_sync", blocked_worker)
    else:
        async def no_archive(_manager, owner=None):
            return 0

        monkeypatch.setattr(cleanup_service, "archive_inactive_sessions", no_archive)
        monkeypatch.setattr(cleanup_service, "_cleanup_old_sessions_sync", blocked_worker)

    monkeypatch.setattr(cleanup_routes, "get_current_user", lambda _request: "alice")
    app = FastAPI()
    app.include_router(cleanup_routes.setup_cleanup_routes(object()))

    @app.get("/tiny")
    async def tiny():
        return {"ok": True}

    client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")
    release_safety.start()
    try:
        path = "/api/cleanup/preview" if operation == "preview" else "/api/cleanup"
        request = asyncio.create_task(client.get(path) if operation == "preview" else client.post(path))
        # A bounded worker event proves the operation reached its blocking sync
        # core before testing an independent route on the same event loop.
        assert await asyncio.to_thread(entered_worker.wait, 2)
        tiny_response = await client.get("/tiny")
        assert tiny_response.status_code == 200
        assert tiny_response.json() == {"ok": True}
        # The external timer is only a deadlock safeguard. The tiny request must
        # complete while the fake local I/O is still blocked.
        assert not release_worker.is_set()
        release_worker.set()
        response = await request
        assert response.status_code == 200
    finally:
        release_worker.set()
        release_safety.cancel()
        if "request" in locals():
            await asyncio.gather(request, return_exceptions=True)
        await client.aclose()
