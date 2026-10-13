"""Incomplete tool arguments must not silently finish or partially execute."""
import json
import time

import src.agent_loop as al
from src.tool_approvals import TaskApprovalContinuation
from src.tool_approval_scopes import ToolApprovalScope
from test_agent_rounds_exhausted import _patch_common, _collect, _types


def _run(monkeypatch, recover, invalid_preview=False):
    _patch_common(monkeypatch)
    monkeypatch.setattr(al, "blocked_tools_for_owner", lambda owner: set())
    executed = []
    requests = []

    async def execute(block, **kwargs):
        executed.append(block.tool_type)
        return block.tool_type, {"output": "saved", "exit_code": 0}

    async def stream(candidates, messages, **kwargs):
        requests.append(list(messages))
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
    task_grant = TaskApprovalContinuation(
        origin_run_id="origin-run", question_run_id="approval-run",
        source_approval_id="approved-write", owner="test", session_id="",
        workspace="", document_id="", document_version=None,
        document_digest="", selected_label="Allow for this task",
        reply="Allow for this task.", continuation_query="Write the app.",
        selected_tools=("write_file", "update_plan"),
        external_untrusted_context_seen=True, web_search_enabled=False,
        expires_at=time.time() + 300, scope=ToolApprovalScope.TASK,
    )
    events = _types(_collect(al.stream_agent_loop(
        'http://x/v1', 'm', [{'role': 'user', 'content': 'Write the app.'}],
        relevant_tools={'write_file', 'update_plan'}, max_rounds=6,
        task_continuation=task_grant,
    )))
    return events, requests, executed


def test_invalid_batch_retries_without_executing_valid_siblings(monkeypatch):
    events, requests, executed = _run(monkeypatch, True)
    assert len(requests) == 3, events
    assert executed == ['write_file'], events
    assert any('NONE of that batch was executed' in m.get('content', '') for m in requests[1])
    assert any(e.get('delta') == 'Recovered.' for e in events)


def test_invalid_calls_stop_with_explanation_after_two_retries(monkeypatch):
    events, requests, executed = _run(monkeypatch, False)
    assert len(requests) == 3, events
    assert executed == []
    assert any('Stopped because the model' in e.get('delta', '') for e in events)
    assert any('at most 2000' in m.get('content', '') for m in requests[1])
    assert any('at most 1000' in m.get('content', '') for m in requests[2])


def test_preview_retry_supplies_schema_without_untrusted_arguments(monkeypatch, caplog):
    monkeypatch.delenv("ODYSSEUS_EXECUTOR_URL", raising=False)
    events, requests, executed = _run(monkeypatch, True, invalid_preview=True)
    guidance = next(m["content"] for m in requests[1]
                    if "NONE of that batch was executed" in m.get("content", ""))
    schema = next(s["function"] for s in al.FUNCTION_TOOL_SCHEMAS
                  if s["function"]["name"] == "native_preview")
    assert json.dumps(schema) in guidance
    assert "/private/sensitive-project" not in guidance
    assert "/private/sensitive-project" not in caplog.text
    assert executed == ["write_file"], events
