import asyncio
import threading
from types import SimpleNamespace

import httpx
from fastapi import FastAPI


def test_search_does_not_block_unrelated_http_request(monkeypatch):
    from routes import chat_routes

    entered = threading.Event()
    release = threading.Event()
    heartbeat_before_release = []
    captured = {}
    watchdog = threading.Timer(2, release.set)

    def blocked_search(query, **kwargs):
        captured.update(query=query, **kwargs)
        entered.set()
        release.wait(5)
        return []

    monkeypatch.setattr(chat_routes, "search_session_messages", blocked_search)
    router = chat_routes.setup_chat_routes(*(SimpleNamespace() for _ in range(6)))
    app = FastAPI()
    app.include_router(router)

    @app.middleware("http")
    async def identify_test_user(request, call_next):
        request.state.current_user = "alice"
        return await call_next(request)

    @app.get("/heartbeat")
    async def heartbeat():
        heartbeat_before_release.append(not release.is_set())
        return {"ok": True}

    async def drive():
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            search_task = asyncio.create_task(client.get("/api/search", params={"q": "needle"}))
            watchdog.start()
            try:
                assert await asyncio.to_thread(entered.wait, 1), "search did not enter the fixture worker"
                response = await client.get("/heartbeat")
                assert response.status_code == 200
                release.set()
                search_response = await search_task
                assert search_response.status_code == 200
                assert search_response.json() == []
            finally:
                release.set()
                await search_task
                watchdog.cancel()

    asyncio.run(drive())

    assert heartbeat_before_release == [True]
    assert captured == {
        "query": "needle",
        "limit": 20,
        "owner": "alice",
        "restrict_owner": True,
        "include_legacy_owner": False,
    }
