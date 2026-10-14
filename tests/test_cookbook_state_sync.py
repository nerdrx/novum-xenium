import json
import time

import pytest
from starlette.requests import Request

import routes.cookbook_routes as cookbook_routes


def _post_request(data):
    body = json.dumps(data).encode()
    sent = False

    async def receive():
        nonlocal sent
        if sent:
            return {"type": "http.disconnect"}
        sent = True
        return {"type": "http.request", "body": body, "more_body": False}

    return Request(
        {
            "type": "http",
            "method": "POST",
            "path": "/api/cookbook/state",
            "headers": [(b"content-type", b"application/json")],
            "query_string": b"",
        },
        receive=receive,
    )


def _save_state_endpoint():
    router = cookbook_routes.setup_cookbook_routes()
    return next(
        route.endpoint
        for route in router.routes
        if route.path == "/api/cookbook/state" and "POST" in route.methods
    )


def _status_request():
    async def receive():
        return {"type": "http.disconnect"}

    return Request(
        {
            "type": "http",
            "method": "GET",
            "path": "/api/cookbook/tasks/status",
            "headers": [],
            "query_string": b"",
        },
        receive=receive,
    )


@pytest.mark.parametrize("status", ["running", "starting", "ready"])
@pytest.mark.asyncio
async def test_stale_sync_preserves_omitted_active_server_task(tmp_path, monkeypatch, status):
    state_path = tmp_path / "cookbook-state.json"
    stale_task = {
        "id": "serve-flux",
        "sessionId": "serve-flux",
        "type": "serve",
        "status": status,
        "ts": int(time.time() * 1000) - 120_000,
    }
    state_path.write_text(json.dumps({"tasks": [stale_task]}), encoding="utf-8")
    monkeypatch.setattr(cookbook_routes, "COOKBOOK_STATE_FILE", str(state_path))
    monkeypatch.setattr(cookbook_routes, "require_admin", lambda _request: None)

    result = await _save_state_endpoint()(_post_request({"tasks": []}))

    saved = json.loads(state_path.read_text(encoding="utf-8"))
    assert result["preserved"] == 1
    assert saved["tasks"] == [stale_task]


@pytest.mark.asyncio
async def test_explicit_removed_task_tombstone_removes_running_server(tmp_path, monkeypatch):
    state_path = tmp_path / "cookbook-state.json"
    stale_task = {
        "id": "serve-flux",
        "sessionId": "serve-flux",
        "type": "serve",
        "status": "running",
        "ts": int(time.time() * 1000) - 120_000,
    }
    state_path.write_text(json.dumps({"tasks": [stale_task]}), encoding="utf-8")
    monkeypatch.setattr(cookbook_routes, "COOKBOOK_STATE_FILE", str(state_path))
    monkeypatch.setattr(cookbook_routes, "require_admin", lambda _request: None)

    await _save_state_endpoint()(
        _post_request({"tasks": [], "removedTasks": {"serve-flux": int(time.time() * 1000)}})
    )

    saved = json.loads(state_path.read_text(encoding="utf-8"))
    assert saved["tasks"] == []
    assert "serve-flux" in saved["removedTasks"]


@pytest.mark.asyncio
@pytest.mark.parametrize("alive", [True, False])
async def test_local_terminal_serve_preserves_provider_during_status_poll(tmp_path, monkeypatch, alive):
    state_path = tmp_path / "cookbook-state.json"
    command = "sd-server-vulkan --listen-port 8123 --backend diffusion=vulkan0"
    state_path.write_text(
        json.dumps({
            "tasks": [{
                "id": "serve-live",
                "sessionId": "serve-6e4b6c80",
                "name": "FLUX",
                "type": "serve",
                "status": "stopped",
                "output": "",
                "payload": {"_cmd": command},
            }],
        }),
        encoding="utf-8",
    )
    monkeypatch.setattr(cookbook_routes, "COOKBOOK_STATE_FILE", str(state_path))
    monkeypatch.setattr(cookbook_routes, "require_admin", lambda _request: None)
    tmux_calls = []

    def fake_run(args, **_kwargs):
        tmux_calls.append(args)
        if args[1] == "has-session":
            return type("Result", (), {"returncode": 0 if alive else 1, "stdout": "", "stderr": ""})()
        if args[1] == "capture-pane":
            return type("Result", (), {"returncode": 0, "stdout": "realimage started", "stderr": ""})()
        raise AssertionError(f"Unexpected process call: {args!r}")

    class ModelsResponse:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def read(self):
            return b'{"data":[{"id":"sd-cpp-local"}]}'

    deleted_endpoints = []
    monkeypatch.setattr(cookbook_routes.subprocess, "run", fake_run)
    monkeypatch.setattr(cookbook_routes.urllib.request, "urlopen", lambda *_args, **_kwargs: ModelsResponse())
    monkeypatch.setattr(
        cookbook_routes,
        "_delete_stable_diffusion_cpp_endpoint",
        lambda *args: deleted_endpoints.append(args),
    )

    status_endpoint = next(
        route.endpoint
        for route in cookbook_routes.setup_cookbook_routes().routes
        if route.path == "/api/cookbook/tasks/status" and "GET" in route.methods
    )
    result = await status_endpoint(_status_request())

    assert [call[1] for call in tmux_calls] == (["has-session", "capture-pane"] if alive else ["has-session"])
    assert result["tasks"][0]["status"] == ("ready" if alive else "stopped")
    assert deleted_endpoints == []
