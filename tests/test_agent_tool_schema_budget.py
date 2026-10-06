"""Regressions for native tool schemas consuming the route context window."""

import asyncio
import json

import pytest

import src.agent_loop as loop
from src.model_context import estimate_tokens, estimate_tool_schema_tokens


@pytest.mark.parametrize("rounds", [1, 2])
def test_candidate_budget_includes_tools_on_first_and_later_rounds(monkeypatch, rounds):
    schema = {"type": "function", "function": {
        "name": "update_plan", "description": "Tool description. " * 160,
        "parameters": {"type": "object", "properties": {"plan": {"type": "string"}}},
    }}
    monkeypatch.setattr(loop, "FUNCTION_TOOL_SCHEMAS", [schema])
    monkeypatch.setattr(loop, "get_setting", lambda key, default=None: default)
    monkeypatch.setattr(loop, "get_mcp_manager", lambda: None)
    monkeypatch.setattr(loop, "blocked_tools_for_owner", lambda owner: set())
    monkeypatch.setattr("src.model_context.budget_context_for_model", lambda *args, **kwargs: 6000)
    monkeypatch.setattr(loop, "_build_system_prompt", lambda messages, *args, **kwargs: (list(messages), []))
    monkeypatch.setattr(loop, "_agent_route_tool_mode", lambda *args, **kwargs: (True, False, False))
    requests = []

    async def fake_execute(block, **kwargs):
        return block.tool_type, {"output": "Plan saved. " * 500, "exit_code": 0}

    async def fake_stream(candidates, messages, **kwargs):
        request = await kwargs["candidate_request_factory"](0, *candidates[0])
        tools = request["kwargs"]["tools"]
        shaped = request["messages"]
        requests.append(shaped)
        assert tools == [schema]
        assert estimate_tokens(shaped) + estimate_tool_schema_tokens(tools) <= 5100 - 2048
        assert any(m["role"] == "user" and "USER_QUESTION" in m["content"] for m in shaped)
        if len(requests) < rounds:
            yield "data: " + json.dumps({"type": "tool_calls", "calls": [
                {"id": "plan_call", "name": "update_plan", "arguments": '{"plan":"check"}'}
            ]}) + "\n\n"
        else:
            yield 'data: {"delta": "Done."}\n\n'
        yield "data: [DONE]\n\n"

    monkeypatch.setattr(loop, "execute_tool_block", fake_execute)
    monkeypatch.setattr(loop, "stream_llm_with_fallback", fake_stream)

    async def run():
        return [chunk async for chunk in loop.stream_agent_loop(
            "http://127.0.0.1:11434/v1", "test-model",
            [{"role": "system", "content": "Be helpful."},
             {"role": "user", "content": "Old query. " * 1500},
             {"role": "assistant", "content": "Old answer. " * 1500},
             {"role": "user", "content": "USER_QUESTION: update the plan."}],
            max_rounds=rounds, relevant_tools={"update_plan"}, _is_teacher_run=True,
        )]

    events = asyncio.run(run())
    metrics = next(json.loads(chunk[6:].strip())["data"] for chunk in events
                   if chunk.startswith('data: ') and '"type": "metrics"' in chunk)
    inspection = metrics["context_inspection"]
    assert inspection["categories"]["native_tool_schemas"]["tokens"] == estimate_tool_schema_tokens([schema])
    assert inspection["total_tokens"] == estimate_tokens(requests[-1]) + estimate_tool_schema_tokens([schema])
    assert inspection["context_length"] == 6000
    assert inspection["trimmed"]["removed_tokens"] > 0
    assert len(requests) == rounds


def _browser_schemas(count=42):
    return [
        {
            "type": "function",
            "function": {
                "name": f"mcp__builtin_browser__browser_action_{index}",
                "description": "Browser operation details. " + "x" * 720,
                "parameters": {"type": "object", "properties": {}},
            },
        }
        for index in range(count)
    ]


def _configure(monkeypatch, schemas, request_capture):
    import src.model_context as model_context

    monkeypatch.setattr(loop, "get_setting", lambda key, default=None: default)
    monkeypatch.setattr(loop, "get_mcp_manager", lambda: None)
    monkeypatch.setattr(loop, "blocked_tools_for_owner", lambda owner: set())
    monkeypatch.setattr(
        loop, "_agent_route_tool_mode", lambda *args, **kwargs: (True, False, False)
    )
    monkeypatch.setattr(
        model_context,
        "budget_context_for_model",
        lambda *args, **kwargs: 16_000,
    )
    monkeypatch.setattr(
        loop,
        "_build_system_prompt",
        lambda messages, *args, **kwargs: (list(messages), list(schemas)),
    )

    async def fake_stream(candidates, messages, **kwargs):
        request = await kwargs["candidate_request_factory"](0, *candidates[0])
        request_capture.append(request)
        yield 'data: {"delta":"ok"}\n\n'
        yield "data: [DONE]\n\n"

    monkeypatch.setattr(loop, "stream_llm_with_fallback", fake_stream)


def test_native_browser_schema_budget_keeps_question_and_latest_tool_exchange(monkeypatch):
    schemas = _browser_schemas()
    import src.model_context as model_context

    assert model_context.estimate_tool_schema_tokens(schemas) > 13_000
    used_name = schemas[17]["function"]["name"]
    exchange = [
        {"role": "user", "content": "Open the project page and click Save."},
        {
            "role": "assistant",
            "content": None,
            "tool_calls": [{
                "id": "browser-call",
                "type": "function",
                "function": {"name": used_name, "arguments": '{"target":"Save"}'},
            }],
        },
        {"role": "tool", "tool_call_id": "browser-call", "content": "Saved page."},
    ]
    requests = []
    _configure(monkeypatch, schemas, requests)

    async def run():
        return [event async for event in loop.stream_agent_loop(
            "https://local.test/v1",
            "deepseek-chat",
            exchange,
            relevant_tools={schema["function"]["name"] for schema in schemas},
            max_rounds=1,
            _is_teacher_run=True,
        )]

    asyncio.run(run())
    assert len(requests) == 1
    request = requests[0]
    assert request["messages"][-3:] == exchange
    sent_schemas = request["kwargs"]["tools"]
    assert used_name in {schema["function"]["name"] for schema in sent_schemas}
    assert model_context.estimate_tool_schema_tokens(sent_schemas) <= 4_000
    assert model_context.estimate_tokens(request["messages"]) + model_context.estimate_tool_schema_tokens(sent_schemas) + 2_048 <= 16_000


def test_current_user_that_cannot_fit_fails_before_model_call(monkeypatch):
    schemas = _browser_schemas()
    requests = []
    _configure(monkeypatch, schemas, requests)

    async def run():
        return [event async for event in loop.stream_agent_loop(
            "https://local.test/v1",
            "deepseek-chat",
            [{"role": "user", "content": "Do this exactly: " + "important " * 30_000}],
            relevant_tools={schema["function"]["name"] for schema in schemas},
            max_rounds=1,
            _is_teacher_run=True,
        )]

    with pytest.raises(ValueError, match="complete current user request"):
        asyncio.run(run())
    assert requests == []


def test_no_tools_have_no_schema_reservation():
    assert estimate_tool_schema_tokens(None) == estimate_tool_schema_tokens([]) == 0
