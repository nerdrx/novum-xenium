"""Native tools occupy the same context window as the conversation."""
import asyncio
import json

import pytest
import src.agent_loop as agent_loop
from src.model_context import estimate_tokens, estimate_tool_schema_tokens


@pytest.mark.parametrize("rounds", [1, 2])
def test_candidate_budget_includes_tools_on_first_and_later_rounds(monkeypatch, rounds):
    schema = {"type": "function", "function": {
        "name": "update_plan", "description": "Tool description. " * 160,
        "parameters": {"type": "object", "properties": {"plan": {"type": "string"}}},
    }}
    monkeypatch.setattr(agent_loop, "FUNCTION_TOOL_SCHEMAS", [schema])
    monkeypatch.setattr(agent_loop, "get_setting", lambda key, default=None: default)
    monkeypatch.setattr(agent_loop, "get_mcp_manager", lambda: None)
    monkeypatch.setattr(agent_loop, "blocked_tools_for_owner", lambda owner: set())
    monkeypatch.setattr("src.model_context.budget_context_for_model", lambda *args, **kwargs: 6000)
    monkeypatch.setattr(agent_loop, "_build_system_prompt", lambda messages, *args, **kwargs: (list(messages), []))
    monkeypatch.setattr(agent_loop, "_agent_route_tool_mode", lambda *args, **kwargs: (True, False, False))
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

    monkeypatch.setattr(agent_loop, "execute_tool_block", fake_execute)
    monkeypatch.setattr(agent_loop, "stream_llm_with_fallback", fake_stream)

    async def run():
        return [chunk async for chunk in agent_loop.stream_agent_loop(
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


def test_no_tools_have_no_schema_reservation():
    assert estimate_tool_schema_tokens(None) == estimate_tool_schema_tokens([]) == 0
