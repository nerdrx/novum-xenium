import asyncio
import threading
from types import SimpleNamespace

import httpx
from fastapi import FastAPI, HTTPException


def _app(chat_routes):
    app = FastAPI()
    app.include_router(chat_routes.setup_chat_routes(*(SimpleNamespace() for _ in range(6))))
    app.dependency_overrides[chat_routes.require_chat_api_token_scope] = lambda: None
    return app


def test_stream_status_owner_lookup_does_not_block_event_loop(monkeypatch):
    from routes import chat_routes

    entered = threading.Event()
    release = threading.Event()
    owner_returned = threading.Event()
    app = _app(chat_routes)

    def slow_owner_check(_request, _session_id):
        entered.set()
        release.wait(5)
        owner_returned.set()

    monkeypatch.setattr(chat_routes, "_verify_session_owner", slow_owner_check)

    async def drive():
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            status_task = asyncio.create_task(client.get("/api/chat/stream_status/session"))
            try:
                assert await asyncio.to_thread(entered.wait, 1), "owner lookup did not start"
                heartbeat = await client.get("/heartbeat")
                assert heartbeat.status_code == 200
                assert not owner_returned.is_set(), "heartbeat must finish while the ownership lookup remains blocked"
            finally:
                release.set()
            response = await status_task
            assert response.status_code == 404  # no active stream, as before

    @app.get("/heartbeat")
    async def heartbeat():
        return {"ok": True}

    asyncio.run(drive())


def test_stream_status_preserves_owner_not_found_and_forbidden(monkeypatch):
    from routes import chat_routes

    app = _app(chat_routes)

    async def drive():
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            for code in (403, 404):
                monkeypatch.setattr(
                    chat_routes,
                    "_verify_session_owner",
                    lambda *_args, _code=code: (_ for _ in ()).throw(HTTPException(_code)),
                )
                response = await client.get("/api/chat/stream_status/session")
                assert response.status_code == code

    asyncio.run(drive())
