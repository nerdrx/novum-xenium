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
    used_schema_tokens = model_context.estimate_tool_schema_tokens([schemas[17]])
    assert model_context.estimate_tool_schema_tokens(sent_schemas) <= 4_000 + used_schema_tokens
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


@pytest.mark.parametrize("context,configured", [(0, 6000), (6000, 6000), (128000, 3000), (0, 3000)])
@pytest.mark.parametrize("selection", ["forced", "retrieved"])
@pytest.mark.parametrize("core_first", [True, False])
def test_browser_bundle_respects_actual_budget(monkeypatch, context, configured, selection, core_first):
    import src.model_context as model_context
    schemas = _browser_schemas(38)
    for schema, action in zip(schemas, ["navigate", "snapshot", "tabs"]):
        schema["function"]["name"] = "mcp__builtin_browser__browser_" + action
    forced = {schema["function"]["name"] for schema in schemas[:13]}
    assert estimate_tool_schema_tokens(schemas[:13]) > 1500
    if not core_first:
        # MCP registration order is not relevance order. A retrieved whole
        # family must still offer navigation/read tools under a small cap.
        schemas = schemas[3:] + schemas[:3]
        schemas[0]["function"]["name"] = "mcp__builtin_browser__browser_close"
    requests = []
    _configure(monkeypatch, schemas, requests)
    monkeypatch.setattr(model_context, "budget_context_for_model", lambda *a, **k: context)
    monkeypatch.setattr(loop, "get_setting", lambda key, default=None: configured if key == "agent_input_token_budget" else default)
    question = "https://github.com/nerdrx/zVram check this out"

    async def run():
        return [event async for event in loop.stream_agent_loop(
            "https://local.test/v1", "gpt-6.1-sol",
            [{"role": "system", "content": "Current instructions. " * 500},
             {"role": "user", "content": "https://github.com/nerdrx/zVram check this out"},
             {"role": "assistant", "content": "Old reply. " * 1500},
             {"role": "user", "content": question}],
            forced_tools=forced if selection == "forced" else None,
            relevant_tools={schema["function"]["name"] for schema in schemas},
            max_rounds=1, _is_teacher_run=True,
        )]

    asyncio.run(run())
    assert len(requests) == 1
    request = requests[0]
    selected = request["kwargs"]["tools"]
    names = {schema["function"]["name"] for schema in selected}
    from src.context_budget import compute_input_token_budget, budget_is_explicit
    limit = compute_input_token_budget(configured, context, budget_is_explicit(configured))
    assert "mcp__builtin_browser__browser_navigate" in names
    if limit >= 5100:
        assert "mcp__builtin_browser__browser_snapshot" in names
    assert estimate_tool_schema_tokens(selected) <= max(256, min(8192, (context or limit) // 4, limit // 3))
    assert any(m["role"] == "user" and m["content"] == question for m in request["messages"])
    assert estimate_tokens(request["messages"]) + estimate_tool_schema_tokens(selected) + 1024 <= limit


@pytest.mark.parametrize("context", [0, 128000])
def test_impossibly_small_explicit_budget_fails_before_provider(monkeypatch, context):
    import src.model_context as model_context
    schemas = _browser_schemas(38)
    requests = []
    _configure(monkeypatch, schemas, requests)
    monkeypatch.setattr(model_context, "budget_context_for_model", lambda *a, **k: context)
    monkeypatch.setattr(loop, "get_setting", lambda key, default=None: 100 if key == "agent_input_token_budget" else default)

    async def run():
        return [event async for event in loop.stream_agent_loop(
            "https://local.test/v1", "gpt-6.1-sol", [{"role": "user", "content": "Use the browser."}],
            forced_tools={schema["function"]["name"] for schema in schemas[:13]},
            relevant_tools={schema["function"]["name"] for schema in schemas},
            max_rounds=1, _is_teacher_run=True,
        )]

    with pytest.raises(ValueError, match="Agent context budget cannot fit"):
        asyncio.run(run())
    assert requests == []


def test_browser_priority_does_not_restore_disabled_entry_points(monkeypatch):
    schemas = _browser_schemas(38)
    disabled = {
        "mcp__builtin_browser__browser_navigate",
        "mcp__builtin_browser__browser_snapshot",
    }
    for schema, name in zip(schemas[-2:], sorted(disabled)):
        schema["function"]["name"] = name
    requests = []
    _configure(monkeypatch, schemas, requests)

    async def run():
        return [event async for event in loop.stream_agent_loop(
            "https://local.test/v1", "gpt-6.1-sol",
            [{"role": "user", "content": "Use the browser to read this repository."}],
            relevant_tools={schema["function"]["name"] for schema in schemas},
            forced_tools=disabled, disabled_tools=disabled,
            max_rounds=1, _is_teacher_run=True,
        )]

    asyncio.run(run())
    assert len(requests) == 1
    assert disabled.isdisjoint(
        schema["function"]["name"] for schema in requests[0]["kwargs"]["tools"]
    )


@pytest.mark.parametrize("browser_disabled", ["enabled", "tools", "alias"])
def test_url_request_selects_browser_when_retrieval_misses_it(monkeypatch, browser_disabled):
    from types import SimpleNamespace
    from src.tool_index import ALWAYS_AVAILABLE

    schemas = _browser_schemas(38)
    core_names = {"mcp__builtin_browser__browser_" + action
                  for action in ("navigate", "snapshot", "tabs")}
    for schema, name in zip(schemas[-3:], sorted(core_names)):
        schema["function"]["name"] = name
    requests = []
    _configure(monkeypatch, schemas, requests)
    monkeypatch.setattr("src.model_context.budget_context_for_model", lambda *a, **k: 0)
    monkeypatch.setattr("src.tool_index.get_tool_index", lambda: SimpleNamespace(
        get_tools_for_query=lambda *a: set(ALWAYS_AVAILABLE) | {"web_fetch", "web_search", "download_model"},
    ))
    question = "https://github.com/nerdrx/zVram\r\n\r\ncheck this out"
    disabled = {"web_fetch", "web_search"}
    if browser_disabled == "tools":
        disabled.update(core_names)
    elif browser_disabled == "alias":
        disabled.add("builtin_browser")

    async def run():
        return [event async for event in loop.stream_agent_loop(
            "https://local.test/v1", "gpt-6.1-sol",
            [{"role": "user", "content": question}],
            disabled_tools=disabled, max_rounds=1, _is_teacher_run=True,
        )]

    asyncio.run(run())
    assert len(requests) == 1
    request = requests[0]
    tools = request["kwargs"]["tools"]
    names = {schema["function"]["name"] for schema in tools}
    assert disabled.isdisjoint(names)
    if browser_disabled == "enabled":
        assert core_names <= names
    else:
        assert not names & core_names
    assert "download_model" not in names
    assert any(msg.get("content") == question for msg in request["messages"])
    assert estimate_tokens(request["messages"]) + estimate_tool_schema_tokens(tools) + 1024 <= 6000
