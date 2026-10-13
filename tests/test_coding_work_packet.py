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
