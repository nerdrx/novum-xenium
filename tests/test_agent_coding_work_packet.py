from __future__ import annotations

import json

import pytest

import src.agent_loop as al
from src.coding_grounding import CodingGrounding
from src.settings import DEFAULT_SETTINGS
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


def _run_packet(monkeypatch, tmp_path, *, acceptance_exit=0, verifier_issues=None):
    _patch_common(monkeypatch)
    monkeypatch.setenv("ODYSSEUS_RUN_CHECKPOINTS_DB", str(tmp_path / "runs.db"))
    monkeypatch.setattr(al, "blocked_tools_for_owner", lambda _owner: set())
    monkeypatch.setattr(al, "get_setting", lambda key, default=None: (
        True if verifier_issues is not None and key == "agent_verifier_subagent" else default
    ))
    if verifier_issues is not None:
        async def verify(*_args, **_kwargs):
            return list(verifier_issues)
        monkeypatch.setattr(al, "_run_verifier_subagent", verify)

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


@pytest.mark.parametrize(("issues", "status"), [
    ([], "passed"),
    (["Failed: acceptance condition was not met"], "failed"),
    (["Unverified: the reviewer lacked evidence"], "unverified"),
])
def test_packet_reports_actual_independent_review_result(monkeypatch, tmp_path, issues, status):
    events, _executed, _requested = _run_packet(
        monkeypatch, tmp_path, verifier_issues=issues,
    )

    packet_events = [event for event in events if event.get("type") == "coding_work_packet"]
    done_events = [event for event in packet_events if event["stage"] == "done"]
    assert [event["review_status"] for event in done_events] == ["not_reviewed", status]


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


@pytest.mark.parametrize("valid_reproduction", [True, False])
def test_exactly_approved_write_uses_restored_reproduction_evidence(monkeypatch, tmp_path, valid_reproduction):
    from src.coding_work_packet import CodingWorkTracker

    _patch_common(monkeypatch)
    monkeypatch.setenv("ODYSSEUS_RUN_CHECKPOINTS_DB", str(tmp_path / "approval-runs.db"))
    monkeypatch.setattr(al, "blocked_tools_for_owner", lambda _owner: set())
    monkeypatch.setattr(al, "get_setting", lambda key, default=None: True if key == "agent_milestone_workflow" else default)

    class GroundedCodingTask(CodingGrounding):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            self.evidence.add("read_file")

    monkeypatch.setattr("src.coding_grounding.CodingGrounding", GroundedCodingTask)
    tracker = CodingWorkTracker(enabled=True)
    tracker.observe("todowrite", "{}", {
        "exit_code": 0,
        "todos": [{"content": "Fix refresh behavior", "status": "in_progress"}],
        "work_packet": _packet(),
    })
    tracker.observe("bash", _packet()["reproduce_command"], {"exit_code": 1})
    checkpoint = tracker.checkpoint_data()
    if not valid_reproduction:
        checkpoint["reproduction_exit_code"] = None

    sealed = json.dumps({"path": "src/auth.py", "content": "fixed"})
    approvals = ToolApprovalStore()
    pending = approvals.create(
        owner="alice", session_id="approved-packet-test", origin_run_id="prior-run",
        tool_name="write_file", content=sealed, workspace=str(tmp_path),
        selected_tools={"write_file"}, external_untrusted_context_seen=False,
        capabilities=capabilities_for_action("write_file", sealed),
    )
    grant = approvals.consume(pending.approval_id, decision="approve", owner="alice", session_id="approved-packet-test")
    assert grant is not None

    executed = []
    async def execute(block, *args, **kwargs):
        executed.append(block.tool_type)
        return block.tool_type, {"exit_code": 0, "output": "saved"}

    monkeypatch.setattr(al, "execute_tool_block", execute)
    async def stream(candidates, messages, **kwargs):
        request = await kwargs["candidate_request_factory"](0, *candidates[0])
        assert al.AUTO_MILESTONE_DIRECTIVE not in json.dumps(request)
        yield 'data: {"delta":"done"}\n\n'
        yield "data: [DONE]\n\n"

    monkeypatch.setattr(al, "stream_llm_with_fallback", stream)
    chunks = _collect(al.stream_agent_loop(
        "http://x/v1", "gpt-4o", [{"role": "user", "content": "Fix the auth refresh bug in this workspace"}],
        workspace=str(tmp_path), owner="alice", session_id="approved-packet-test",
        approval_mode="auto", exact_approval=grant, server_run_id="approved-resume",
        coding_work_checkpoint=checkpoint, max_rounds=2,
    ))
    events = _types(chunks)
    packets = [event for event in events if event.get("type") == "coding_work_packet"]
    assert packets[0]["stage"] == ("edit" if valid_reproduction else "reproduce")
    assert executed == (["write_file"] if valid_reproduction else [])
    if not valid_reproduction:
        assert any(event.get("policy") == "coding_work_packet" for event in events)


def test_stop_notice_distinguishes_passed_slice_from_failed_checklist(monkeypatch):
    from src.coding_work_packet import CodingWorkTracker

    tracker = CodingWorkTracker(enabled=True)
    todos = [
        {"content": "Fix refresh", "status": "in_progress"},
        {"content": "Handle expired tokens", "status": "pending"},
    ]
    packet = _packet()
    packet["objective"] = "Fix refresh"
    assert tracker.observe("todowrite", "{}", {
        "exit_code": 0, "todos": todos, "work_packet": packet,
    })
    tracker.observe("bash", packet["reproduce_command"], {"exit_code": 1})
    tracker.observe("write_file", "{}", {"exit_code": 0})
    tracker.observe("bash", packet["acceptance_command"], {"exit_code": 0})

    notice = al._coding_work_stop_notice(tracker)
    assert "passed its acceptance check" in notice
    assert "unfinished items" in notice


def test_missing_work_packet_todowrite_gets_actionable_model_visible_error(monkeypatch, tmp_path):
    _patch_common(monkeypatch)
    monkeypatch.setenv("ODYSSEUS_RUN_CHECKPOINTS_DB", str(tmp_path / "missing-packet.db"))
    monkeypatch.setattr(al, "blocked_tools_for_owner", lambda _owner: set())
    monkeypatch.setattr(al, "get_setting", lambda key, default=None: True if key == "agent_milestone_workflow" else default)

    class GroundedCodingTask(CodingGrounding):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            self.evidence.add("read_file")

    monkeypatch.setattr("src.coding_grounding.CodingGrounding", GroundedCodingTask)
    monkeypatch.setattr(coding_tools, "read_todos", lambda _ctx: [])
    plain = {"todos": [{"content": "Fix refresh", "status": "in_progress"}]}
    sealed = json.dumps(plain)
    approvals = ToolApprovalStore()
    pending = approvals.create(
        owner="alice", session_id="missing-packet-test", origin_run_id="packet-origin",
        tool_name="todowrite", content=sealed, workspace=str(tmp_path),
        selected_tools={"todowrite"}, external_untrusted_context_seen=False,
        capabilities=capabilities_for_action("todowrite", sealed),
    )
    grant = approvals.consume(
        pending.approval_id, decision=TASK_APPROVAL_DECISION,
        owner="alice", session_id="missing-packet-test",
    )
    assert grant is not None
    packet_args = {"todos": plain["todos"], "work_packet": _packet()}
    executed = []

    async def execute(block, *args, **kwargs):
        executed.append(block.tool_type)
        data = json.loads(block.content)
        result = {"exit_code": 0, "output": "saved", "todos": data["todos"]}
        if "work_packet" in data:
            result["work_packet"] = data["work_packet"]
        return block.tool_type, result

    monkeypatch.setattr(al, "execute_tool_block", execute)
    turn = 0

    async def stream(candidates, messages, **kwargs):
        nonlocal turn
        turn += 1
        if turn == 2:
            visible_history = json.dumps(messages)
            assert "work_packet" in visible_history
            assert "Replace every placeholder with a real value" in visible_history
        args = plain if turn == 1 else packet_args
        request = await kwargs["candidate_request_factory"](0, *candidates[0])
        assert any(
            "work_packet" in tool.get("function", {}).get("parameters", {}).get("required", [])
            for tool in request["kwargs"]["tools"]
            if tool.get("function", {}).get("name") == "todowrite"
        )
        call = {"id": f"missing-packet-{turn}", "name": "todowrite", "arguments": json.dumps(args)}
        yield "data: " + json.dumps({"type": "tool_calls", "calls": [call]}) + "\n\n"
        yield "data: [DONE]\n\n"

    monkeypatch.setattr(al, "stream_llm_with_fallback", stream)
    chunks = _collect(al.stream_agent_loop(
        "http://x/v1", "gpt-4o", [{"role": "user", "content": "Fix the auth refresh bug in this workspace"}],
        workspace=str(tmp_path), owner="alice", session_id="missing-packet-test",
        approval_mode="auto", exact_approval=grant, server_run_id="missing-packet-resume",
        relevant_tools={"todowrite"}, max_rounds=2,
    ))
    events = _types(chunks)
    assert any(event.get("policy") == "coding_work_packet" for event in events)
    assert any(event.get("type") == "coding_work_packet" for event in events)
    assert executed == ["todowrite"]


def test_enabled_workflow_requires_each_checklist_slice_and_refreshes_packet_context(monkeypatch, tmp_path):
    _patch_common(monkeypatch)
    monkeypatch.setenv("ODYSSEUS_RUN_CHECKPOINTS_DB", str(tmp_path / "runs.db"))
    monkeypatch.setattr(al, "blocked_tools_for_owner", lambda _owner: set())
    monkeypatch.setattr(al, "get_setting", lambda key, default=None: True if key == "agent_milestone_workflow" else default)

    class GroundedCodingTask(CodingGrounding):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            self.evidence.add("read_file")

    monkeypatch.setattr("src.coding_grounding.CodingGrounding", GroundedCodingTask)
    milestones = ["Fix refresh behavior", "Handle expired refresh tokens"]
    packet_a = _packet()
    packet_b = {
        **_packet(), "objective": "Handle expired refresh tokens",
        "reproduce_command": "pytest -q tests/test_auth.py::test_expired_refresh",
        "acceptance_command": "pytest -q tests/test_auth.py -k expired",
        "acceptance_condition": "Expired tokens fail safely",
    }
    todos_a = [
        {"content": milestones[0], "status": "in_progress"},
        {"content": milestones[1], "status": "pending"},
    ]
    todos_b = [
        {"content": milestones[0], "status": "completed"},
        {"content": milestones[1], "status": "in_progress"},
    ]
    actions = [
        ("todowrite", {"todos": todos_a, "work_packet": packet_a}),
        ("bash", {"command": packet_a["reproduce_command"]}),
        ("write_file", {"path": "src/auth.py", "content": "slice one"}),
        ("bash", {"command": packet_a["acceptance_command"]}),
        # A premature final answer must be held while the second milestone is pending.
        ("final", {}),
        ("todowrite", {"todos": todos_b, "work_packet": packet_b}),
        ("bash", {"command": packet_b["reproduce_command"]}),
        ("write_file", {"path": "src/auth.py", "content": "slice two"}),
        ("bash", {"command": packet_b["acceptance_command"]}),
        ("final", {}),
    ]
    monkeypatch.setattr(coding_tools, "read_todos", lambda _ctx: [])
    executed, requests = [], []
    sealed = json.dumps(actions[0][1])
    approvals = ToolApprovalStore()
    pending = approvals.create(
        owner="alice", session_id="coding-slices-test", origin_run_id="slice-origin",
        tool_name="todowrite", content=sealed, workspace=str(tmp_path),
        selected_tools={"todowrite", "bash", "write_file"},
        external_untrusted_context_seen=True,
        capabilities=capabilities_for_action("todowrite", sealed),
    )
    grant = approvals.consume(
        pending.approval_id, decision=TASK_APPROVAL_DECISION,
        owner="alice", session_id="coding-slices-test",
    )
    assert grant is not None

    async def execute(block, *args, **kwargs):
        executed.append((block.tool_type, block.content))
        if block.tool_type == "todowrite":
            data = json.loads(block.content)
            return block.tool_type, {"exit_code": 0, "output": "saved", **data}
        if block.tool_type == "bash":
            command = block.content
            if command in {packet_a["reproduce_command"], packet_b["reproduce_command"]}:
                label = "first slice baseline failure" if command == packet_a["reproduce_command"] else "second slice baseline failure"
                return block.tool_type, {"exit_code": 1, "output": label}
            assert command in {packet_a["acceptance_command"], packet_b["acceptance_command"]}
            return block.tool_type, {"exit_code": 0, "output": "acceptance passed"}
        if block.tool_type == "write_file":
            return block.tool_type, {"exit_code": 0, "output": "saved src/auth.py"}
        raise AssertionError(f"Unexpected tool: {block.tool_type}")

    monkeypatch.setattr(al, "execute_tool_block", execute)
    turn = 0

    async def stream(candidates, messages, **kwargs):
        nonlocal turn
        turn += 1
        request = await kwargs["candidate_request_factory"](0, *candidates[0])
        requests.append(request)
        if turn > len(actions):
            kind, args = "final", {}
        else:
            kind, args = actions[turn - 1]
        if kind == "final":
            text = "First slice is done." if turn == 5 else "Both coding slices are complete."
            yield "data: " + json.dumps({"delta": text}) + "\n\n"
        else:
            name = kind
            yield "data: " + json.dumps({"type": "tool_calls", "calls": [{
                "id": f"slice-{turn}", "name": name, "arguments": json.dumps(args),
            }]}) + "\n\n"
        yield "data: [DONE]\n\n"

    monkeypatch.setattr(al, "stream_llm_with_fallback", stream)
    events = _types(_collect(al.stream_agent_loop(
        "http://x/v1", "gpt-4o",
        [{"role": "user", "content": "Preserve keyboard support in src/auth.py"},
         {"role": "assistant", "content": "obsolete implementation chatter"},
         {"role": "user", "content": "Implement the auth module refresh behavior in src/auth.py in two small changes and verify each"}],
        workspace=str(tmp_path), owner="alice", session_id="coding-slices-test",
        approval_mode="auto", exact_approval=grant, server_run_id="slice-resume",
        relevant_tools={"bash", "write_file"}, max_rounds=20,
    )))

    packet_events = [event for event in events if event.get("type") == "coding_work_packet"]
    assert [event["stage"] for event in packet_events] == [
        "reproduce", "edit", "verify", "done", "reproduce", "edit", "verify", "done",
    ], (packet_events, executed, " ".join(event.get("delta", "") for event in events))
    assert [event["packet"]["objective"] for event in packet_events if event["stage"] == "done"] == [
        packet_a["objective"], packet_b["objective"],
    ]
    deltas = " ".join(event.get("delta", "") for event in events)
    assert "First slice is done." not in deltas
    assert "Both coding slices are complete." in deltas
    assert DEFAULT_SETTINGS["agent_milestone_workflow"] is False

    # The second reproduction begins a fresh packet context: the original user
    # request remains, while prior model chatter and the previous packet's goal do not.
    second_packet_request = requests[7]
    request_text = json.dumps(second_packet_request, ensure_ascii=False)
    assert "Preserve keyboard support" in request_text
    assert "obsolete implementation chatter" not in request_text
    assert packet_a["acceptance_condition"] not in request_text
    assert "first slice baseline failure" not in request_text
