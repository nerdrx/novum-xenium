from __future__ import annotations

import json

import pytest

import src.agent_loop as al
from src.coding_grounding import CodingGrounding
from src.agent_tools import coding_tools
from src.tool_approval_scopes import TASK_APPROVAL_DECISION
from src.tool_approvals import ToolApprovalStore
from src.tool_capabilities import capabilities_for_action
from test_agent_rounds_exhausted import _collect, _patch_common, _types


def _packet():
    return {
        "objective": "Fix refresh behavior",
        "files": ["src/auth.py", "tests/test_auth.py"],
        "reproduce_command": "pytest -q tests/test_auth.py::test_refresh",
        "acceptance_command": "pytest -q tests/test_auth.py",
        "acceptance_condition": "All auth tests pass",
    }


def _todos():
    return [
        {"content": "Reproduce refresh failure; update auth implementation", "status": "in_progress"},
        {"content": "Run auth acceptance tests after the edit", "status": "pending"},
    ]


def _run_packet(monkeypatch, tmp_path, *, acceptance_exit=0):
    _patch_common(monkeypatch)
    monkeypatch.setenv("ODYSSEUS_RUN_CHECKPOINTS_DB", str(tmp_path / "runs.db"))
    monkeypatch.setattr(al, "blocked_tools_for_owner", lambda _owner: set())
    monkeypatch.setattr(al, "get_setting", lambda key, default=None: default)

    class GroundedCodingTask(CodingGrounding):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            self.evidence.add("read_file")

    monkeypatch.setattr("src.coding_grounding.CodingGrounding", GroundedCodingTask)
    monkeypatch.setattr(coding_tools, "read_todos", lambda _ctx: [])
    actions = [
        ("todowrite", {"todos": _todos(), "work_packet": _packet()}),
        # Must be rejected by the packet guard before the executor sees it.
        ("write_file", {"path": "src/auth.py", "content": "too soon"}),
        ("bash", {"command": _packet()["reproduce_command"]}),
        ("write_file", {"path": "src/auth.py", "content": "fixed"}),
        ("bash", {"command": _packet()["acceptance_command"]}),
    ]
    requested = []
    executed = []
    initial_todowrite = json.dumps(actions[0][1])
    approvals = ToolApprovalStore()
    pending = approvals.create(
        owner="alice", session_id="coding-packet-test", origin_run_id="packet-origin",
        tool_name="todowrite", content=initial_todowrite, workspace=str(tmp_path),
        selected_tools={"todowrite", "bash", "write_file"},
        external_untrusted_context_seen=True,
        capabilities=capabilities_for_action("todowrite", initial_todowrite),
    )
    grant = approvals.consume(
        pending.approval_id, decision=TASK_APPROVAL_DECISION,
        owner="alice", session_id="coding-packet-test",
    )
    assert grant is not None

    async def execute(block, *args, **kwargs):
        executed.append((block.tool_type, block.content))
        if block.tool_type == "todowrite":
            data = json.loads(block.content)
            return block.tool_type, {
                "exit_code": 0, "output": "saved", "todos": data["todos"],
                "work_packet": data["work_packet"],
            }
        if block.tool_type == "bash":
            command = block.content
            if command == _packet()["reproduce_command"]:
                return block.tool_type, {"exit_code": 1, "output": "expected baseline failure"}
            assert command == _packet()["acceptance_command"]
            return block.tool_type, {"exit_code": acceptance_exit, "output": "acceptance result"}
        if block.tool_type == "write_file":
            path = block.content.split("\n", 1)[0]
            return block.tool_type, {"exit_code": 0, "output": f"saved {path}"}
        raise AssertionError(f"Unexpected tool: {block.tool_type}")

    monkeypatch.setattr(al, "execute_tool_block", execute)
    turn = 0

    async def stream(candidates, messages, **kwargs):
        nonlocal turn
        turn += 1
        if turn <= len(actions):
            tool, args = actions[turn - 1]
            request = await kwargs["candidate_request_factory"](0, *candidates[0])
            sent = json.dumps(request)
            assert "obsolete implementation chatter" not in sent
            assert "Preserve keyboard support" in sent
            requested.append({item["function"]["name"] for item in request["kwargs"]["tools"] or []})
            call = {"id": f"packet-{turn}", "name": tool, "arguments": json.dumps(args)}
            yield "data: " + json.dumps({"type": "tool_calls", "calls": [call]}) + "\n\n"
        else:
            yield 'data: {"delta":"Everything is complete."}\n\n'
        yield "data: [DONE]\n\n"

    monkeypatch.setattr(al, "stream_llm_with_fallback", stream)
    chunks = _collect(al.stream_agent_loop(
        "http://x/v1", "gpt-4o",
        [{"role": "user", "content": "Preserve keyboard support"},
         {"role": "assistant", "content": "obsolete implementation chatter"},
         {"role": "user", "content": "Fix the auth refresh bug in this workspace and run tests"}],
        workspace=str(tmp_path), owner="alice", session_id="coding-packet-test",
        approval_mode="auto", exact_approval=grant, server_run_id="packet-resume",
        relevant_tools={"todowrite", "bash", "write_file"}, max_rounds=10,
    ))
    return _types(chunks), executed, requested


def test_packet_requires_reproduction_then_edit_then_successful_acceptance(monkeypatch, tmp_path):
    events, executed, requested = _run_packet(monkeypatch, tmp_path)

    packet_events = [event for event in events if event.get("type") == "coding_work_packet"]
    assert [event["stage"] for event in packet_events] == ["reproduce", "edit", "verify", "done"], (packet_events, executed)
    assert packet_events[-1]["test_status"] == "passed"
    assert packet_events[-1]["review_status"] == "not_reviewed"
    # The task-scoped grant executes the sealed TodoWrite once before the
    # model's repeated checklist call; the duplicate packet must not reset it.
    assert [tool for tool, _content in executed] == ["todowrite", "todowrite", "bash", "write_file", "bash"]
    assert "Everything is complete." in " ".join(event.get("delta", "") for event in events)
    assert "write_file" in requested[1]


def test_failed_acceptance_cannot_mark_packet_done_or_finish_as_verified(monkeypatch, tmp_path):
    events, executed, _requested = _run_packet(monkeypatch, tmp_path, acceptance_exit=1)

    packet_events = [event for event in events if event.get("type") == "coding_work_packet"]
    assert packet_events[-1]["stage"] == "verify"
    assert packet_events[-1]["test_status"] == "not_verified"
    assert all(event["stage"] != "done" for event in packet_events)
    assert "Stopped: the current coding slice has no passing check" in " ".join(
        event.get("delta", "") for event in events
    )
    assert [tool for tool, _content in executed] == ["todowrite", "todowrite", "bash", "write_file", "bash"]
