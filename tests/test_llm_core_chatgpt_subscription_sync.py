import asyncio
import json

import httpx
import pytest
from fastapi import HTTPException

from src import llm_core


_URL = "https://chatgpt.com/backend-api/codex"


def _client_for(response, captured):
    def handler(request):
        item = {
            "url": str(request.url),
            "headers": dict(request.headers),
            "payload": json.loads(request.content),
        }
        captured.setdefault("requests", []).append(item)
        captured.update(item)
        return response

    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


def _multimodal_messages():
    return [{
        "role": "user",
        "content": [
            {"type": "text", "text": "Describe this image"},
            {"type": "image_url", "image_url": {
                "url": "data:image/png;base64,AAECAw==", "detail": "high",
            }},
        ],
    }]


def test_sync_llm_call_uses_responses_sse_and_preserves_image_input(monkeypatch):
    captured = {}
    sse = (
        'event: response.output_text.delta\n'
        'data: {"type":"response.output_text.delta","delta":"A cat."}\n\n'
        'event: response.completed\n'
        'data: {"type":"response.completed","response":{"usage":{"input_tokens":3,"output_tokens":2}}}\n\n'
    )
    monkeypatch.setattr(
        llm_core, "_new_sync_llm_http_client",
        lambda: _client_for(httpx.Response(200, text=sse), captured),
    )

    result = llm_core.llm_call(
        _URL, "vision-model", _multimodal_messages(),
        headers={"Authorization": "Bearer test-token"}, max_tokens=64,
    )

    assert result == "A cat."
    assert captured["url"] == _URL + "/responses"
    assert captured["payload"]["stream"] is True
    assert captured["payload"]["input"][0]["content"] == [
        {"type": "input_text", "text": "Describe this image"},
        {"type": "input_image", "image_url": "data:image/png;base64,AAECAw==", "detail": "high"},
    ]


def test_sync_llm_call_inside_running_loop_uses_private_loop_safely(monkeypatch):
    captured = {}
    sse = (
        'event: response.output_text.delta\n'
        'data: {"type":"response.output_text.delta","delta":"Ready."}\n\n'
        'event: response.completed\n'
        'data: {"type":"response.completed","response":{}}\n\n'
    )
    monkeypatch.setattr(
        llm_core, "_new_sync_llm_http_client",
        lambda: _client_for(httpx.Response(200, text=sse), captured),
    )

    async def invoke_sync_api():
        first = llm_core.llm_call(_URL, "vision-model", [{"role": "user", "content": "loop caller one"}])
        second = llm_core.llm_call(_URL, "vision-model", [{"role": "user", "content": "loop caller two"}])
        return first, second

    assert asyncio.run(invoke_sync_api()) == ("Ready.", "Ready.")
    assert len(captured["requests"]) == 2
    assert captured["url"] == _URL + "/responses"


def test_sync_llm_call_propagates_sse_auth_error(monkeypatch):
    captured = {}
    sse = (
        'event: error\n'
        'data: {"type":"error","error":{"status":401,"message":"Reconnect the provider."}}\n\n'
    )
    monkeypatch.setattr(
        llm_core, "_new_sync_llm_http_client",
        lambda: _client_for(httpx.Response(200, text=sse), captured),
    )

    with pytest.raises(HTTPException) as exc:
        llm_core.llm_call(_URL, "vision-model", [{"role": "user", "content": "error case"}])
    assert exc.value.status_code == 401
    assert "Reconnect the provider" in str(exc.value.detail)


def test_done_return_closes_nested_stream_generators_before_loop_shutdown(monkeypatch):
    closed = []

    async def mocked_inner_stream(*_args, **_kwargs):
        try:
            yield 'data: {"delta":"finished"}\n\n'
            yield "data: [DONE]\n\n"
        finally:
            closed.append("inner")

    monkeypatch.setattr(llm_core, "_stream_llm_inner", mocked_inner_stream)

    result = asyncio.run(llm_core.llm_call_async(
        _URL, "vision-model", [{"role": "user", "content": "close test"}],
    ))

    assert result == "finished"
    assert closed == ["inner"]


def test_real_done_sse_closes_http_stream_before_loop_shutdown(monkeypatch):
    captured = {}
    sse = (
        'event: response.output_text.delta\n'
        'data: {"type":"response.output_text.delta","delta":"finished"}\n\n'
        'event: response.completed\n'
        'data: {"type":"response.completed","response":{}}\n\n'
    )
    monkeypatch.setattr(
        llm_core, "_get_http_client",
        lambda: _client_for(httpx.Response(200, text=sse), captured),
    )

    result = asyncio.run(llm_core.llm_call_async(
        _URL, "vision-model", [{"role": "user", "content": "real close test"}],
    ))

    assert result == "finished"
    assert len(captured["requests"]) == 1
