from __future__ import annotations

import pytest

from src.coding_work_packet import CodingWorkPacket, CodingWorkState


@pytest.fixture
def packet():
    return CodingWorkPacket.create(
        "Fix token refresh handling", ["src/auth.py", "tests/test_auth.py"],
        "pytest -q tests/test_auth.py::test_refresh", "pytest -q tests/test_auth.py",
        "All auth tests pass",
    )


def test_packet_is_bounded_and_json_friendly(packet):
    assert packet.to_dict()["files"] == ["src/auth.py", "tests/test_auth.py"]
    with pytest.raises(ValueError):
        CodingWorkPacket.create("x", ["../outside.py"], "run", "test", "pass")
    with pytest.raises(ValueError):
        CodingWorkPacket.create("x", ["src/a.py", "src//a.py"], "run", "test", "pass")
    with pytest.raises(ValueError):
        CodingWorkPacket("x", ("../outside.py",), "run", "test", "pass")
    with pytest.raises(ValueError):
        CodingWorkPacket.create("x", ["a.py"], "run\ntest", "test", "pass")


def test_tracker_normalizes_initial_and_repeated_absolute_path_proposals(tmp_path, packet):
    from src.coding_work_packet import CodingWorkTracker

    workspace = tmp_path / "workspace"
    workspace.mkdir()
    absolute = packet.to_dict()
    absolute["files"] = [str(workspace / file) for file in packet.files]
    todos = [{"content": "Fix token refresh handling", "status": "in_progress"}]
    tracker = CodingWorkTracker(enabled=True, workspace=str(workspace))

    assert not tracker.blocks("todowrite", {"todos": todos, "work_packet": absolute})
    assert tracker.observe("todowrite", "{}", {"exit_code": 0, "todos": todos, "work_packet": absolute})
    assert tracker.state.packet == packet
    assert not tracker.blocks("todowrite", {"todos": todos, "work_packet": absolute})
    assert not tracker.observe("todowrite", "{}", {"exit_code": 0, "todos": todos, "work_packet": absolute})


def test_tracker_rejects_absolute_paths_outside_workspace(tmp_path, packet):
    from src.coding_work_packet import CodingWorkTracker

    workspace = tmp_path / "workspace"
    workspace.mkdir()
    outside = packet.to_dict()
    outside["files"] = [str(tmp_path / "outside.py")]
    tracker = CodingWorkTracker(enabled=True, workspace=str(workspace))
    todos = [{"content": "Fix token refresh handling", "status": "in_progress"}]

    assert tracker.blocks("todowrite", {"todos": todos, "work_packet": outside})
    assert not tracker.observe("todowrite", "{}", {"exit_code": 0, "todos": todos, "work_packet": outside})
    assert tracker.state is None


def test_failed_reproduction_is_valid_evidence_and_exact_command_is_required(packet):
    state = CodingWorkState(packet)
    with pytest.raises(ValueError):
        state.record_reproduction("pytest -q", {"exit_code": 1})
    assert state.stage == "reproduce"
    assert state.record_reproduction(packet.reproduce_command, {"exit_code": 1, "output": "failed"}) == "edit"
    assert state.reproduction_result["exit_code"] == 1


@pytest.mark.parametrize("result", [
    {"error": "tool failed", "exit_code": 1},
    {"approval_required": True, "exit_code": 0},
    {"pending": True, "exit_code": 0},
    {"blocked": True, "exit_code": 0},
    {"status": "pending", "exit_code": 0},
])
def test_non_execution_results_do_not_advance(packet, result):
    state = CodingWorkState(packet)
    with pytest.raises(ValueError):
        state.record_reproduction(packet.reproduce_command, result)
    assert state.stage == "reproduce"


def test_acceptance_requires_successful_edit_and_post_edit_pass(packet):
    state = CodingWorkState(packet)
    state.record_reproduction(packet.reproduce_command, {"exit_code": 1})
    with pytest.raises(ValueError):
        state.record_acceptance(packet.acceptance_command, {"exit_code": 0})
    with pytest.raises(ValueError):
        state.record_edit("write_file", {"exit_code": 1, "error": "write failed"})
    assert state.stage == "edit"
    assert state.record_edit("write_file", {"exit_code": 0, "output": "saved"}) == "verify"
    with pytest.raises(ValueError):
        state.record_acceptance("pytest -q", {"exit_code": 0})
    assert state.record_acceptance(packet.acceptance_command, {"exit_code": 1}) == "verify"
    assert state.record_acceptance(packet.acceptance_command, {"exit_code": 0}) == "done"


def test_successful_later_edit_invalidates_acceptance(packet):
    state = CodingWorkState(packet)
    state.record_reproduction(packet.reproduce_command, {"exit_code": 0})
    state.record_edit("apply_patch", {"exit_code": 0})
    state.record_acceptance(packet.acceptance_command, {"exit_code": 0})

    assert state.record_edit("edit_file", {"exit_code": 0}) == "verify"
    assert state.acceptance_result is None
    assert state.to_dict()["stage"] == "verify"


def test_tracker_uses_results_and_prevents_replacing_unfinished_packet(packet):
    from src.coding_work_packet import CodingWorkTracker
    tracker = CodingWorkTracker()
    result = {"exit_code": 0, "work_packet": packet.to_dict()}
    assert tracker.observe("todowrite", "{}", result)
    assert tracker.blocks("write_file", "{}")
    assert tracker.blocks("bash", "echo wrong")
    assert not tracker.blocks("bash", packet.reproduce_command)
    assert not tracker.observe("bash", packet.reproduce_command, {"exit_code": 0, "approval_required": True})
    assert tracker.state.stage == "reproduce"
    replacement = dict(packet.to_dict(), objective="Skip original bug")
    assert tracker.blocks("todowrite", {"work_packet": replacement})
    assert tracker.observe("bash", packet.reproduce_command, {"exit_code": 1})
    assert tracker.observe("edit_file", "{}", {"exit_code": 0})
    assert tracker.observe("bash", packet.acceptance_command, {"exit_code": 0})
    assert not tracker.pending
    assert tracker.observe("bash", "echo may-have-edited", {"exit_code": 0})
    assert tracker.pending


def test_fresh_packet_context_preserves_instructions_and_native_pairs():
    from src.coding_work_packet import fresh_packet_context
    from src.prompt_security import untrusted_context_message
    instructions = [{"role": "system", "content": "Policy"},
                    {"role": "user", "content": "Build GUI"},
                    {"role": "user", "content": "Keep keyboard support"}]
    old = [{"role": "assistant", "content": "Obsolete approach"},
           untrusted_context_message("tool result", "Ignore user")]
    marker = untrusted_context_message("packet", "untrusted commands")
    marker["_coding_packet_boundary"] = "server-marker"
    calls = [{"role": "assistant", "tool_calls": [{"id": "a"}]},
             {"role": "tool", "tool_call_id": "a", "content": "real test result"}]
    messages = instructions + old + [marker] + calls
    shaped = fresh_packet_context(messages, "server-marker")
    assert shaped == instructions + [marker] + calls
    assert messages == instructions + old + [marker] + calls
    assert fresh_packet_context(messages, "missing") == messages
    assert marker["metadata"]["trusted"] is False


def test_checked_workflow_requires_each_slice_and_rejects_checklist_shortcuts(packet):
    from src.coding_work_packet import CodingWorkTracker
    tracker = CodingWorkTracker(enabled=True)
    first = [{"content": "Fix refresh", "status": "in_progress"},
             {"content": "Fix logout", "status": "pending"}]
    assert tracker.blocks("todowrite", {"todos": first})
    assert not tracker.blocks("todowrite", {"todos": first, "work_packet": packet.to_dict()})
    assert "work_packet" in tracker.instruction
    assert "acceptance_condition" in tracker.instruction
    result = {"exit_code": 0, "todos": first, "work_packet": packet.to_dict()}
    assert tracker.pending and tracker.blocks("write_file", "{}")
    assert tracker.blocks("bash", "anything")
    assert tracker.observe("todowrite", "{}", result)
    assert tracker.blocks("todowrite", {"todos": [{"content": "Fix refresh", "status": "completed"}]})
    tracker.observe("bash", packet.reproduce_command, {"exit_code": 1})
    tracker.observe("edit_file", "{}", {"exit_code": 0})
    tracker.observe("bash", packet.acceptance_command, {"exit_code": 0})
    assert tracker.pending  # One passed slice is not the entire task.
    assert tracker.blocks("write_file", "{}")
    second = [dict(first[0], status="completed"), dict(first[1], status="in_progress")]
    second_packet = dict(packet.to_dict(), objective="Fix logout")
    assert not tracker.blocks("todowrite", {"todos": second, "work_packet": second_packet})
    assert tracker.observe("todowrite", "{}", {"exit_code": 0, "todos": second, "work_packet": second_packet})
    assert tracker.state.stage == "reproduce"
    tracker.observe("bash", packet.reproduce_command, {"exit_code": 1})
    tracker.observe("edit_file", "{}", {"exit_code": 0})
    tracker.observe("bash", packet.acceptance_command, {"exit_code": 0})
    assert not tracker.pending


def test_checked_packet_instructions_follow_evidence_stage(packet):
    from src.coding_work_packet import CodingWorkTracker

    tracker = CodingWorkTracker(enabled=True)
    tracker.observe("todowrite", "{}", {
        "exit_code": 0,
        "todos": [{"content": "Fix refresh", "status": "in_progress"}],
        "work_packet": packet.to_dict(),
    })
    assert "run_coding_check {}" in tracker.instruction
    tracker.observe("bash", packet.reproduce_command, {"exit_code": 1})
    assert "recorded reproduction command has run" in tracker.instruction
    assert "write_file, edit_file, or apply_patch" in tracker.instruction
    assert "Bash and Python are unavailable" in tracker.instruction
    assert tracker.blocks("bash", "sed -i 's/a/b/' src/auth.py")
    assert tracker.blocks("python", "open('src/auth.py', 'w').write('x')")
    tracker.observe("write_file", "{}", {"exit_code": 0})
    assert "successful file edit is recorded" in tracker.instruction
    assert not tracker.blocks("bash", packet.acceptance_command)

    optional = CodingWorkTracker()
    optional.observe("todowrite", "{}", {"exit_code": 0, "work_packet": packet.to_dict()})
    optional.observe("bash", packet.reproduce_command, {"exit_code": 1})
    assert "Bash and Python are unavailable" not in optional.instruction
    assert not optional.blocks("bash", "sed -i 's/a/b/' src/auth.py")


def test_registered_check_resolves_only_packet_commands_and_rejects_arguments(packet):
    from src.coding_work_packet import CodingWorkTracker

    tracker = CodingWorkTracker(enabled=True)
    tracker.observe("todowrite", "{}", {
        "exit_code": 0,
        "todos": [{"content": "Fix refresh", "status": "in_progress"}],
        "work_packet": packet.to_dict(),
    })
    assert tracker.check_command("{}") == (packet.reproduce_command, None)
    assert tracker.check_command('{"command":"rm -rf /"}')[0] is None
    tracker.observe("bash", packet.reproduce_command, {"exit_code": 1})
    assert tracker.check_command("{}")[0] is None  # edit stage
    tracker.observe("write_file", "{}", {"exit_code": 0})
    assert tracker.check_command("{}") == (packet.acceptance_command, None)
    assert tracker.check_command("not-json")[0] is None


def test_failed_acceptance_allows_only_registered_command_correction(packet):
    from src.coding_work_packet import CodingWorkTracker

    tracker = CodingWorkTracker(enabled=True)
    todos = [{"content": "Fix token refresh handling", "status": "in_progress"}]
    tracker.observe("todowrite", "{}", {
        "exit_code": 0, "todos": todos, "work_packet": packet.to_dict(),
    })
    tracker.observe("bash", packet.reproduce_command, {"exit_code": 1})
    tracker.observe("edit_file", "{}", {"exit_code": 0, "output": "saved"})
    revised_data = dict(packet.to_dict(), acceptance_command="pytest -q tests/test_auth.py -v")
    assert tracker.blocks("todowrite", {
        "todos": todos, "work_packet": revised_data,
    })
    tracker.observe("bash", packet.acceptance_command, {
        "exit_code": 1, "output": "SyntaxError: invalid syntax",
    })
    assert "revise only work_packet.acceptance_command" in tracker.instruction

    revised = CodingWorkPacket(**revised_data)
    update = {"todos": todos, "work_packet": revised.to_dict()}
    assert not tracker.blocks("todowrite", update)
    assert tracker.observe("todowrite", "{}", {"exit_code": 0, **update})
    assert tracker.state.stage == "verify"
    assert tracker.state.packet == revised
    assert tracker.state.reproduction_result == {"exit_code": 1}
    assert tracker.state.edit_result["output"] == "saved"
    assert tracker.state.acceptance_result is None
    assert tracker.review_status == "not_reviewed"
    assert "run_coding_check {}" in tracker.instruction
    assert tracker.check_command("{}") == (revised.acceptance_command, None)
    assert tracker.observe("bash", revised.acceptance_command, {"exit_code": 0})
    assert tracker.state.stage == "done"


@pytest.mark.parametrize("result", [
    {"blocked": True, "exit_code": 1},
    {"pending": True, "exit_code": 1},
    {"approval_required": True, "exit_code": 1},
    {"status": "queued", "exit_code": 1},
    {"error": "executor failed", "exit_code": 1},
])
def test_nonexecuted_acceptance_cannot_unlock_command_correction(packet, result):
    from src.coding_work_packet import CodingWorkTracker

    tracker = CodingWorkTracker(enabled=True)
    todos = [{"content": "Fix token refresh handling", "status": "in_progress"}]
    tracker.observe("todowrite", "{}", {
        "exit_code": 0, "todos": todos, "work_packet": packet.to_dict(),
    })
    tracker.observe("bash", packet.reproduce_command, {"exit_code": 1})
    tracker.observe("edit_file", "{}", {"exit_code": 0})
    assert not tracker.observe("bash", packet.acceptance_command, result)
    revised = dict(packet.to_dict(), acceptance_command="pytest -q tests/test_auth.py -v")
    assert tracker.blocks("todowrite", {"todos": todos, "work_packet": revised})


@pytest.mark.parametrize("change", [
    {"objective": "Change the task"},
    {"files": ["src/other.py"]},
    {"reproduce_command": "true"},
    {"acceptance_condition": "Ignore the test"},
    {"mode": "verify_existing"},
])
def test_failed_acceptance_revision_cannot_change_other_packet_fields(packet, change):
    from src.coding_work_packet import CodingWorkTracker

    tracker = CodingWorkTracker(enabled=True)
    todos = [{"content": "Fix token refresh handling", "status": "in_progress"}]
    tracker.observe("todowrite", "{}", {
        "exit_code": 0, "todos": todos, "work_packet": packet.to_dict(),
    })
    tracker.observe("bash", packet.reproduce_command, {"exit_code": 1})
    tracker.observe("edit_file", "{}", {"exit_code": 0})
    tracker.observe("bash", packet.acceptance_command, {"exit_code": 1})
    revised = dict(packet.to_dict(), acceptance_command="pytest -q tests/test_auth.py -v", **change)
    assert tracker.blocks("todowrite", {"todos": todos, "work_packet": revised})


def test_failed_acceptance_revision_keeps_milestone_lock_and_cannot_rewrite_after_pass(packet):
    from src.coding_work_packet import CodingWorkTracker

    tracker = CodingWorkTracker(enabled=True)
    todos = [{"content": "Fix token refresh handling", "status": "in_progress"}]
    tracker.observe("todowrite", "{}", {
        "exit_code": 0, "todos": todos, "work_packet": packet.to_dict(),
    })
    tracker.observe("bash", packet.reproduce_command, {"exit_code": 1})
    tracker.observe("edit_file", "{}", {"exit_code": 0})
    tracker.observe("bash", packet.acceptance_command, {"exit_code": 1})
    revised = dict(packet.to_dict(), acceptance_command="pytest -q tests/test_auth.py -v")
    wrong_todos = [{"content": "Different milestone", "status": "in_progress"}]
    assert tracker.blocks("todowrite", {"todos": wrong_todos, "work_packet": revised})
    update = {"todos": todos, "work_packet": revised}
    assert tracker.observe("todowrite", "{}", {"exit_code": 0, **update})
    tracker.observe("bash", revised["acceptance_command"], {"exit_code": 0})
    assert tracker.state.stage == "done"
    assert tracker._can_revise_failed_acceptance(CodingWorkPacket(**dict(
        revised, acceptance_command="pytest -q tests/test_auth.py --maxfail=1",
    ))) is False


def test_checkpoint_restores_only_server_observed_stage_and_checklist(packet):
    from src.coding_work_packet import CodingWorkTracker

    tracker = CodingWorkTracker(enabled=True)
    todos = [{"content": "Fix token refresh handling", "status": "in_progress"}]
    tracker.observe("todowrite", "{}", {"exit_code": 0, "todos": todos, "work_packet": packet.to_dict()})
    tracker.observe("bash", packet.reproduce_command, {"exit_code": 1})
    checkpoint = tracker.checkpoint_data()

    restored = CodingWorkTracker(enabled=True)
    assert restored.restore_checkpoint(checkpoint) == "restored"
    assert restored.state.stage == "edit"
    assert restored.state.reproduction_result == {"exit_code": 1}
    assert restored.milestones == ("Fix token refresh handling",)
    assert restored.completed == set()

    tracker.observe("edit_file", "{}", {"exit_code": 0})
    tracker.observe("bash", packet.acceptance_command, {"exit_code": 1})
    failed_acceptance = CodingWorkTracker(enabled=True)
    assert failed_acceptance.restore_checkpoint(tracker.checkpoint_data()) == "restored"
    assert failed_acceptance.state.stage == "verify"
    assert failed_acceptance.state.acceptance_result == {"exit_code": 1}

    checkpoint["reproduction_exit_code"] = None
    reset = CodingWorkTracker(enabled=True)
    assert reset.restore_checkpoint(checkpoint) == "reset"
    assert reset.state.stage == "reproduce"
    assert reset.blocks("write_file", "{}")

    done = CodingWorkTracker(enabled=True)
    tracker.observe("edit_file", "{}", {"exit_code": 0})
    tracker.observe("bash", packet.acceptance_command, {"exit_code": 0})
    done_data = tracker.checkpoint_data()
    done_data["acceptance_exit_code"] = True
    assert done.restore_checkpoint(done_data) == "reset"
    assert done.state.stage == "reproduce"
    assert "Fix token refresh handling" not in done.completed

    inconsistent = tracker.checkpoint_data()
    inconsistent["stage"] = "done"
    inconsistent["acceptance_exit_code"] = 0
    inconsistent["completed"] = []
    reset_checklist = CodingWorkTracker(enabled=True)
    assert reset_checklist.restore_checkpoint(inconsistent) == "reset"
    assert reset_checklist.state.stage == "reproduce"

    inconsistent["completed"] = ["Fix token refresh handling"]
    inconsistent["current_milestone"] = "missing"
    malformed = CodingWorkTracker(enabled=True)
    assert malformed.restore_checkpoint(inconsistent) == "reset"
    assert malformed.state.stage == "reproduce"


def test_checkpoint_cannot_enable_workflow_or_restore_model_history(packet):
    from src.coding_work_packet import CodingWorkTracker

    source = CodingWorkTracker(enabled=True)
    source.observe("todowrite", "{}", {
        "exit_code": 0,
        "todos": [{"content": "Fix token refresh handling", "status": "in_progress"}],
        "work_packet": packet.to_dict(),
    })
    checkpoint = source.checkpoint_data()
    disabled = CodingWorkTracker(enabled=False)
    assert disabled.restore_checkpoint(checkpoint) == "ineligible"
    assert not disabled.enabled and disabled.state is None

    checkpoint["version"] = 999
    invalid = CodingWorkTracker(enabled=True)
    assert invalid.restore_checkpoint(checkpoint) == "invalid"
    assert invalid.state is None


def test_interrupted_recovery_retests_previously_passed_acceptance(packet):
    from src.coding_work_packet import CodingWorkTracker

    source = CodingWorkTracker(enabled=True)
    todos = [{"content": "Fix refresh", "status": "in_progress"}]
    source.observe("todowrite", "{}", {"exit_code": 0, "todos": todos, "work_packet": packet.to_dict()})
    source.observe("bash", packet.reproduce_command, {"exit_code": 1})
    source.observe("write_file", "{}", {"exit_code": 0})
    source.observe("bash", packet.acceptance_command, {"exit_code": 0})

    recovered = CodingWorkTracker(enabled=True)
    assert recovered.restore_checkpoint(source.checkpoint_data(), recovery=True) == "reset"
    assert recovered.state.stage == "reproduce"
    assert recovered.state.acceptance_result is None
    assert recovered.review_status == "not_reviewed"
    assert recovered.blocks("write_file", "{}")


@pytest.mark.parametrize(("stage", "edit_tool", "acceptance"), [
    ("verify", [], None),
    ("done", {}, 0),
])
def test_checkpoint_rejects_unhashable_edit_tool(packet, stage, edit_tool, acceptance):
    from src.coding_work_packet import CodingWorkTracker

    source = CodingWorkTracker(enabled=True)
    todos = [{"content": "Fix refresh", "status": "in_progress"}]
    source.observe("todowrite", "{}", {"exit_code": 0, "todos": todos, "work_packet": packet.to_dict()})
    source.observe("bash", packet.reproduce_command, {"exit_code": 1})
    source.observe("write_file", "{}", {"exit_code": 0})
    if stage == "done":
        source.observe("bash", packet.acceptance_command, {"exit_code": 0})
    checkpoint = source.checkpoint_data()
    checkpoint.update(stage=stage, edit_tool=edit_tool, acceptance_exit_code=acceptance)

    restored = CodingWorkTracker(enabled=True)
    assert restored.restore_checkpoint(checkpoint) == "reset"
    assert restored.state.stage == "reproduce"


def test_verify_existing_requires_real_checks_and_credits_only_active_slice(packet):
    from src.coding_work_packet import CodingWorkTracker
    tracker = CodingWorkTracker(enabled=True)
    todos = [{"content": "Verify auth", "status": "in_progress"},
             {"content": "Verify settings", "status": "pending"}]
    check_packet = dict(packet.to_dict(), mode="verify_existing")
    assert tracker.observe("todowrite", "{}", {
        "exit_code": 0, "todos": todos, "work_packet": check_packet})
    assert not tracker.observe("bash", packet.acceptance_command, {"exit_code": 0})
    assert tracker.observe("bash", packet.reproduce_command, {"exit_code": 0})
    assert tracker.state.stage == "verify"
    assert tracker.state.edit_result is None
    assert not tracker.observe("bash", packet.acceptance_command, {"exit_code": 0, "blocked": True})
    assert tracker.observe("bash", packet.acceptance_command, {"exit_code": 0})
    assert tracker.state.stage == "done"
    assert tracker.completed == {"Verify auth"}
    assert tracker.pending
    assert "Verify settings" in tracker.instruction
    assert "verify_existing" in tracker.instruction
    assert tracker.blocks("todowrite", {"todos": [dict(t, status="completed") for t in todos]})
    restored = CodingWorkTracker(enabled=True)
    assert restored.restore_checkpoint(tracker.checkpoint_data()) == "restored"
    assert restored.state.stage == "done"
    assert restored.state.edit_result is None
    assert restored.review_status == "not_reviewed"
    damaged = tracker.checkpoint_data()
    damaged["packet"].pop("mode")
    assert CodingWorkTracker(enabled=True).restore_checkpoint(damaged) == "reset"
    assert restored.restore_checkpoint(tracker.checkpoint_data(), recovery=True) == "reset"


def test_failed_verification_baseline_requires_repair(packet):
    from dataclasses import replace
    state = CodingWorkState(replace(packet, mode="verify_existing"))
    assert state.record_reproduction(packet.reproduce_command, {"exit_code": 1}) == "edit"
    with pytest.raises(ValueError, match="successful edit"):
        state.record_acceptance(packet.acceptance_command, {"exit_code": 0})
    state.record_edit("edit_file", {"exit_code": 0})
    assert state.record_acceptance(packet.acceptance_command, {"exit_code": 0}) == "done"
    for bad_mode in [None, [], "skip"]:
        with pytest.raises(ValueError, match="mode"):
            replace(packet, mode=bad_mode)


def test_next_slice_guidance_preserves_names_and_requires_fresh_checks(packet):
    import json
    from src.coding_work_packet import CodingWorkTracker

    tracker = CodingWorkTracker(enabled=True)
    names = ['Repair "sum"', 'Verify count\nincluding empty input', 'Verify integration']
    todos = [{"content": name, "status": "in_progress" if i == 0 else "pending"}
             for i, name in enumerate(names)]
    tracker.observe("todowrite", "{}", {
        "exit_code": 0, "todos": todos, "work_packet": packet.to_dict()})
    tracker.observe("bash", packet.reproduce_command, {"exit_code": 1})
    tracker.observe("edit_file", "{}", {"exit_code": 0})
    tracker.observe("bash", packet.acceptance_command, {"exit_code": 0})

    update = json.loads(tracker.instruction.splitlines()[1])
    assert [item["content"] for item in update["todos"]] == names
    assert [item["status"] for item in update["todos"]] == ["completed", "in_progress", "pending"]
    assert tracker.blocks("todowrite", update)  # Guidance alone grants no packet/evidence.
    update["work_packet"] = dict(packet.to_dict(), objective=names[1], mode="verify_existing")
    assert not tracker.blocks("todowrite", update)
    tracker.observe("todowrite", "{}", dict(update, exit_code=0))
    assert tracker.completed == {names[0]}
    assert tracker.state.stage == "reproduce"
    tracker.observe("bash", packet.reproduce_command, {"exit_code": 0})
    assert tracker.completed == {names[0]}
    tracker.observe("bash", packet.acceptance_command, {"exit_code": 0})
    assert tracker.completed == set(names[:2])
    assert tracker.pending  # The remaining integration slice was not silently credited.


def test_initial_guidance_defaults_to_one_outcome_without_forbidding_multiple(packet):
    from src.coding_work_packet import CodingWorkTracker

    tracker = CodingWorkTracker(enabled=True)
    assert "one concrete change and a real test as the default" in tracker.instruction
    assert "Keep inspection, implementation, and testing within that item" in tracker.instruction
    assert "distinct outcomes with separate acceptance checks" in tracker.instruction
    for todos in (
        [{"content": "Fix refresh", "status": "in_progress"}],
        [{"content": "Fix refresh", "status": "in_progress"},
         {"content": "Fix logout", "status": "pending"}],
    ):
        assert not tracker.blocks("todowrite", {"todos": todos, "work_packet": packet.to_dict()})
    assert tracker.blocks("edit_file", "{}")  # Guidance cannot bypass the baseline gate.


def test_acceptance_failure_bound_survives_checkpoint_and_edits(packet):
    from src.coding_work_packet import CodingWorkTracker
    tracker = CodingWorkTracker(enabled=True)
    tracker.observe("todowrite", "{}", {"exit_code": 0, "todos": [
        {"content": "Repair", "status": "in_progress"}], "work_packet": packet.to_dict()})
    tracker.observe("bash", packet.reproduce_command, {"exit_code": 1})
    assert tracker.failed_acceptance_checks == 0
    tracker.observe("edit_file", "{}", {"exit_code": 0})
    for blocked in ({"exit_code": 1, "blocked": True}, {"exit_code": 1, "approval_required": True}):
        tracker.observe("bash", packet.acceptance_command, blocked)
    assert tracker.failed_acceptance_checks == 0
    assert tracker.observe("bash", packet.acceptance_command, {"exit_code": 1})
    restored = CodingWorkTracker(enabled=True)
    assert restored.restore_checkpoint(tracker.checkpoint_data()) == "restored"
    assert restored.failed_acceptance_checks == 1
    # Identical failures still change counter/checkpoint even without an edit.
    assert restored.observe("bash", packet.acceptance_command, {"exit_code": 1})
    assert restored.retry_limit_reached
    resumed = CodingWorkTracker(enabled=True)
    resumed.restore_checkpoint(restored.checkpoint_data())
    assert resumed.retry_limit_reached
    assert resumed.blocks("todowrite", "{}")
    assert resumed.blocks("edit_file", "{}")
    assert resumed.check_command({})[0] is None
    assert CodingWorkTracker(enabled=True).failed_acceptance_checks == 0


def test_acceptance_success_resets_consecutive_failure_count(packet):
    from src.coding_work_packet import CodingWorkTracker
    tracker = CodingWorkTracker(enabled=True)
    tracker.observe("todowrite", "{}", {"exit_code": 0, "todos": [
        {"content": "Repair", "status": "in_progress"}], "work_packet": packet.to_dict()})
    tracker.observe("bash", packet.reproduce_command, {"exit_code": 1})
    tracker.observe("edit_file", "{}", {"exit_code": 0})
    tracker.observe("bash", packet.acceptance_command, {"exit_code": 1})
    tracker.observe("edit_file", "{}", {"exit_code": 0})
    assert tracker.failed_acceptance_checks == 1
    tracker.observe("bash", packet.acceptance_command, {"exit_code": 0})
    assert tracker.failed_acceptance_checks == 0
