import pytest

from src.milestone_checkpoint import MilestoneCheckpoint


def _todos(statuses=("in_progress", "pending")):
    return [{"content": f"step {index}", "status": status}
            for index, status in enumerate(statuses)]


def test_accepts_only_successful_todowrite_with_actionable_checklist():
    checkpoint = MilestoneCheckpoint(enabled=True)
    assert checkpoint.pending
    assert not checkpoint.observe("write_file", {"exit_code": 0, "todos": _todos()})
    assert not checkpoint.observe("todowrite", {"exit_code": 1, "todos": _todos()})
    assert not checkpoint.observe("todowrite", {"exit_code": 0, "approval_required": True, "todos": _todos()})
    assert checkpoint.pending
    assert checkpoint.observe("todowrite", {"exit_code": 0, "todos": _todos()})
    assert not checkpoint.pending


@pytest.mark.parametrize("todos", [
    [],
    [{"content": "only one", "status": "in_progress"}],
    [{"content": "done a", "status": "completed"}, {"content": "done b", "status": "completed"}],
    [{"content": "active", "status": "in_progress"}, {"content": "also active", "status": "in_progress"}],
    [{"content": "active", "status": "in_progress"}, {"content": "   ", "status": "pending"}],
    [{"content": "active", "status": "in_progress"}, {"content": "bad", "status": []}],
])
def test_rejects_invalid_or_non_actionable_checklists(todos):
    checkpoint = MilestoneCheckpoint(enabled=True)
    assert not checkpoint.observe("todowrite", {"exit_code": 0, "todos": todos})
    assert checkpoint.pending


def test_restore_accepts_active_progress_or_completed_history():
    assert not MilestoneCheckpoint(True, _todos()).pending
    completed = _todos(("completed", "completed"))
    assert not MilestoneCheckpoint(True, completed).pending
    assert MilestoneCheckpoint(True, _todos(("completed", "pending"))).pending


def test_disabled_checkpoint_and_two_rejection_cap():
    disabled = MilestoneCheckpoint(False)
    assert not disabled.pending
    assert not disabled.reject()

    checkpoint = MilestoneCheckpoint(True)
    assert not checkpoint.reject()
    assert checkpoint.pending
    assert checkpoint.reject()
    assert checkpoint.pending  # Exhaustion must never grant permission to proceed.
    assert checkpoint.reject()


def test_restore_last_milestone_does_not_demand_a_new_plan():
    checkpoint = MilestoneCheckpoint(True)
    assert checkpoint.restore(_todos(("completed", "in_progress")))
    assert not checkpoint.pending
