"""Tests for endpoint-scoped opt-in thinking-template overrides."""
import asyncio
import json

import httpx
import pytest

from src import llm_core


LOCAL_URL = "http://127.0.0.1:8080/v1/chat/completions"
CLOUD_URL = "https://api.example.test/v1/chat/completions"
CANONICAL_MODEL = "nx-model-5"


def _props(*, template="{{ enable_thinking }}", caps=None, defaults=None):
    return {
        "model_alias": CANONICAL_MODEL,
        "chat_template": template,
        "chat_template_caps": {} if caps is None else caps,
        "default_generation_settings": {} if defaults is None else defaults,
    }


def _inventory(*, model=CANONICAL_MODEL, aliases=("local-model",), owner="llamacpp"):
    return {"data": [{"id": model, "aliases": list(aliases), "owned_by": owner}]}


class _PropsResponse:
    def __init__(self, body, status=200, error=None):
        self.body = body
        self.status_code = status
        self.error = error

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    def raise_for_status(self):
        if self.error:
            raise self.error
        if self.status_code >= 300:
            request = httpx.Request("GET", "http://127.0.0.1/props")
            response = httpx.Response(self.status_code, request=request)
            raise httpx.HTTPStatusError("bad status", request=request, response=response)

    async def aiter_bytes(self):
        yield self.body


class _PropsClient:
    def __init__(self, responses, calls):
        self.responses = responses
        self.calls = calls

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    def stream(self, method, url, **kwargs):
        self.calls.append((method, url, kwargs))
        return self.responses.get(url, self.responses["default"])


def _mock_props(monkeypatch, response, *, inventory=None):
    calls = []
    client_options = []
    responses = {"default": response}
    if inventory is not None:
        responses["http://127.0.0.1:8080/v1/models"] = inventory
        responses["http://127.0.0.1:8080/props"] = response
    else:
        responses["http://127.0.0.1:8080/v1/models"] = _PropsResponse(
            json.dumps(_inventory()).encode()
        )
        responses["http://127.0.0.1:8080/props"] = response
    monkeypatch.setattr(
        llm_core.httpx,
        "AsyncClient",
        lambda **kwargs: (client_options.append(kwargs) or _PropsClient(responses, calls)),
    )
    return calls, client_options


def test_auto_and_cloud_modes_do_not_probe_props(monkeypatch):
    def unexpected(**kwargs):
        raise AssertionError("unexpected network client")

    monkeypatch.setattr(llm_core.httpx, "AsyncClient", unexpected)
    assert asyncio.run(llm_core._local_thinking_override(LOCAL_URL, "m", {}, "auto")) is None
    assert asyncio.run(llm_core._local_thinking_override(CLOUD_URL, "m", {}, "on")) is None


@pytest.mark.parametrize(("mode", "expected"), [("on", True), ("off", False)])
def test_advertised_local_template_receives_requested_override(monkeypatch, mode, expected):
    response = _PropsResponse(json.dumps(_props()).encode())
    calls, client_options = _mock_props(monkeypatch, response)
    result = asyncio.run(llm_core._local_thinking_override(
        LOCAL_URL, "local-model", {"X-Test": "header"}, mode,
    ))
    assert result is expected
    assert len(calls) == 2
    assert calls[0][0:2] == ("GET", "http://127.0.0.1:8080/v1/models")
    assert calls[0][2] == {"headers": {"X-Test": "header"}}
    method, url, kwargs = calls[1]
    assert method == "GET"
    assert url == "http://127.0.0.1:8080/props"
    assert kwargs["params"] == {"model": CANONICAL_MODEL}
    assert kwargs["headers"] == {"X-Test": "header"}
    assert client_options[0]["follow_redirects"] is False


@pytest.mark.parametrize("body", [
    b"not json",
    json.dumps({"model_alias": CANONICAL_MODEL, "chat_template": "{{ enable_thinking }}"}).encode(),
    json.dumps(_props(template="{{ other_flag }}")).encode(),
    json.dumps(_props(caps=[])).encode(),
    b"{}",
])
def test_unverified_template_shapes_do_not_override(monkeypatch, body):
    _mock_props(monkeypatch, _PropsResponse(body))
    assert asyncio.run(llm_core._local_thinking_override(LOCAL_URL, "local-model", {}, "on")) is None


@pytest.mark.parametrize("inventory", [
    _inventory(owner="other-provider"),
    _inventory(model="different-model", aliases=("different-alias",)),
])
def test_only_owned_model_inventory_match_can_select_props(monkeypatch, inventory):
    calls, _ = _mock_props(
        monkeypatch,
        _PropsResponse(json.dumps(_props()).encode()),
        inventory=_PropsResponse(json.dumps(inventory).encode()),
    )
    assert asyncio.run(llm_core._local_thinking_override(LOCAL_URL, "local-model", {}, "on")) is None
    assert len(calls) == 1
    assert calls[0][1].endswith("/v1/models")


def test_mismatched_props_identity_does_not_override(monkeypatch):
    mismatched = {**_props(), "model_alias": "another-model"}
    calls, _ = _mock_props(
        monkeypatch,
        _PropsResponse(json.dumps(mismatched).encode()),
    )
    assert asyncio.run(llm_core._local_thinking_override(LOCAL_URL, "local-model", {}, "off")) is None
    assert len(calls) == 2
    assert calls[1][2]["params"] == {"model": CANONICAL_MODEL}


@pytest.mark.parametrize("response", [
    _PropsResponse(b"", status=302),
    _PropsResponse(b"", error=httpx.ConnectError("offline")),
    _PropsResponse(b"x" * (1024 * 1024 + 1)),
])
def test_redirect_failure_and_oversize_fail_closed(monkeypatch, response):
    calls, client_options = _mock_props(monkeypatch, response)
    assert asyncio.run(llm_core._local_thinking_override(LOCAL_URL, "local-model", {}, "off")) is None
    if calls:
        assert client_options[0]["follow_redirects"] is False


class _StreamResponse:
    status_code = 200

    async def aiter_lines(self):
        yield 'data: {"choices":[{"delta":{"content":"ok"}}]}'
        yield "data: [DONE]"

    async def aread(self):
        return b""


class _StreamContext:
    async def __aenter__(self):
        return _StreamResponse()

    async def __aexit__(self, *args):
        return False


class _CaptureStreamClient:
    def __init__(self):
        self.payload = None

    def stream(self, method, url, **kwargs):
        self.payload = kwargs["json"]
        return _StreamContext()


@pytest.mark.parametrize(("mode", "expected"), [
    ("auto", None),
    ("on", True),
    ("off", False),
])
def test_stream_payload_only_overrides_for_explicit_supported_mode(monkeypatch, mode, expected):
    client = _CaptureStreamClient()
    monkeypatch.setattr(llm_core, "_get_http_client", lambda: client)
    monkeypatch.setattr(llm_core, "_is_host_dead", lambda _url: False)
    monkeypatch.setattr(llm_core, "note_model_activity", lambda *args, **kwargs: None)
    monkeypatch.setattr(llm_core, "_clear_host_dead", lambda *args, **kwargs: None)
    async def advertised(*args, **kwargs):
        return None if expected is None else expected
    monkeypatch.setattr(llm_core, "_local_thinking_override", advertised)

    async def run():
        return [chunk async for chunk in llm_core.stream_llm(
            LOCAL_URL, "local-model", [{"role": "user", "content": "hello"}],
            reasoning_mode=mode,
        )]

    asyncio.run(run())
    if expected is None:
        assert "chat_template_kwargs" not in client.payload
    else:
        assert client.payload["chat_template_kwargs"] == {"enable_thinking": expected}


def test_nonstream_payload_forwards_explicit_override_and_skips_response_cache(monkeypatch):
    captured = {}

    async def advertised(url, model, headers, mode):
        captured["mode"] = mode
        return False

    async def post(_client, _url, _headers, **kwargs):
        captured["payload"] = kwargs["json"]

        class Response:
            is_success = True
            status_code = 200
            text = ""

            def json(self):
                return {"choices": [{"message": {"content": "ok"}}]}

        return Response()

    monkeypatch.setattr(llm_core, "_local_thinking_override", advertised)
    monkeypatch.setattr(llm_core, "httpx_post_kimi_aware_async", post)
    monkeypatch.setattr(llm_core, "_get_http_client", lambda: object())
    monkeypatch.setattr(llm_core, "_is_host_dead", lambda _url: False)
    monkeypatch.setattr(llm_core, "note_model_activity", lambda *args, **kwargs: None)
    monkeypatch.setattr(llm_core, "_clear_host_dead", lambda *args, **kwargs: None)
    monkeypatch.setattr(
        llm_core, "_get_cached_response",
        lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("override must bypass cache")),
    )

    result = asyncio.run(llm_core.llm_call_async(
        LOCAL_URL, "local-model", [{"role": "user", "content": "hello"}],
        reasoning_mode="off",
    ))
    assert result == "ok"
    assert captured["mode"] == "off"
    assert captured["payload"]["chat_template_kwargs"] == {"enable_thinking": False}
