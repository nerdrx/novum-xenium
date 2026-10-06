"""Durability and safe recovery boundaries for detached agent runs."""
import sqlite3

import pytest

from src import agent_runs, run_checkpoints


@pytest.mark.asyncio
async def test_run_manager_persists_completed_tool_outcome(tmp_path, monkeypatch):
    store = run_checkpoints.CheckpointStore(str(tmp_path / "runs.db"))
    monkeypatch.setattr(run_checkpoints, "_STORE", store)

    async def stream():
        # Real Odysseus text-delta SSE events often omit `type`.
        yield 'data: {"delta":"partial answer"}\n\n'
        yield 'data: {"type":"tool_start","tool":"bash","command":"make change"}\n\n'
        yield 'data: {"type":"tool_output","tool":"bash","command":"make change","output":"done","exit_code":0}\n\n'
        yield "data: [DONE]\n\n"

    session_id = "checkpoint-session-manager"
    run = agent_runs.start(session_id, stream(), owner="alice", context={
        "original_request": "Do the task", "workspace": "/workspace", "model": "local",
        "endpoint_id": "ep-1", "api_key": "must not persist",
    })
    await run.task

    checkpoint = agent_runs.get_checkpoint(session_id, "alice")
    assert checkpoint["status"] == "done"
    assert checkpoint["last_output"] == "partial answer"
    assert checkpoint["tool_outcomes"] == [{
        "tool": "bash", "command": "make change", "output": "done", "exit_code": 0,
    }]
    assert checkpoint["context"] == {
        "original_request": "Do the task", "workspace": "/workspace", "model": "local",
        "endpoint_id": "ep-1",
    }
    assert agent_runs.get_checkpoint(session_id, "bob") is None


def test_restart_marks_interrupted_and_one_use_claim_is_owner_scoped(tmp_path):
    path = str(tmp_path / "runs.db")
    first_process = run_checkpoints.CheckpointStore(path, recover_on_open=False)
    first_process.begin("run-1", "session-1", "alice", {
        "original_request": "continue this", "workspace": "/safe", "model": "m",
    })
    first_process.record("run-1", 'data: {"type":"delta","delta":"last visible"}\n\n')
    first_process.record("run-1", 'data: {"type":"tool_start","tool":"write_file","command":"x.txt"}\n\n')

    # Opening a fresh store models the next server process claiming stale runs.
    next_process = run_checkpoints.CheckpointStore(path)
    checkpoint = next_process.get("session-1", "alice")
    assert checkpoint["status"] == "interrupted"
    assert checkpoint["can_continue"] is True
    assert checkpoint["last_output"] == "last visible"
    assert checkpoint["pending_tool"] == {"tool": "write_file", "command": "x.txt"}
    assert checkpoint["uncertain_tool_outcome"] is True
    assert checkpoint["replay_tools"] is False
    assert next_process.get("session-1", "bob") is None

    assert next_process.claim_recovery("session-1", "bob", "run-1") is None
    claimed = next_process.claim_recovery("session-1", "alice", "run-1")
    assert claimed["context"]["original_request"] == "continue this"
    assert claimed["status"] == "continued"
    assert next_process.claim_recovery("session-1", "alice", "run-1") is None


def test_terminal_runs_stay_terminal_and_corrupt_checkpoint_fails_closed(tmp_path):
    path = str(tmp_path / "runs.db")
    store = run_checkpoints.CheckpointStore(path, recover_on_open=False)
    store.begin("done-run", "s", "alice")
    store.finish("done-run", "done")
    store.begin("stopped-run", "s2", "alice")
    store.finish("stopped-run", "stopped")
    store.begin("bad-run", "bad-session", "alice")
    with sqlite3.connect(path) as db:
        db.execute(
            "UPDATE agent_run_checkpoints SET payload=? WHERE run_id=?",
            ("{broken", "bad-run"),
        )

    reopened = run_checkpoints.CheckpointStore(path)
    assert reopened.get("s", "alice")["status"] == "done"
    assert reopened.get("s2", "alice")["status"] == "stopped"
    corrupt = reopened.get("bad-session", "alice")
    assert corrupt["status"] == "corrupt"
    assert corrupt["can_continue"] is False
    assert reopened.claim_recovery("bad-session", "alice", "bad-run") is None
