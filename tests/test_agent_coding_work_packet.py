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


def _run_packet(monkeypatch, tmp_path, *, acceptance_exit=0, verifier_issues=None, todos=None,
                pause_after_acceptance=False, teacher_event=None, checked_workflow=False,
                attempt_shell_edit=False, registered_checks=False, disabled_bash=False,
                malformed_check=False, no_packet_start=False,
                stall_before_packet=False, fail_stall_reads=False, omit_acceptance=False,
                acceptance_blocked=False, verify_existing=False, repair_failed_check=False,
                max_tool_calls=0, baseline_blocked=False, max_rounds=10, extra_tools=False,
                schema_details=None):
    _patch_common(monkeypatch)
    monkeypatch.setenv("ODYSSEUS_RUN_CHECKPOINTS_DB", str(tmp_path / "runs.db"))
    monkeypatch.setattr(al, "blocked_tools_for_owner", lambda _owner: set())
    monkeypatch.setattr(al, "get_setting", lambda key, default=None: (
        True if ((checked_workflow and key == "agent_milestone_workflow")
                 or (verifier_issues is not None and key == "agent_verifier_subagent")) else default
    ))
    if extra_tools:
        monkeypatch.setattr(al, "_image_tool_available", lambda *args: True)
    if verifier_issues is not None:
        async def verify(*_args, **_kwargs):
            return list(verifier_issues)
        monkeypatch.setattr(al, "_run_verifier_subagent", verify)
    if pause_after_acceptance:
        original_guard = al._ToolProgressGuard

        class PausingGuard(original_guard):
            def observe(self, records):
                if any(record["tool_name"] == "bash" and
                       record["content"] == _packet()["acceptance_command"] for record in records):
                    return {"tools": ["bash"], "read_repeats": 1, "failed_retries": 0,
                            "repeated_rounds": 1}
                return super().observe(records)

        monkeypatch.setattr(al, "_ToolProgressGuard", PausingGuard)
    if teacher_event:
        import src.teacher_escalation as teacher_escalation

        async def escalate(**_kwargs):
            yield "data: " + json.dumps({"type": teacher_event}) + "\n\n"

        monkeypatch.setattr(teacher_escalation, "run_teacher_inline", escalate)

    class GroundedCodingTask(CodingGrounding):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            self.evidence.add("read_file")

    monkeypatch.setattr("src.coding_grounding.CodingGrounding", GroundedCodingTask)
    monkeypatch.setattr(coding_tools, "read_todos", lambda _ctx: [])
    todos = _todos() if todos is None else todos
    packet = _packet()
    if verify_existing:
        packet["mode"] = "verify_existing"
    actions = [
        ("todowrite", {"todos": todos, "work_packet": packet}),
        # Must be rejected by the packet guard before the executor sees it.
        ("write_file", {"path": "src/auth.py", "content": "too soon"}),
        ("bash", {"command": _packet()["reproduce_command"]}),
    ]
    if stall_before_packet:
        actions = [("read_file", {"path": "src/auth.py"}) for _ in range(4)] + actions
    if attempt_shell_edit:
        actions.append(("bash", {"command": "sed -i 's/old/new/' src/auth.py"}))
    actions.extend([
        ("write_file", {"path": "src/auth.py", "content": "fixed"}),
        ("bash", {"command": _packet()["acceptance_command"]}),
    ])
    if registered_checks:
        actions[2] = ("run_coding_check", {})
        actions[-1] = ("run_coding_check", {})
    if malformed_check:
        actions[2] = ("run_coding_check", {"command": "echo injected"})
    if omit_acceptance:
        actions.pop()
    if checked_workflow and not disabled_bash:
        # The server owns checks at stage boundaries; the model only edits.
        actions = [action for action in actions
                   if action[0] not in {"bash", "run_coding_check", "write_file"}
                   or (action[0] == "write_file" and action[1]["content"] == "fixed")
                   or (action[0] == "bash" and "sed -i" in action[1]["command"])
                   or (malformed_check and action[0] == "run_coding_check")]
    if verify_existing:
        actions = [action for action in actions if action[0] != "write_file"]
    if repair_failed_check:
        actions.append(("write_file", {"path": "src/auth.py", "content": "fixed again"}))
    requested = []
    executed = []
    initial_todowrite = json.dumps(actions[0][1])
    approvals = ToolApprovalStore()
    pending = approvals.create(
        owner="alice", session_id="coding-packet-test", origin_run_id="packet-origin",
        tool_name="todowrite", content=initial_todowrite, workspace=str(tmp_path),
        selected_tools={"todowrite", "bash", "write_file", "python"},
        external_untrusted_context_seen=True,
        capabilities=capabilities_for_action("todowrite", initial_todowrite),
    )
    grant = None if no_packet_start else approvals.consume(
        pending.approval_id, decision=TASK_APPROVAL_DECISION,
        owner="alice", session_id="coding-packet-test",
    )
    if not no_packet_start:
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
                if baseline_blocked:
                    return "bash", {"exit_code": 1, "blocked": True, "error": "Check not authorized"}
                return block.tool_type, {"exit_code": 0 if verify_existing else 1, "output": "baseline result"}
            assert command == _packet()["acceptance_command"]
            if acceptance_blocked:
                return block.tool_type, {"exit_code": 1, "blocked": True,
                                         "error": "Check is not authorized"}
            check_count = sum(tool == "bash" and content == command for tool, content in executed)
            code = (1 if check_count == 1 else 0) if repair_failed_check else acceptance_exit
            return block.tool_type, {"exit_code": code, "output": "acceptance result"}
        if block.tool_type == "write_file":
            path = block.content.split("\n", 1)[0]
            return block.tool_type, {"exit_code": 0, "output": f"saved {path}"}
        if block.tool_type == "read_file":
            return block.tool_type, {
                "exit_code": 1 if fail_stall_reads else 0,
                "output": "permission denied" if fail_stall_reads else "same source contents",
            }
        raise AssertionError(f"Unexpected tool: {block.tool_type}")

    monkeypatch.setattr(al, "execute_tool_block", execute)
    turn = 0

    async def stream(candidates, messages, **kwargs):
        nonlocal turn
        turn += 1
        if checked_workflow and not disabled_bash and not no_packet_start and max_tool_calls != 1:
            assert ("bash", packet["reproduce_command"]) in executed
            server_results = [message for message in messages
                              if message.get("metadata", {}).get("source") == "server-scheduled coding check results"]
            if turn == 1:
                assert server_results
                assert all(message.get("metadata", {}).get("trusted") is False for message in server_results)
                assert all("tool_call_id" not in message for message in server_results)
        if no_packet_start and not stall_before_packet:
            request = await kwargs["candidate_request_factory"](0, *candidates[0])
            if schema_details is not None:
                schema_details.append(request["kwargs"]["tools"] or [])
            requested.append({item["function"]["name"] for item in request["kwargs"]["tools"] or []})
            yield 'data: {"delta":"I will inspect the workspace first."}\n\n'
            yield "data: [DONE]\n\n"
            return
        if turn <= len(actions):
            tool, args = actions[turn - 1]
            request = await kwargs["candidate_request_factory"](0, *candidates[0])
            sent = json.dumps(request)
            if not no_packet_start:
                assert "obsolete implementation chatter" not in sent
            assert "Preserve keyboard support" in sent
            if schema_details is not None:
                schema_details.append(request["kwargs"]["tools"] or [])
            requested.append({item["function"]["name"] for item in request["kwargs"]["tools"] or []})
            call = {"id": f"packet-{turn}", "name": tool, "arguments": json.dumps(args)}
            yield "data: " + json.dumps({"type": "tool_calls", "calls": [call]}) + "\n\n"
        else:
            if schema_details is not None:
                request = await kwargs["candidate_request_factory"](0, *candidates[0])
                schema_details.append(request["kwargs"]["tools"] or [])
                requested.append({item["function"]["name"] for item in request["kwargs"]["tools"] or []})
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
        relevant_tools={"todowrite", "bash", "write_file", "edit_file", "apply_patch",
                        "python", "read_file", "grep", "glob", "ls", "ask_user"}
                       | ({"generate_image", "create_document", "delegate_subagent", "manage_skills"} if extra_tools else set()),
        max_rounds=max_rounds,
        max_tool_calls=max_tool_calls,
        disabled_tools={"bash"} if disabled_bash else set(),
    ))
    return _types(chunks), executed, requested


def test_initial_checked_schema_keeps_readers_and_hides_blocked_actions(monkeypatch, tmp_path):
    _events, _executed, requested = _run_packet(
        monkeypatch, tmp_path, checked_workflow=True, no_packet_start=True,
    )

    names = requested[0]
    assert {"todowrite", "read_file", "grep", "glob", "ls"} <= names
    assert not ({"bash", "python", "write_file", "edit_file", "apply_patch"} & names)


def test_read_stall_recovers_to_truthful_packet_prompt(monkeypatch, tmp_path):
    events, executed, requested = _run_packet(
        monkeypatch, tmp_path, checked_workflow=True, no_packet_start=True,
        stall_before_packet=True,
    )

    assert {"todowrite", "ask_user"} <= requested[4]
    assert not ({"read_file", "grep", "glob", "ls", "bash", "write_file"} & requested[4])
    assert requested[-1] == {"todowrite", "ask_user"}
    # Packet creation remains subject to the ordinary approval boundary.
    assert any("approval" in json.dumps(event).lower() for event in events)
    assert [tool for tool, _content in executed][-1] == "read_file"


def test_failed_reads_do_not_activate_packet_stall_recovery(monkeypatch, tmp_path):
    events, _executed, requested = _run_packet(
        monkeypatch, tmp_path, checked_workflow=True, no_packet_start=True,
        stall_before_packet=True, fail_stall_reads=True,
    )

    assert "read_file" in requested[-1]
    assert any("Agent paused" in event.get("delta", "") for event in events)


def test_packet_requires_reproduction_then_edit_then_successful_acceptance(monkeypatch, tmp_path):
    events, executed, requested = _run_packet(
        monkeypatch, tmp_path, checked_workflow=True,
        todos=[{"content": "Fix refresh behavior", "status": "in_progress"}],
    )

    packet_events = [event for event in events if event.get("type") == "coding_work_packet"]
    assert [event["stage"] for event in packet_events] == ["reproduce", "edit", "verify", "done"], (packet_events, executed)
    assert packet_events[-1]["test_status"] == "passed"
    assert packet_events[-1]["review_status"] == "not_reviewed"
    assert all("update_plan" not in tools for tools in requested)
    # The task-scoped grant executes the sealed TodoWrite once before the
    # model's repeated checklist call; the duplicate packet must not reset it.
    assert [tool for tool, _content in executed] == ["todowrite", "bash", "todowrite", "write_file", "bash"]
    assert "Everything is complete." in " ".join(event.get("delta", "") for event in events)
    assert "write_file" in requested[0]  # Baseline ran before the first model call.



@pytest.mark.parametrize("exit_code,blocked", [(0, False), (1, False), (1, True)])
def test_prose_finish_runs_registered_acceptance_without_inventing_evidence(monkeypatch, tmp_path,
                                                                         exit_code, blocked):
    events, executed, _ = _run_packet(
        monkeypatch, tmp_path, checked_workflow=True, omit_acceptance=True,
        acceptance_exit=exit_code, acceptance_blocked=blocked,
        todos=[{"content": "Fix refresh behavior", "status": "in_progress"}],
    )
    checks = [command for tool, command in executed if tool == "bash"]
    assert checks == [_packet()["reproduce_command"], _packet()["acceptance_command"]]
    packets = [event for event in events if event.get("type") == "coding_work_packet"]
    assert (packets[-1]["stage"] == "done") == (exit_code == 0 and not blocked)
    if exit_code or blocked:
        assert not any(event.get("type") == "agent_terminal" and event.get("status") == "completed"
                       for event in events)


def test_registered_checks_use_packet_commands_through_bash(monkeypatch, tmp_path):
    events, executed, requested = _run_packet(
        monkeypatch, tmp_path, registered_checks=True, checked_workflow=True,
    )

    assert [tool for tool, _content in executed] == [
        "todowrite", "bash", "todowrite", "write_file", "bash",
    ]
    assert executed[1][1] == _packet()["reproduce_command"]
    assert executed[-1][1] == _packet()["acceptance_command"]
    assert "write_file" in requested[0]
    assert "bash" not in requested[0]
    assert any(event.get("stage") == "done" for event in events)


def test_registered_check_does_not_bypass_disabled_bash(monkeypatch, tmp_path):
    _events, executed, requested = _run_packet(
        monkeypatch, tmp_path, registered_checks=True, disabled_bash=True,
        checked_workflow=True,
    )

    assert "bash" not in {tool for tool, _content in executed}
    assert all("run_coding_check" not in tools for tools in requested)


def test_registered_check_rejects_model_supplied_command(monkeypatch, tmp_path):
    events, executed, _requested = _run_packet(
        monkeypatch, tmp_path, registered_checks=True, malformed_check=True,
        checked_workflow=True,
    )

    bash_commands = [content for tool, content in executed if tool == "bash"]
    assert "echo injected" not in bash_commands
    assert all(command in {_packet()["reproduce_command"], _packet()["acceptance_command"]}
               for command in bash_commands)
    assert any("takes no arguments" in event.get("output", "")
               for event in events if event.get("type") == "tool_output")


def test_registered_check_keeps_native_call_name_and_result_id():
    messages = []
    al._append_tool_results(
        messages, "", [{"id": "check-call-1", "name": "run_coding_check", "arguments": "{}"}],
        ["check passed"], ["check passed"], True, 1,
        tool_result_records=[{
            "tool_name": "bash", "content": _packet()["reproduce_command"],
            "result": {"exit_code": 0}, "text": "check passed",
        }],
    )

    assert messages[0]["tool_calls"][0]["function"]["name"] == "run_coding_check"
    assert messages[1]["tool_call_id"] == "check-call-1"


def test_checked_edit_stage_hides_and_rejects_shell_writes_with_actionable_error(monkeypatch, tmp_path):
    events, executed, requested = _run_packet(
        monkeypatch, tmp_path, checked_workflow=True, attempt_shell_edit=True,
        todos=[{"content": "Fix refresh behavior", "status": "in_progress"}],
    )

    # Turn four proposes the shell edit; its following model request receives
    # the blocker. Shell tools remain available again for acceptance in verify.
    assert not ({"bash", "python"} & requested[1])
    assert not ({"bash", "python"} & requested[2])
    assert "Bash and Python are unavailable during the edit stage" in json.dumps(events)
    assert "sed -i" not in json.dumps(executed)
    assert executed[-1] == ("bash", _packet()["acceptance_command"])


def test_reviewed_completed_packet_emits_success_terminal(monkeypatch, tmp_path):
    events, _executed, _requested = _run_packet(
        monkeypatch, tmp_path, verifier_issues=[],
        todos=[{"content": "Fix refresh behavior", "status": "in_progress"}],
        checked_workflow=True,
    )

    terminal = [event for event in events if event.get("type") == "agent_terminal"]
    assert terminal == [{"type": "agent_terminal", "status": "completed",
                         "reason": "coding_work_verified", "test_status": "passed",
                         "review_status": "passed"}]


def test_teacher_takeover_suppresses_checked_work_success_terminal(monkeypatch, tmp_path):
    events, _executed, _requested = _run_packet(
        monkeypatch, tmp_path, verifier_issues=[],
        todos=[{"content": "Fix refresh behavior", "status": "in_progress"}],
        teacher_event="escalation_started",
        checked_workflow=True,
    )
    assert any(event.get("type") == "escalation_started" for event in events)
    completed = any(event.get("type") == "agent_terminal" and event.get("status") == "completed"
                    for event in events)
    assert not completed


@pytest.mark.parametrize(("issues", "status"), [
    ([], "passed"),
    (["Failed: acceptance condition was not met"], "failed"),
    (["Unverified: the reviewer lacked evidence"], "unverified"),
])
def test_packet_reports_actual_independent_review_result(monkeypatch, tmp_path, issues, status):
    events, _executed, _requested = _run_packet(
        monkeypatch, tmp_path, verifier_issues=issues,
        checked_workflow=True,
        todos=[{"content": "Fix refresh behavior", "status": "in_progress"}],
    )

    packet_events = [event for event in events if event.get("type") == "coding_work_packet"]
    done_events = [event for event in packet_events if event["stage"] == "done"]
    assert [event["review_status"] for event in done_events] == ["not_reviewed", status]
    completed = any(event.get("type") == "agent_terminal" and event.get("status") == "completed"
                    for event in events)
    assert completed is (status == "passed")


def test_unreviewed_packet_emits_truthful_completion_terminal(monkeypatch, tmp_path):
    events, _executed, _requested = _run_packet(
        monkeypatch, tmp_path,
        todos=[{"content": "Fix refresh behavior", "status": "in_progress"}],
        checked_workflow=True,
    )
    terminal = [event for event in events if event.get("type") == "agent_terminal"]
    assert terminal == [{"type": "agent_terminal", "status": "completed",
                         "reason": "coding_checks_passed", "test_status": "passed",
                         "review_status": "not_reviewed"}]


def test_paused_or_unfinished_packet_does_not_emit_success_terminal(monkeypatch, tmp_path):
    paused, _executed, _requested = _run_packet(
        monkeypatch, tmp_path, pause_after_acceptance=True,
        todos=[{"content": "Fix refresh behavior", "status": "in_progress"}],
        checked_workflow=True,
    )
    assert any("Agent paused" in event.get("delta", "") for event in paused)
    assert not any(event.get("type") == "agent_terminal" and event.get("status") == "completed"
                   for event in paused)

    unfinished, _executed, _requested = _run_packet(
        monkeypatch, tmp_path, verifier_issues=[], checked_workflow=True,
    )
    assert not any(event.get("type") == "agent_terminal" and event.get("status") == "completed"
                   for event in unfinished)


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
@pytest.mark.parametrize("disabled_bash", [True, False])
def test_exactly_approved_write_uses_restored_reproduction_evidence(monkeypatch, tmp_path, valid_reproduction,
                                                                  disabled_bash):
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
        if block.tool_type == "bash":
            assert block.content == _packet()["acceptance_command" if valid_reproduction else "reproduce_command"]
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
        disabled_tools={"bash"} if disabled_bash else set(),
    ))
    events = _types(chunks)
    packets = [event for event in events if event.get("type") == "coding_work_packet"]
    assert packets[0]["stage"] == ("edit" if valid_reproduction else "reproduce")
    expected = ["write_file"] if valid_reproduction else []
    if not disabled_bash:
        expected.append("bash")
    assert executed == expected
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
        if block.tool_type == "bash":
            return "bash", {"exit_code": 1, "output": "baseline failure"}
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
    assert executed == ["todowrite", "bash"]


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


def test_server_checks_verify_existing_without_model_check_calls(monkeypatch, tmp_path):
    events, executed, _ = _run_packet(
        monkeypatch, tmp_path, checked_workflow=True, verify_existing=True,
        todos=[{"content": "Fix refresh behavior", "status": "in_progress"}],
    )
    assert [command for tool, command in executed if tool == "bash"] == [
        _packet()["reproduce_command"], _packet()["acceptance_command"],
    ]
    assert not any(tool == "write_file" for tool, _ in executed)
    assert any(event.get("stage") == "done" for event in events)


def test_server_check_retries_after_real_edit_not_failed_acceptance_alone(monkeypatch, tmp_path):
    events, executed, _ = _run_packet(
        monkeypatch, tmp_path, checked_workflow=True, repair_failed_check=True,
        todos=[{"content": "Fix refresh behavior", "status": "in_progress"}],
    )
    assert [tool for tool, _ in executed] == [
        "todowrite", "bash", "todowrite", "write_file", "bash", "write_file", "bash",
    ]
    assert any(event.get("stage") == "done" for event in events)


def test_server_check_respects_tool_budget(monkeypatch, tmp_path):
    events, executed, _ = _run_packet(
        monkeypatch, tmp_path, checked_workflow=True, max_tool_calls=1,
    )
    assert not any(tool == "bash" for tool, _ in executed)
    assert any(event.get("type") == "budget_exceeded" for event in events)


def test_server_baseline_not_repeated_after_blocked_attempt(monkeypatch, tmp_path):
    events, executed, _ = _run_packet(
        monkeypatch, tmp_path, checked_workflow=True, baseline_blocked=True,
    )
    assert [tool for tool, _ in executed].count("bash") == 1
    assert not any(tool == "write_file" for tool, _ in executed)
    assert not any(event.get("stage") == "done" for event in events)


def test_server_check_does_not_spend_model_round(monkeypatch, tmp_path):
    events, executed, requested = _run_packet(
        monkeypatch, tmp_path, checked_workflow=True, max_rounds=1,
    )
    assert [tool for tool, _ in executed] == ["todowrite", "bash", "todowrite"]
    assert len(requested) == 1
    assert any(event.get("type") == "rounds_exhausted" for event in events)


def test_server_result_preserves_prior_native_pair_and_reasoning():
    messages = [
        {"role": "assistant", "content": None, "reasoning_content": "existing provider reasoning",
         "tool_calls": [{"id": "edit-1", "type": "function", "function": {"name": "write_file", "arguments": "{}"}}]},
        {"role": "tool", "tool_call_id": "edit-1", "content": "saved"},
    ]
    al._append_tool_results(
        messages, "", [], ["check output"], ["check output"], False, 2,
        tool_result_records=[{"tool_name": "bash", "content": "pytest", "result": {"exit_code": 0}}],
        server_scheduled=True,
    )
    assert messages[0]["reasoning_content"] == "existing provider reasoning"
    assert messages[1]["tool_call_id"] == messages[0]["tool_calls"][0]["id"]
    assert len(messages) == 3
    assert messages[-1]["metadata"]["trusted"] is False
    assert "tool_call_id" not in messages[-1]


@pytest.mark.parametrize("initial", [True, False])
def test_packet_selection_schemas_exclude_effectful_actions_but_keep_readers(monkeypatch, tmp_path, initial):
    schemas = []
    events, executed, requested = _run_packet(
        monkeypatch, tmp_path, checked_workflow=True, extra_tools=True,
        no_packet_start=initial, schema_details=schemas,
    )
    names = requested[0] if initial else requested[-1]
    assert {"todowrite", "ask_user", "read_file", "grep", "glob", "ls"} <= names
    assert not ({"generate_image", "create_document", "bash", "python", "write_file", "edit_file", "apply_patch"} & names)
    if not initial:
        assert "generate_image" in requested[0], 'edit stage fixture must actually expose the effectful candidate'
        assert any(event.get("stage") == "done" for event in events)
        assert not any(event.get("type") == "agent_terminal" and event.get("status") == "completed" for event in events)
    selected = schemas[0] if initial else schemas[-1]
    skill = next(schema for schema in selected if schema["function"]["name"] == "manage_skills")
    actions = skill["function"]["parameters"]["properties"]["action"]["enum"]
    assert "view" in actions
    assert not ({"add", "edit", "delete", "publish"} & set(actions))
    original = next(schema for schema in al.FUNCTION_TOOL_SCHEMAS
                    if schema["function"]["name"] == "manage_skills")
    assert "delete" in original["function"]["parameters"]["properties"]["action"]["enum"]


@pytest.mark.parametrize("enabled", [True, False])
def test_workflow_startup_state_is_reported_before_any_packet(monkeypatch, tmp_path, enabled):
    events, _, _ = _run_packet(monkeypatch, tmp_path, checked_workflow=enabled, no_packet_start=True)
    status = [event for event in events if event.get("type") == "coding_workflow"]
    assert status == [{"type": "coding_workflow", "requested": enabled, "enabled": enabled}]
    assert not any(event.get("type") == "coding_work_packet" for event in events)
