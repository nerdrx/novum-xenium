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
        prompt_and_schemas = estimate_tokens(shaped) + estimate_tool_schema_tokens(tools)
        assert prompt_and_schemas <= 6000 - 2048
        assert prompt_and_schemas + request["kwargs"]["max_tokens"] <= 6000
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
    assert inspection["input_budget_tokens"] == 3952
    assert inspection["available_tokens"] <= inspection["input_budget_tokens"]
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


@pytest.mark.parametrize("explicit_web_request", [False, True])
def test_default_web_permission_does_not_block_workspace_tools_when_budget_is_tight(
    monkeypatch, explicit_web_request
):
    import src.model_context as model_context
    from src.tool_policy import WEB_TOOL_NAMES

    names = {"read_file", "edit_file", "bash", "grep", "write_file", *WEB_TOOL_NAMES}
    schemas = [
        schema for schema in loop.FUNCTION_TOOL_SCHEMAS
        if schema.get("function", {}).get("name") in names
    ]
    requests = []
    _configure(monkeypatch, schemas, requests)
    monkeypatch.setattr(model_context, "budget_context_for_model", lambda *a, **k: 0)
    monkeypatch.setattr(
        loop,
        "get_setting",
        lambda key, default=None: 6000 if key == "agent_input_token_budget" else default,
    )

    question = "Fix add in probe.py and run assertions."
    if explicit_web_request:
        question += " Also search the latest release."

    async def run():
        return [event async for event in loop.stream_agent_loop(
            "https://local.test/v1",
            "coding-fixture",
            [{"role": "user", "content": question}],
            workspace="/workspace",
            relevant_tools=names,
            forced_tools=set(WEB_TOOL_NAMES),
            max_rounds=1,
            _is_teacher_run=True,
        )]

    if explicit_web_request:
        with pytest.raises(ValueError, match="requested tool schemas"):
            asyncio.run(run())
        assert requests == []
        return

    asyncio.run(run())

    assert len(requests) == 1
    selected = requests[0]["kwargs"]["tools"]
    selected_names = {schema["function"]["name"] for schema in selected}
    assert {"read_file", "edit_file", "bash"} <= selected_names
    assert not (WEB_TOOL_NAMES & selected_names)
    prompt_tokens = model_context.estimate_tokens(requests[0]["messages"])
    schema_tokens = model_context.estimate_tool_schema_tokens(selected)
    assert prompt_tokens + schema_tokens + requests[0]["kwargs"]["max_tokens"] <= 6000


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
    schemas[3]["function"]["name"] = "mcp__builtin_browser__browser_click"
    forced = {schema["function"]["name"] for schema in schemas[:13]}
    assert estimate_tool_schema_tokens(schemas[:13]) > 1500
    if not core_first:
        # MCP registration order is not relevance order. A retrieved whole
        # family must still offer navigation/read tools under a small cap.
        schemas = schemas[3:] + schemas[:3]
        schemas[1]["function"]["name"] = "mcp__builtin_browser__browser_close"
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
        assert "mcp__builtin_browser__browser_click" in names
    assert estimate_tool_schema_tokens(selected) <= max(256, min(8192, (context or limit) // 4, limit // 3))
    assert any(m["role"] == "user" and m["content"] == question for m in request["messages"])
    prompt_and_schemas = estimate_tokens(request["messages"]) + estimate_tool_schema_tokens(selected)
    prompt_limit = min(limit, context - 1024) if context else limit - 1024
    assert prompt_and_schemas <= prompt_limit
    native_limit = context if context else limit
    assert prompt_and_schemas + request["kwargs"]["max_tokens"] <= native_limit


def test_browser_workspace_request_does_not_starve_browser_actions(monkeypatch):
    import src.model_context as model_context

    schemas = _browser_schemas(38)
    for schema, action in zip(schemas[:3], ("navigate", "snapshot", "click")):
        schema["function"]["name"] = "mcp__builtin_browser__browser_" + action
    browser_names = {schema["function"]["name"] for schema in schemas}
    requests = []
    _configure(monkeypatch, schemas, requests)
    monkeypatch.setattr(model_context, "budget_context_for_model", lambda *a, **k: 0)
    monkeypatch.setattr(
        loop,
        "get_setting",
        lambda key, default=None: 6000 if key == "agent_input_token_budget" else default,
    )
    disabled = {"bash", "python", "web_search", "web_fetch"}
    message = (
        "Use the built-in browser tools to open http://127.0.0.1:17111/, click the Reveal result button, "
        "then read the resulting heading and return it exactly. This is our disposable local browser fixture. "
        "Use browser navigation, snapshot and click tools; do not use Bash, Python or web_fetch. Do not edit files."
    )

    async def run():
        return [event async for event in loop.stream_agent_loop(
            "https://local.test/v1",
            "gpt-6-luna",
            [{"role": "user", "content": message}],
            workspace="/workspace/.nx-evaluations/browser-fixture",
            relevant_tools=browser_names,
            forced_tools=browser_names,
            disabled_tools=disabled,
            max_rounds=1,
            _is_teacher_run=True,
        )]

    asyncio.run(run())
    assert len(requests) == 1
    selected = {schema["function"]["name"] for schema in requests[0]["kwargs"]["tools"]}
    assert {
        "mcp__builtin_browser__browser_navigate",
        "mcp__builtin_browser__browser_snapshot",
        "mcp__builtin_browser__browser_click",
    } <= selected
    assert disabled.isdisjoint(selected)


@pytest.mark.parametrize(
    "message",
    [
        "Do not rewrite everything, fix main.py.",
        "Do not rewrite everything, write calc.py.",
        "Never use Bash but edit config.py.",
    ],
)
def test_workspace_coding_intent_keeps_positive_clause_after_negation(message):
    assert loop._looks_like_workspace_coding_request(message)


def test_workspace_coding_intent_ignores_url_inside_negated_clause():
    assert not loop._looks_like_workspace_coding_request(
        "Do not open https://github.com/a.py but read the heading."
    )


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


@pytest.mark.parametrize("disabled_editors", [
    set(),
    {"edit_file"},
    {"write_file"},
    {"apply_patch"},
    {"edit_file", "write_file", "apply_patch"},
])
def test_workspace_coding_budget_keeps_file_editing_tools(monkeypatch, disabled_editors):
    import src.model_context as model_context

    schemas = loop.FUNCTION_TOOL_SCHEMAS
    names = {schema["function"]["name"] for schema in schemas}
    assert {"read_file", "edit_file", "bash", "write_file", "apply_patch"} <= names
    requests = []
    _configure(monkeypatch, [], requests)
    monkeypatch.setattr(model_context, "budget_context_for_model", lambda *a, **k: 0)
    question = "Read the project code, fix the bug, and run its focused test suite."
    messages = [
        {"role": "system", "content": "Current instructions. " * 300},
        {"role": "user", "content": "Older task. " * 1800},
        {"role": "assistant", "content": "Earlier result. " * 1800},
        {"role": "user", "content": question},
    ]

    async def run():
        return [event async for event in loop.stream_agent_loop(
            "https://local.test/v1", "unknown-context-model", messages,
            relevant_tools=names,
            disabled_tools=disabled_editors,
            workspace="/workspace/project",
            max_rounds=1, _is_teacher_run=True,
        )]

    asyncio.run(run())
    assert len(requests) == 1
    request = requests[0]
    selected = request["kwargs"]["tools"]
    selected_names = {schema["function"]["name"] for schema in selected}
    assert {"read_file", "bash"} <= selected_names
    if "edit_file" not in disabled_editors:
        assert "edit_file" in selected_names
    assert selected_names.isdisjoint(disabled_editors)
    assert any(message.get("role") == "user" and message.get("content") == question
               for message in request["messages"])
    assert estimate_tool_schema_tokens(selected) <= 1500
    assert estimate_tokens(request["messages"]) + estimate_tool_schema_tokens(selected) + 1024 <= 6000


def test_workspace_coding_request_fails_if_its_own_size_starves_all_tools(monkeypatch):
    import src.model_context as model_context

    names = {"read_file", "edit_file", "bash"}
    schemas = [
        schema for schema in loop.FUNCTION_TOOL_SCHEMAS
        if schema.get("function", {}).get("name") in names
    ]
    requests = []
    _configure(monkeypatch, schemas, requests)
    monkeypatch.setattr(model_context, "budget_context_for_model", lambda *a, **k: 6000)
    monkeypatch.setattr(
        loop,
        "get_setting",
        lambda key, default=None: 6000 if key == "agent_input_token_budget" else default,
    )
    question = "Please read the project file and fix the bug. " + "x" * 12_700

    async def run():
        return [event async for event in loop.stream_agent_loop(
            "https://local.test/v1",
            "coding-fixture",
            [{"role": "user", "content": question}],
            workspace="/workspace",
            relevant_tools=names,
            max_rounds=1,
            _is_teacher_run=True,
        )]

    with pytest.raises(ValueError, match="any enabled workspace coding tool schema"):
        asyncio.run(run())
    assert requests == []


@pytest.mark.parametrize("terminal_tool", ["bash", "python"])
def test_workspace_test_request_can_use_enabled_terminal_without_file_tools(monkeypatch, terminal_tool):
    names = {"read_file", "edit_file", "bash", "python"}
    schemas = [
        schema for schema in loop.FUNCTION_TOOL_SCHEMAS
        if schema.get("function", {}).get("name") in names
    ]
    requests = []
    _configure(monkeypatch, schemas, requests)
    disabled = set(loop._DOMAIN_TOOL_MAP["files"]) - {terminal_tool}

    async def run():
        return [event async for event in loop.stream_agent_loop(
            "https://local.test/v1",
            "coding-fixture",
            [{"role": "user", "content": "Run the project's focused test suite."}],
            workspace="/workspace",
            relevant_tools=names,
            disabled_tools=disabled,
            max_rounds=1,
            _is_teacher_run=True,
        )]

    asyncio.run(run())
    assert len(requests) == 1
    selected_names = {schema["function"]["name"] for schema in requests[0]["kwargs"]["tools"]}
    assert terminal_tool in selected_names
    assert disabled.isdisjoint(selected_names)


def test_workspace_read_only_request_can_use_only_read_file(monkeypatch):
    schemas = [
        schema for schema in loop.FUNCTION_TOOL_SCHEMAS
        if schema.get("function", {}).get("name") == "read_file"
    ]
    requests = []
    _configure(monkeypatch, schemas, requests)
    disabled = set(loop._DOMAIN_TOOL_MAP["files"]) - {"read_file", "grep", "glob", "ls"}

    async def run():
        return [event async for event in loop.stream_agent_loop(
            "https://local.test/v1",
            "coding-fixture",
            [{"role": "user", "content": "Inspect the project code and summarize how it handles requests."}],
            workspace="/workspace",
            relevant_tools={"read_file"},
            disabled_tools=disabled,
            max_rounds=1,
            _is_teacher_run=True,
        )]

    asyncio.run(run())
    assert len(requests) == 1
    selected_names = {schema["function"]["name"] for schema in requests[0]["kwargs"]["tools"]}
    assert "read_file" in selected_names
    assert disabled.isdisjoint(selected_names)


def test_normal_agent_turn_may_proceed_without_schemas_when_budget_is_tight(monkeypatch):
    import src.model_context as model_context

    schema = {"type": "function", "function": {
        "name": "update_plan", "description": "Plan details. " * 400,
        "parameters": {"type": "object", "properties": {"plan": {"type": "string"}}},
    }}
    requests = []
    _configure(monkeypatch, [schema], requests)
    monkeypatch.setattr(model_context, "budget_context_for_model", lambda *a, **k: 6000)
    monkeypatch.setattr(
        loop,
        "get_setting",
        lambda key, default=None: 6000 if key == "agent_input_token_budget" else default,
    )
    message = "Explain recursion simply. " + "x" * 12_700

    async def run():
        return [event async for event in loop.stream_agent_loop(
            "https://local.test/v1",
            "chat-fixture",
            [{"role": "user", "content": message}],
            relevant_tools={"update_plan"},
            max_rounds=1,
            _is_teacher_run=True,
        )]

    events = asyncio.run(run())
    assert len(requests) == 1
    assert not requests[0]["kwargs"].get("tools")
    assert any(event.startswith("data: [DONE]") for event in events)


def test_workspace_coding_budget_compacts_large_native_history_before_schema_selection(monkeypatch):
    import src.model_context as model_context

    schemas = loop.FUNCTION_TOOL_SCHEMAS
    names = {schema["function"]["name"] for schema in schemas}
    assert {"read_file", "edit_file", "bash", "grep", "glob"} <= names
    requests = []
    _configure(monkeypatch, [], requests)
    monkeypatch.setattr(model_context, "budget_context_for_model", lambda *a, **k: 0)
    question = "Read the project code, fix the bug, and run its focused test suite."
    messages = [
        {"role": "system", "content": "Current instructions. " * 300},
        {"role": "user", "content": question},
    ]
    # Model several earlier inspection rounds, then a latest read whose body
    # is large enough that the normal context compactor must shorten it.
    for index, tool_name in enumerate(("read_file", "bash", "grep", "glob")):
        call_id = f"old-call-{index}"
        messages.extend([
            {
                "role": "assistant",
                "content": None,
                "tool_calls": [{
                    "id": call_id,
                    "type": "function",
                    "function": {"name": tool_name, "arguments": "{}"},
                }],
            },
            {"role": "tool", "tool_call_id": call_id, "content": "Earlier repository output. " * 300},
        ])
    latest_id = "latest-read-call"
    latest_exchange = [
        {
            "role": "assistant",
            "content": None,
            "tool_calls": [{
                "id": latest_id,
                "type": "function",
                "function": {"name": "read_file", "arguments": '{"path":"src/module.py"}'},
            }],
        },
        {"role": "tool", "tool_call_id": latest_id, "content": "Latest source body. " * 6000},
    ]
    messages.extend(latest_exchange)

    async def run():
        return [event async for event in loop.stream_agent_loop(
            "https://local.test/v1", "unknown-context-model", messages,
            relevant_tools=names,
            workspace="/workspace/project",
            max_rounds=1, _is_teacher_run=True,
        )]

    asyncio.run(run())
    assert len(requests) == 1
    request = requests[0]
    selected = request["kwargs"]["tools"]
    selected_names = {schema["function"]["name"] for schema in selected}
    assert {"read_file", "edit_file", "bash"} <= selected_names
    assert any(message.get("role") == "user" and message.get("content") == question
               for message in request["messages"])
    latest_call = next(message for message in request["messages"]
                       if message.get("role") == "assistant"
                       and any(call.get("id") == latest_id for call in message.get("tool_calls", [])))
    latest_result = next(message for message in request["messages"]
                         if message.get("role") == "tool" and message.get("tool_call_id") == latest_id)
    assert latest_result["content"] != latest_exchange[-1]["content"]
    assert latest_call["tool_calls"][0]["id"] == latest_id
    assert latest_result["tool_call_id"] == latest_id
    used_schemas = [schema for schema in schemas
                    if schema["function"]["name"] in {"read_file", "bash", "grep", "glob"}]
    assert estimate_tool_schema_tokens(selected) <= estimate_tool_schema_tokens(used_schemas) + 1500
    assert estimate_tokens(request["messages"]) + estimate_tool_schema_tokens(selected) + 1024 <= 6000


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


def test_optional_browser_discovery_does_not_starve_forced_web_tool(monkeypatch):
    """A short conversational follow-up must not fail on unrelated MCP discovery."""
    import src.model_context as model_context

    browser = {
        "type": "function", "function": {
            "name": "mcp__builtin_browser__browser_navigate",
            "description": "x" * 3000,
            "parameters": {"type": "object", "properties": {}},
        },
    }
    web = next(s for s in loop.FUNCTION_TOOL_SCHEMAS if s["function"]["name"] == "web_fetch")
    assert model_context.estimate_tool_schema_tokens([browser]) <= 1500
    assert model_context.estimate_tool_schema_tokens([browser, web]) > 1500
    requests = []
    _configure(monkeypatch, [browser, web], requests)
    monkeypatch.setattr(model_context, "budget_context_for_model", lambda *a, **k: 0)

    async def run():
        return [event async for event in loop.stream_agent_loop(
            "https://cloud.test/v1", "unknown-window-model",
            [{"role": "user", "content": "We are going to rename the app."}],
            relevant_tools={browser["function"]["name"], "web_fetch"},
            forced_tools={"web_fetch"}, max_rounds=1, _is_teacher_run=True,
        )]

    asyncio.run(run())
    assert len(requests) == 1
    tools = requests[0]["kwargs"]["tools"]
    assert "web_fetch" in {s["function"]["name"] for s in tools}
    assert model_context.estimate_tool_schema_tokens(tools) <= 1500
