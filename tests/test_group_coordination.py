import os

import pytest

from src.group_coordination import GroupCoordinationStore, validate_board


def _board():
    return {
        "plan": "Finish the requested work",
        "participants": [
            {"id": "builder", "display": "Builder", "role": "builder"},
            {"id": "reviewer", "display": "Reviewer", "role": "reviewer"},
        ],
        "tasks": [{
            "id": "task-1", "title": "Implement feature", "owner_id": "builder",
            "reviewer_id": "reviewer", "status": "awaiting_review", "work_result": "Changed one file",
        }],
    }


def test_group_board_persists_and_scopes_by_owner(tmp_path):
    path = str(tmp_path / "group.db")
    first = GroupCoordinationStore(path)
    board = _board()
    first.save("parent", "alice", board)
    reopened = GroupCoordinationStore(path)
    assert reopened.get("parent", "alice") == board
    assert reopened.get("parent", "bob") is None
    if os.name == "posix":
        assert os.stat(path).st_mode & 0o777 == 0o600
    reopened.save("parent", "bob", {**board, "plan": "Bob's plan"})
    reopened.delete("parent", "alice")
    assert reopened.get("parent", "alice") is None
    assert reopened.get("parent", "bob")["plan"] == "Bob's plan"


@pytest.mark.parametrize("mutate", [
    lambda b: b["tasks"][0].update(owner_id="reviewer"),
    lambda b: b["tasks"][0].update(reviewer_id="builder"),
    lambda b: b["tasks"][0].update(status="done-by-model"),
])
def test_invalid_assignment_and_status_rejected(mutate):
    board = _board()
    mutate(board)
    with pytest.raises(ValueError):
        validate_board(board)


def test_task_output_is_bounded():
    board = _board()
    board["tasks"][0]["work_result"] = "x" * 20_000
    assert len(validate_board(board)["tasks"][0]["work_result"]) == 12_000


def test_unknown_oversized_payload_is_rejected():
    board = _board()
    board["unused"] = "x" * 700_000
    with pytest.raises(ValueError, match="too large"):
        validate_board(board)
