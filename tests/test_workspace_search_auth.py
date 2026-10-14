import os

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.middleware.base import BaseHTTPMiddleware

import routes.workspace_routes as workspace_routes
from core.middleware import INTERNAL_TOOL_HEADER


class RequestIdentityMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        request.state.current_user = request.headers.get("x-test-user")
        if request.headers.get("x-test-api-token"):
            request.state.api_token = True
            request.state.api_token_owner = request.headers.get("x-test-token-owner")
        return await call_next(request)


@pytest.fixture
def workspace_search_client(tmp_path, monkeypatch):
    root = tmp_path / "workspace"
    root.mkdir()
    (root / "report.txt").write_text("private workspace content")
    app = FastAPI()
    app.add_middleware(RequestIdentityMiddleware)
    monkeypatch.setattr(workspace_routes, "owner_is_admin_or_single_user", lambda user: user == "admin")
    monkeypatch.setattr("src.tool_execution.vet_workspace", lambda path: os.path.realpath(path))
    app.include_router(workspace_routes.setup_workspace_routes())
    return TestClient(app), str(root)


@pytest.mark.parametrize("endpoint", ["/api/workspace/search", "/api/workspace/open"])
@pytest.mark.parametrize("credential", ["delegated", "internal_header", "internal_user"])
def test_workspace_search_and_download_reject_noninteractive_credentials(
    workspace_search_client, monkeypatch, endpoint, credential,
):
    client, root = workspace_search_client
    monkeypatch.setenv("AUTH_ENABLED", "false")
    headers = {"x-test-user": "admin"}
    if credential == "delegated":
        headers.update({"x-test-api-token": "1", "x-test-token-owner": "admin"})
    elif credential == "internal_header":
        headers[INTERNAL_TOOL_HEADER] = "internal"
    else:
        headers["x-test-user"] = "internal-tool"

    params = {"workspace": root, "q": "report"} if endpoint.endswith("search") else {
        "workspace": root, "path": "report.txt",
    }
    response = client.get(endpoint, params=params, headers=headers)
    assert response.status_code == 403


def test_interactive_admin_can_search_and_download_workspace_file(workspace_search_client):
    client, root = workspace_search_client
    headers = {"x-test-user": "admin"}
    found = client.get("/api/workspace/search", params={"workspace": root, "q": "report"}, headers=headers)
    assert found.status_code == 200
    assert [item["path"] for item in found.json()["results"]] == ["report.txt"]
    opened = client.get("/api/workspace/open", params={"workspace": root, "path": "report.txt"}, headers=headers)
    assert opened.status_code == 200
    assert opened.content == b"private workspace content"
