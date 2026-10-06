import os

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from starlette.middleware.base import BaseHTTPMiddleware

import routes.workspace_routes as workspace_routes
from core.middleware import INTERNAL_TOOL_HEADER


class _RequestIdentityMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        request.state.current_user = request.headers.get("x-test-user")
        if request.headers.get("x-test-api-token"):
            request.state.api_token = True
            request.state.api_token_owner = request.headers.get("x-test-token-owner")
        return await call_next(request)


@pytest.fixture
def snapshot_client(tmp_path, monkeypatch):
    workspace = str(tmp_path / "workspace")
    os.mkdir(workspace)
    app = FastAPI()
    app.add_middleware(_RequestIdentityMiddleware)
    monkeypatch.setattr(workspace_routes, "owner_is_admin_or_single_user", lambda user: user == "admin")
    monkeypatch.setattr("src.tool_execution.vet_workspace", lambda path: os.path.realpath(path))
    monkeypatch.setattr(workspace_routes, "_verify_session_owner", lambda *args: None)
    monkeypatch.setattr(workspace_routes, "list_snapshots", lambda *args: [])
    monkeypatch.setattr(workspace_routes, "create_snapshot", lambda *args: {"id": "created"})
    monkeypatch.setattr(workspace_routes, "preview_snapshot", lambda *args: {"id": "preview"})
    monkeypatch.setattr(workspace_routes, "restore_snapshot", lambda *args: {"id": "restored"})
    app.include_router(workspace_routes.setup_workspace_routes())
    return TestClient(app), workspace


@pytest.mark.parametrize("method,path,kwargs", [
    ("get", "/api/workspace/snapshots", "query"),
    ("post", "/api/workspace/snapshots", "body"),
    ("post", "/api/workspace/snapshots/snap-1/preview", "body"),
    ("post", "/api/workspace/snapshots/snap-1/restore", "body"),
])
def test_snapshot_routes_reject_delegated_and_internal_credentials(
    snapshot_client, monkeypatch, method, path, kwargs,
):
    client, workspace = snapshot_client
    if kwargs == "query":
        params = {"workspace": workspace, "session_id": "session-1"}
        body = None
    else:
        params = None
        body = {"workspace": workspace, "session_id": "session-1", "expected_revision": "rev"}

    # Even if this token belongs to an admin and the deployment's auth mode
    # allows single-user operations, it is still not an interactive browser.
    monkeypatch.setenv("AUTH_ENABLED", "false")
    delegated = {
        "x-test-user": "admin", "x-test-api-token": "1",
        "x-test-token-owner": "admin",
    }
    send = lambda headers: (
        client.get(path, params=params, headers=headers)
        if method == "get" else client.post(path, json=body, headers=headers)
    )
    response = send(delegated)
    assert response.status_code == 403

    internal = {"x-test-user": "admin", INTERNAL_TOOL_HEADER: "internal"}
    response = send(internal)
    assert response.status_code == 403


def test_snapshot_routes_require_admin_and_session_ownership(snapshot_client, monkeypatch):
    client, workspace = snapshot_client
    url = "/api/workspace/snapshots"
    params = {"workspace": workspace, "session_id": "session-1"}
    assert client.get(url, params=params, headers={"x-test-user": "member"}).status_code == 403

    def not_owned(request, session_id, session_manager):
        assert session_id == "session-1"
        raise HTTPException(status_code=404, detail="Session not found")

    monkeypatch.setattr(workspace_routes, "_verify_session_owner", not_owned)
    response = client.get(url, params=params, headers={"x-test-user": "admin"})
    assert response.status_code == 404


def test_admin_browser_snapshot_route_uses_effective_owner(snapshot_client, monkeypatch):
    client, workspace = snapshot_client
    verified = []
    monkeypatch.setattr(workspace_routes, "_verify_session_owner", lambda request, session_id, manager: verified.append(session_id))
    response = client.get(
        "/api/workspace/snapshots",
        params={"workspace": workspace, "session_id": "session-1"},
        headers={"x-test-user": "admin"},
    )
    assert response.status_code == 200
    assert response.json() == {"snapshots": []}
    assert verified == ["session-1"]


def test_auth_disabled_snapshot_uses_shared_local_owner(snapshot_client, monkeypatch):
    client, workspace = snapshot_client
    monkeypatch.setenv("AUTH_ENABLED", "false")
    monkeypatch.setattr(workspace_routes, "owner_is_admin_or_single_user", lambda user: True)
    captured = []
    monkeypatch.setattr(workspace_routes, "list_snapshots", lambda root, owner, session: captured.append(owner) or [])
    response = client.get(
        "/api/workspace/snapshots",
        params={"workspace": workspace, "session_id": "session-1"},
    )
    assert response.status_code == 200
    assert captured == ["__odysseus_local__"]
