import base64
import time
from unittest.mock import MagicMock

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from starlette.middleware.base import BaseHTTPMiddleware

from routes import chat_routes
from src import preview_store


class IdentityMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        request.state.current_user = request.headers.get("x-test-user")
        return await call_next(request)


@pytest.fixture
def preview_client(monkeypatch, tmp_path):
    monkeypatch.setattr(preview_store, "_DB", tmp_path / "history.sqlite3")
    monkeypatch.setattr(chat_routes, "effective_user", lambda request: request.state.current_user)
    def verify(request, session_id, *_args):
        if request.state.current_user != "alice" or session_id != "session-a":
            raise HTTPException(404, "Session not found")
    monkeypatch.setattr(chat_routes, "_verify_session_owner", verify)
    app = FastAPI()
    app.add_middleware(IdentityMiddleware)
    app.dependency_overrides[chat_routes.require_chat_api_token_scope] = lambda: None
    app.include_router(chat_routes.setup_chat_routes(
        MagicMock(), MagicMock(), MagicMock(), MagicMock(), MagicMock(), MagicMock()
    ))
    return TestClient(app)


def test_preview_routes_require_session_owner_and_disable_caching(preview_client):
    png = b"\x89PNG\r\n\x1a\nfixture"
    now = time.time()
    item = preview_store.add("alice", "session-a", "desktop", "Desktop preview", "image/png",
                             base64.b64encode(png).decode(), now=now)
    alice = {"x-test-user": "alice"}
    bob = {"x-test-user": "bob"}
    listing = preview_client.get("/api/chat/previews/session-a", headers=alice)
    assert listing.status_code == 200
    assert listing.headers["cache-control"] == "private, no-store, max-age=0"
    assert listing.json()["retention_days"] == 7
    assert listing.json()["previews"][0]["image_url"] == f"/api/chat/previews/session-a/{item['id']}"
    image = preview_client.get(listing.json()["previews"][0]["image_url"], headers=alice)
    assert image.content == png and image.headers["content-type"] == "image/png"
    assert image.headers["x-content-type-options"] == "nosniff"
    preview_store.add("alice", "session-a", "browser", "Later page", "image/png",
                      base64.b64encode(png + b"later").decode(), now=now + 1)
    page = preview_client.get("/api/chat/previews/session-a?limit=1&offset=0", headers=alice).json()
    assert len(page["previews"]) == 1 and page["has_more"] is True and page["next_offset"] == 1
    next_page = preview_client.get("/api/chat/previews/session-a?limit=1&offset=1", headers=alice).json()
    assert next_page["has_more"] is False and next_page["previews"][0]["id"] == item["id"]
    assert preview_client.get("/api/chat/previews/session-a", headers=bob).status_code == 404
    assert preview_client.get(f"/api/chat/previews/session-a/{item['id']}", headers=bob).status_code == 404
    assert preview_client.get("/api/chat/previews/deleted-session", headers=alice).status_code == 404
