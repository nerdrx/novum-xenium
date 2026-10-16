import json

import pytest

from src.llm_core import _build_chatgpt_responses_payload, _stream_llm_inner


def _tool_schema():
    return {
        "type": "function",
        "function": {
            "name": "web_search",
            "description": "Search the web",
            "parameters": {
                "type": "object",
                "properties": {"query": {"type": "string"}},
                "required": ["query"],
            },
        },
    }


def test_subscription_payload_keeps_internal_tool_transcript_as_plain_text():
    payload = _build_chatgpt_responses_payload(
        "gpt-6.1-sol",
        [
            {"role": "user", "content": "Search for this"},
            {"role": "assistant", "content": None, "tool_calls": [{
                "id": "call_1",
                "type": "function",
                "function": {"name": "web_search", "arguments": '{"query":"topic"}'},
            }]},
            {"role": "tool", "tool_call_id": "call_1", "content": "Found it"},
        ],
        temperature=0.2,
        max_tokens=100,
        stream=True,
        tools=[_tool_schema()],
    )

    assert "tools" not in payload
    assert "tool_choice" not in payload
    assert payload["input"][-1] == {
        "role": "user", "content": [{"type": "input_text", "text": "Found it"}],
    }


class _Response:
    status_code = 200

    def __init__(self, lines):
        self.lines = lines

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return None

    async def aiter_lines(self):
        for line in self.lines:
            yield line


class _Client:
    def __init__(self, lines):
        self.response = _Response(lines)
        self.payload = None

    def stream(self, method, url, *, json, headers, timeout):
        self.payload = json
        return self.response


async def _run_subscription_stream(monkeypatch, lines, *, tool_choice_none=False):
    from src import llm_core

    client = _Client(lines)
    monkeypatch.setattr(llm_core, "_get_http_client", lambda: client)
    monkeypatch.setattr(llm_core, "_is_host_dead", lambda _url: False)
    monkeypatch.setattr(llm_core, "note_model_activity", lambda *_args: None)
    chunks = [chunk async for chunk in _stream_llm_inner(
        "https://chatgpt.com/backend-api/codex",
        "gpt-6.1-sol",
        [{"role": "user", "content": "Search for this"}],
        tools=[_tool_schema()],
        tool_choice_none=tool_choice_none,
    )]
    return client, chunks


@pytest.mark.asyncio
async def test_subscription_stream_ignores_provider_function_calls(monkeypatch):
    lines = [
        "event: response.output_item.added",
        "data: " + json.dumps({
            "type": "response.output_item.added",
            "output_index": 0,
            "item": {"id": "item_1", "type": "function_call", "call_id": "call_1", "name": "web_search", "arguments": ""},
        }),
        "event: response.function_call_arguments.delta",
        "data: " + json.dumps({
            "type": "response.function_call_arguments.delta",
            "output_index": 0,
            "item_id": "item_1",
            "delta": '{"query":"topic"}',
        }),
        "event: response.completed",
        "data: " + json.dumps({
            "type": "response.completed",
            "response": {"output": [{
                "id": "item_1", "type": "function_call", "call_id": "call_1",
                "name": "web_search", "arguments": '{"query":"topic"}',
            }]},
        }),
    ]
    client, chunks = await _run_subscription_stream(monkeypatch, lines)

    assert "tools" not in client.payload
    assert not any('"type": "tool_calls"' in chunk for chunk in chunks)
    assert chunks[-1] == "data: [DONE]\n\n"


@pytest.mark.asyncio
async def test_subscription_stream_does_not_emit_collected_provider_call(monkeypatch):
    lines = [
        "event: response.output_item.added",
        "data: " + json.dumps({
            "type": "response.output_item.added", "output_index": 0,
            "item": {"id": "item_1", "type": "function_call", "call_id": "call_1", "name": "web_search", "arguments": ""},
        }),
        "event: response.function_call_arguments.delta",
        "data: " + json.dumps({
            "type": "response.function_call_arguments.delta", "output_index": 0,
            "item_id": "item_1", "delta": '{"query":"topic"}',
        }),
        "event: response.function_call_arguments.done",
        "data: " + json.dumps({
            "type": "response.function_call_arguments.done", "output_index": 0,
            "item_id": "item_1", "arguments": '{"query":"topic"}',
        }),
        "event: response.completed",
        "data: " + json.dumps({"type": "response.completed", "response": {"output": []}}),
    ]

    _, chunks = await _run_subscription_stream(monkeypatch, lines)

    assert not any('"type": "tool_calls"' in chunk for chunk in chunks)
    assert chunks[-1] == "data: [DONE]\n\n"


@pytest.mark.asyncio
async def test_subscription_stream_completed_without_function_calls_emits_no_tool_event(monkeypatch):
    lines = [
        "event: response.completed",
        "data: " + json.dumps({"type": "response.completed", "response": {"output": []}}),
    ]

    _, chunks = await _run_subscription_stream(monkeypatch, lines)

    assert not any('"type": "tool_calls"' in chunk for chunk in chunks)
    assert chunks[-1] == "data: [DONE]\n\n"


@pytest.mark.asyncio
async def test_subscription_stream_omits_schemas_when_tool_choice_is_disabled(monkeypatch):
    lines = [
        "event: response.completed",
        "data: " + json.dumps({"type": "response.completed", "response": {"output": []}}),
    ]

    client, _ = await _run_subscription_stream(monkeypatch, lines, tool_choice_none=True)

    assert "tools" not in client.payload


@pytest.mark.asyncio
async def test_subscription_stream_failure_does_not_emit_collected_calls(monkeypatch):
    lines = [
        "event: response.output_item.added",
        "data: " + json.dumps({
            "type": "response.output_item.added", "output_index": 0,
            "item": {"id": "item_1", "type": "function_call", "call_id": "call_1", "name": "web_search", "arguments": ""},
        }),
        "event: response.failed",
        "data: " + json.dumps({"type": "response.failed", "error": {"message": "failed"}}),
    ]

    _, chunks = await _run_subscription_stream(monkeypatch, lines)

    assert not any('"type": "tool_calls"' in chunk for chunk in chunks)
    assert any(chunk.startswith("event: error") for chunk in chunks)
