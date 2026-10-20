import asyncio
import re
import httpx as real_httpx
import pytest

import src.tool_execution as te
from src.agent_loop import _is_host_bridge_failure_result


def test_tui_host_bridge_patch_url_replaces_run_endpoint():
    assert te._tui_host_bridge_patch_url({
        "surface": "odysseus-tui",
        "host_shell_bridge": {
            "url": "http://host.docker.internal:17654/run",
            "token": "secret",
        },
    }) == ("http://host.docker.internal:17654/patch", "secret")


def test_tui_host_bridge_patch_requires_authenticated_bridge():
    assert te._tui_host_bridge_patch_url({
        "surface": "odysseus-tui",
        "host_shell_bridge": {"url": "http://localhost:1234/run"},
    }) is None


def test_apply_patch_via_tui_host_bridge_posts_patch_and_preserves_result(monkeypatch):
    seen = {}

    class Response:
        status_code = 200

        def json(self):
            return {"output": "patched", "exit_code": 0, "files": ["app.py"]}

    class Client:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def post(self, url, **kwargs):
            seen.update(url=url, kwargs=kwargs)
            return Response()

    class Httpx:
        Timeout = real_httpx.Timeout
        AsyncClient = lambda self, **_kwargs: Client()

    monkeypatch.setitem(__import__("sys").modules, "httpx", Httpx())
    result = asyncio.run(te._apply_patch_via_tui_host_bridge(
        "*** Begin Patch\n*** End Patch",
        {
            "surface": "odysseus-tui",
            "host_shell_bridge": {"url": "http://127.0.0.1:17654/run", "token": "secret"},
        },
    ))
    assert result["exit_code"] == 0
    assert seen["url"] == "http://127.0.0.1:17654/patch"
    assert seen["kwargs"]["headers"]["x-odysseus-tui-bridge-token"] == "secret"
    assert re.fullmatch(
        r"[A-Za-z0-9_-]+", seen["kwargs"]["json"]["request_id"]
    )


def test_apply_patch_via_tui_host_bridge_rejects_malformed_exit_code(monkeypatch):
    from src import tool_execution as te

    class Response:
        status_code = 200

        def json(self):
            return {"output": "patched", "exit_code": "zero"}

    class Client:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def post(self, *_args, **_kwargs):
            return Response()

    import httpx

    monkeypatch.setattr(httpx, "AsyncClient", Client)
    result = asyncio.run(te._apply_patch_via_tui_host_bridge(
        "*** Begin Patch\n*** End Patch",
        {
            "surface": "odysseus-tui",
            "host_shell_bridge": {
                "url": "http://127.0.0.1:17654/run",
                "token": "secret",
            },
        },
    ))

    assert result == {
        "error": "apply_patch: host bridge returned invalid exit_code",
        "exit_code": 1,
    }


def test_cancelled_apply_patch_notifies_tui_host_bridge(monkeypatch):
    posted = asyncio.Event()
    seen = {}

    class Client:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def post(self, _url, **kwargs):
            seen["request_id"] = kwargs["json"]["request_id"]
            posted.set()
            await asyncio.Future()

    class Httpx:
        Timeout = real_httpx.Timeout
        AsyncClient = lambda self, **_kwargs: Client()

    cancelled = []

    async def fake_cancel(_bridge, request_id):
        cancelled.append(request_id)

    monkeypatch.setitem(__import__("sys").modules, "httpx", Httpx())
    monkeypatch.setattr(te, "_cancel_bridge_request", fake_cancel)

    async def scenario():
        task = asyncio.create_task(te._apply_patch_via_tui_host_bridge(
            "*** Begin Patch\n*** End Patch",
            {
                "surface": "odysseus-tui",
                "host_shell_bridge": {
                    "url": "http://127.0.0.1:17654/run", "token": "secret",
                },
            },
        ))
        await posted.wait()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        await asyncio.sleep(0)

    asyncio.run(scenario())
    assert cancelled == [seen["request_id"]]


def test_apply_patch_via_tui_host_bridge_rejects_invalid_success_payload(monkeypatch):
    class Response:
        status_code = 200

        def json(self):
            raise ValueError("not json")

    class Client:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def post(self, *_args, **_kwargs):
            return Response()

    class Httpx:
        Timeout = real_httpx.Timeout
        AsyncClient = lambda self, **_kwargs: Client()

    monkeypatch.setitem(__import__("sys").modules, "httpx", Httpx())
    result = asyncio.run(te._apply_patch_via_tui_host_bridge(
        "*** Begin Patch\n*** End Patch",
        {
            "surface": "odysseus-tui",
            "host_shell_bridge": {"url": "http://127.0.0.1:17654/run", "token": "secret"},
        },
    ))

    assert result == {
        "error": "apply_patch: host bridge returned invalid payload",
        "exit_code": 1,
    }


def test_apply_patch_via_tui_host_bridge_infers_failure_from_error_payload(monkeypatch):
    class Response:
        status_code = 200

        def json(self):
            return {"error": "apply_patch: context mismatch"}

    class Client:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def post(self, *_args, **_kwargs):
            return Response()

    class Httpx:
        Timeout = real_httpx.Timeout
        AsyncClient = lambda self, **_kwargs: Client()

    monkeypatch.setitem(__import__("sys").modules, "httpx", Httpx())
    result = asyncio.run(te._apply_patch_via_tui_host_bridge(
        "*** Begin Patch\n*** End Patch",
        {
            "surface": "odysseus-tui",
            "host_shell_bridge": {"url": "http://127.0.0.1:17654/run", "token": "secret"},
        },
    ))

    assert result["exit_code"] == 1
    assert "context mismatch" in result["error"]


def test_apply_patch_bridge_error_overrides_false_success_code(monkeypatch):
    class Response:
        status_code = 500

        def json(self):
            return {"error": "host failed", "exit_code": 0}

    class Client:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def post(self, *_args, **_kwargs):
            return Response()

    class Httpx:
        Timeout = real_httpx.Timeout
        AsyncClient = lambda self, **_kwargs: Client()

    monkeypatch.setitem(__import__("sys").modules, "httpx", Httpx())
    result = asyncio.run(te._apply_patch_via_tui_host_bridge(
        "*** Begin Patch\n*** End Patch",
        {
            "surface": "odysseus-tui",
            "host_shell_bridge": {
                "url": "http://127.0.0.1:17654/run",
                "token": "secret",
            },
        },
    ))

    assert result == {"error": "host failed", "exit_code": 1}


@pytest.mark.parametrize(
    ("helper", "status", "payload", "text", "expected_error", "exit_code", "terminal"),
    [
        ("patch", 200, [], "", "bridge returned invalid payload", 1, True),
        ("patch", 200, {"exit_code": "zero"}, "", "bridge returned invalid exit_code", 1, True),
        ("post", 200, [], "", "bridge returned invalid payload", 1, True),
        ("post", 200, {}, "", "bridge returned invalid payload", 1, True),
        ("post", 200, {"exit_code": "zero"}, "", "bridge returned invalid exit_code", 1, True),
        ("post", 200, None, "unexpected upstream reply", "bridge returned invalid JSON: unexpected upstream reply", 1, True),
        ("post", 200, None, "", "bridge returned invalid JSON", 1, True),
        ("post", 502, {"detail": "proxy failure"}, "", "bridge returned HTTP 502", 1, True),
        ("post", 200, {"error": "File not found: example.txt", "exit_code": 1}, "", "File not found", 1, False),
        ("post", 200, {"output": "printed: host bridge unavailable", "exit_code": 0}, "", "printed", 0, False),
    ],
)
def test_malformed_bridge_protocol_results_stop_turn_without_stopping_application_errors(
    monkeypatch, helper, status, payload, text, expected_error, exit_code, terminal,
):
    class Response:
        status_code = status

        def __init__(self):
            self.text = text

        def json(self):
            if payload is None:
                raise ValueError("invalid JSON")
            return payload

    class Client:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def post(self, *_args, **_kwargs):
            return Response()

    import httpx

    monkeypatch.setattr(httpx, "AsyncClient", Client)

    async def call():
        if helper == "patch":
            return await te._apply_patch_via_tui_host_bridge(
                "synthetic patch",
                {
                    "surface": "odysseus-tui",
                    "host_shell_bridge": {
                        "url": "http://127.0.0.1:17654/run",
                        "token": "fake-token",
                    },
                },
            )
        return await te._bridge_post(
            {"url": "http://127.0.0.1:17654/run", "token": "fake-token"},
            "/read_file",
            {"path": "example.txt"},
            timeout_s=5,
            err_prefix="read_file",
        )

    result = asyncio.run(call())
    assert expected_error in result.get("error", result.get("output", ""))
    assert result["exit_code"] == exit_code
    assert _is_host_bridge_failure_result(result) is terminal
