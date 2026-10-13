"""Task privacy constraints must survive Auto approval and gate dispatch."""

import json
import time

import pytest

from src.tool_approval_scopes import TASK_APPROVAL_DECISION
from src.tool_approvals import TaskApprovalContinuation, ToolApprovalStore
from src.tool_capabilities import capabilities_for_action
import src.agent_loop as agent_loop
from test_agent_rounds_exhausted import _collect, _patch_common, _types


@pytest.mark.parametrize("grant_mode", ["exact", "continuation"])
def test_task_approval_does_not_bypass_private_github_visibility_guard(
    monkeypatch, grant_mode,
):
    monkeypatch.setattr("src.tool_approval_scopes._grant_key", lambda: b"test-key")
    monkeypatch.setattr(agent_loop, "blocked_tools_for_owner", lambda _owner: set())
    _patch_common(monkeypatch)
    monkeypatch.setattr(
        agent_loop, "get_setting",
        lambda key, default=None: False if key == "agent_coding_grounding" else default,
    )
    command = "gh repo create violetstream --public"
    task = "Build the app and also set up a private GitHub repo for it."
    approvals = ToolApprovalStore()
    pending = approvals.create(
        owner="alice", session_id="session-1", origin_run_id="origin-run",
        tool_name="bash", content=command, workspace="/workspace",
        selected_tools=["bash"], continuation_query=task,
        external_untrusted_context_seen=True,
        capabilities=capabilities_for_action("bash", command),
    )
    task_grant = approvals.consume(
        pending.approval_id, decision=TASK_APPROVAL_DECISION,
        owner="alice", session_id="session-1",
    )
    assert task_grant is not None

    async def stream(_candidates, _messages, **_kwargs):
        yield "data: " + json.dumps({"type": "tool_calls", "calls": [{
            "id": "create-repo", "name": "bash",
            "arguments": json.dumps({"command": command}),
        }]}) + "\n\n"
        yield "data: [DONE]\n\n"

    executed = []

    async def execute(block, **_kwargs):
        executed.append(block.content)
        return "bash", {"output": "created", "exit_code": 0}

    monkeypatch.setattr(agent_loop, "stream_llm_with_fallback", stream)
    monkeypatch.setattr(agent_loop, "execute_tool_block", execute)
    continuation = TaskApprovalContinuation(
        origin_run_id="origin-run", question_run_id="question-run",
        source_approval_id=pending.approval_id, owner="alice", session_id="session-1",
        workspace="/workspace", document_id="", document_version=None,
        document_digest="", selected_label="Continue task", reply="Continue task.",
        continuation_query=task, selected_tools=("bash",),
        external_untrusted_context_seen=True, web_search_enabled=False,
        expires_at=time.time() + 300,
    )
    events = _types(_collect(agent_loop.stream_agent_loop(
        "http://local/v1", "test-model",
        [{"role": "user", "content": task}],
        owner="alice", session_id="session-1", workspace="/workspace",
        relevant_tools={"bash"},
        exact_approval=task_grant if grant_mode == "exact" else None,
        task_continuation=continuation if grant_mode == "continuation" else None,
        approval_mode="auto", server_run_id="continued-run", max_rounds=1,
    )))

    assert executed == [], events
    blocked = next(event for event in events if event.get("type") == "tool_output")
    assert blocked["exit_code"] == 1
    assert "--private" in blocked["output"]
    metrics = next(event for event in events if event.get("type") == "metrics")
    assert metrics["data"]["tool_events"][0]["policy"] == "task_intent_alignment"
