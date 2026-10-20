"""Incomplete tool arguments must not silently finish or partially execute."""
import json
import time

import src.agent_loop as al
from src.tool_approvals import TaskApprovalContinuation
from src.tool_approval_scopes import ToolApprovalScope
from test_agent_rounds_exhausted import _patch_common, _collect, _types


def _run(monkeypatch, recover, invalid_preview=False, offer_preview=False):
    _patch_common(monkeypatch)
    monkeypatch.setattr(al, "blocked_tools_for_owner", lambda owner: set())
    executed = []
    requests = []
    offered_tools = []

    async def execute(block, **kwargs):
        executed.append(block.tool_type)
        return block.tool_type, {"output": "saved", "exit_code": 0}

    async def stream(candidates, messages, **kwargs):
        request_factory = kwargs.get("candidate_request_factory")
        if request_factory:
            request = await request_factory(0, *candidates[0])
            request_messages = request.get("messages", messages)
            offered_tools.append({
                item.get("function", {}).get("name")
                for item in request.get("kwargs", {}).get("tools", [])
            })
        else:
            request_messages = messages
            offered_tools.append(set())
        requests.append(list(request_messages))
        if recover and len(requests) == 2:
            yield 'data: ' + json.dumps({"type": "tool_calls", "calls": [
                {"id": "small", "name": "write_file", "arguments": json.dumps({
                    "path": "style.css", "content": "body { margin: 0; }"
                })},
            ]}) + '\n\n'
        elif recover and len(requests) > 2:
            yield 'data: {"delta":"Recovered."}\n\n'
        else:
            yield 'data: ' + json.dumps({"type": "tool_calls", "calls": [
                {"id": "good", "name": "update_plan", "arguments": '{"plan":"work"}'},
                {"id": "bad", "name": "native_preview" if invalid_preview else "write_file",
                 "arguments": '{"project_path":"/private/sensitive-project"}' if invalid_preview
                 else '{"path":"style.css","content":"body {'},
            ]}) + '\n\n'
        yield 'data: [DONE]\n\n'

    monkeypatch.setattr(al, 'execute_tool_block', execute)
    monkeypatch.setattr(al, 'stream_llm_with_fallback', stream)
    # Model the explicit "Allow for this task" response used when selected
    # skill context arms Auto's separate-action gate. Approval-policy behavior
    # is covered independently; this test isolates parsing and retry behavior.
    selected_tools = ("write_file", "update_plan", "native_preview") if offer_preview else (
        "write_file", "update_plan",
    )
    task_grant = TaskApprovalContinuation(
        origin_run_id="origin-run", question_run_id="approval-run",
        source_approval_id="approved-write", owner="test", session_id="",
        workspace="", document_id="", document_version=None,
        document_digest="", selected_label="Allow for this task",
        reply="Allow for this task.", continuation_query="Write the app.",
        selected_tools=selected_tools,
        external_untrusted_context_seen=True, web_search_enabled=False,
        expires_at=time.time() + 300, scope=ToolApprovalScope.TASK,
    )
    events = _types(_collect(al.stream_agent_loop(
        'http://x/v1', 'gpt-4o', [{'role': 'user', 'content': 'Write the app.'}],
        relevant_tools=set(selected_tools), max_rounds=6,
        task_continuation=task_grant,
    )))
    return events, requests, executed, offered_tools


def test_invalid_batch_retries_without_executing_valid_siblings(monkeypatch):
    events, requests, executed, _ = _run(monkeypatch, True)
    assert len(requests) == 3, events
    assert executed == ['write_file'], events
    assert any('NONE of that batch was executed' in m.get('content', '') for m in requests[1])
    assert any(e.get('delta') == 'Recovered.' for e in events)


def test_invalid_calls_stop_with_explanation_after_two_retries(monkeypatch):
    events, requests, executed, offered_tools = _run(monkeypatch, False)
    assert len(requests) == 3, events
    assert executed == []
    assert all("write_file" in names for names in offered_tools), offered_tools
    assert any('Stopped because the model' in e.get('delta', '') for e in events)
    assert any('under 2000' in m.get('content', '') for m in requests[1])
    assert any('under 1000' in m.get('content', '') for m in requests[2])


def test_preview_retry_supplies_schema_without_untrusted_arguments(monkeypatch, caplog):
    monkeypatch.delenv("ODYSSEUS_EXECUTOR_URL", raising=False)
    events, requests, executed, offered_tools = _run(
        monkeypatch, True, invalid_preview=True, offer_preview=True,
    )
    guidance = next(m["content"] for m in requests[1]
                    if "NONE of that batch was executed" in m.get("content", ""))
    schema = next(s["function"] for s in al.FUNCTION_TOOL_SCHEMAS
                  if s["function"]["name"] == "native_preview")
    assert json.dumps(schema) in guidance
    assert "native_preview" in offered_tools[0]
    assert "/private/sensitive-project" not in guidance
    assert "/private/sensitive-project" not in caplog.text
    assert executed == ["write_file"], events


def test_unoffered_preview_retry_does_not_suggest_global_schema(monkeypatch):
    events, requests, executed, offered_tools = _run(
        monkeypatch, True, invalid_preview=True,
    )
    guidance = next(m["content"] for m in requests[1]
                    if "NONE of that batch was executed" in m.get("content", ""))

    assert "native_preview" not in offered_tools[0]
    assert "For native_preview" not in guidance
    assert "/private/sensitive-project" not in guidance
    assert executed == ["write_file"], events
