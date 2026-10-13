"""Only native ask_user cards can mint task clarification continuations."""
import asyncio
import json

import pytest

import src.agent_loop as agent_loop
from src.tool_approval_scopes import (
    TASK_APPROVAL_CONTINUATION_METADATA_FIELD,
    TASK_APPROVAL_DECISION,
)
from src.tool_approvals import ToolApprovalStore
from src.tool_capabilities import capabilities_for_action
from test_agent_rounds_exhausted import _collect, _patch_common, _types


@pytest.mark.parametrize(
    "tool_name,tool_arguments,expected_marker",
    [
        ("ask_user", {"question": "Which architecture?", "options": [
            {"label": "Electron"}, {"label": "Web app"},
        ]}, True),
        ("read_file", {"path": "README.md"}, False),
    ],
)
def test_auto_task_only_mints_for_native_ask_user(
    monkeypatch, tmp_path, tool_name, tool_arguments, expected_marker,
):
    monkeypatch.setattr("src.tool_approval_scopes._grant_key", lambda: b"test-key")
    monkeypatch.setattr(agent_loop, "blocked_tools_for_owner", lambda _owner: set())
    monkeypatch.setenv("ODYSSEUS_RUN_CHECKPOINTS_DB", str(tmp_path / "runs.db"))
    _patch_common(monkeypatch)
    card = {
        "question": "Which architecture?",
        "options": [{"label": "Electron"}, {"label": "Web app"}],
    }
    captured_result = {"output": "ok", "exit_code": 0, "ask_user": card}
    if tool_name == "ask_user":
        captured_result = {"ask_user": card}

    async def stream(_candidates, _messages, **_kwargs):
        yield "data: " + json.dumps({"type": "tool_calls", "calls": [{
            "id": "clarify", "name": tool_name,
            "arguments": json.dumps(tool_arguments),
        }]}) + "\n\n"
        yield "data: [DONE]\n\n"

    async def execute(_block, **_kwargs):
        return tool_name, captured_result

    monkeypatch.setattr(agent_loop, "stream_llm_with_fallback", stream)
    monkeypatch.setattr(agent_loop, "execute_tool_block", execute)
    approvals = ToolApprovalStore()
    content = "{}"
    pending = approvals.create(
        owner="alice", session_id="session-1", origin_run_id="origin-run",
        tool_name="manage_skills", content=content, workspace="/workspace",
        selected_tools=["ask_user", "read_file"],
        continuation_query="Build the requested desktop app.",
        external_untrusted_context_seen=True,
        capabilities=capabilities_for_action("manage_skills", content),
    )
    grant = approvals.consume(
        pending.approval_id, decision=TASK_APPROVAL_DECISION,
        owner="alice", session_id="session-1",
    )
    assert grant is not None

    events = _types(_collect(agent_loop.stream_agent_loop(
        "http://local/v1", "test-model",
            [{"role": "user", "content": "Read README.md."}],
        owner="alice", session_id="session-1", workspace="/workspace",
        relevant_tools={tool_name}, exact_approval=grant,
        approval_mode="auto", server_run_id="question-run", max_rounds=1,
    )))
    metric = next(event for event in events if event.get("type") == "metrics")
    tool_event = next(event for event in metric["data"]["tool_events"]
                      if event.get("ask_user"))
    assert (TASK_APPROVAL_CONTINUATION_METADATA_FIELD in tool_event) is expected_marker
