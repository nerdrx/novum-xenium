"""Durability and safe recovery boundaries for detached agent runs."""
import asyncio
import sqlite3
import json

import pytest

from src import agent_runs, run_checkpoints


@pytest.mark.asyncio
async def test_context_budget_failure_reaches_subscriber_as_actionable_error():
    async def stream():
        raise ValueError("Agent context budget cannot fit the complete current user request for private-model")
        yield  # Keep the same async-generator interface as the real agent.

    run = agent_runs.start("budget-failure-test", stream(), owner="alice", persist=False)
    await run.task
    error = next(chunk for chunk in run.buffer if chunk.startswith("event: error"))
    payload = json.loads(error.split("data: ", 1)[1])
    assert run.status == "error"
    assert payload["status"] == 400
    assert "increase the model context/input budget" in payload["error"]
    assert "private-model" not in payload["error"]
    if run.evict_task:
        run.evict_task.cancel()


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
        "endpoint_id": "ep-1", "original_request_complete": True,
    }
    assert agent_runs.get_checkpoint(session_id, "bob") is None


def test_original_request_is_preserved_through_the_raw_chat_limit(tmp_path):
    request = "start " + ("x" * 49_980) + " TAIL"
    store = run_checkpoints.CheckpointStore(str(tmp_path / "long-request.db"), recover_on_open=False)
    store.begin("long-run", "long-session", "alice", {"original_request": request})
    checkpoint = store.get("long-session", "alice")
    assert checkpoint["context"]["original_request"] == request
    assert checkpoint["context"]["original_request_complete"] is True


def test_original_request_over_limit_is_marked_incomplete(tmp_path):
    store = run_checkpoints.CheckpointStore(str(tmp_path / "oversize-request.db"), recover_on_open=False)
    store.begin("long-run", "long-session", "alice", {"original_request": "x" * 50_001})
    checkpoint = store.get("long-session", "alice")
    assert len(checkpoint["context"]["original_request"]) == 50_000
    assert checkpoint["context"]["original_request_complete"] is False


@pytest.mark.asyncio
async def test_stop_before_drain_starts_terminalizes_checkpoint(tmp_path, monkeypatch):
    store = run_checkpoints.CheckpointStore(str(tmp_path / "stopped.db"))
    monkeypatch.setattr(run_checkpoints, "_STORE", store)

    async def stream():
        yield 'data: {"delta":"should not run"}\n\n'

    session_id = "stop-before-drain-test"
    run = agent_runs.start(session_id, stream(), owner="alice")
    assert agent_runs.stop(session_id, run.run_id) is True
    await asyncio.gather(run.task, return_exceptions=True)

    assert run.status == "stopped"
    assert agent_runs.get_checkpoint(session_id, "alice")["status"] == "stopped"
    assert run.buffer == []
    if run.evict_task:
        run.evict_task.cancel()
    agent_runs._RUNS.pop(session_id, None)


@pytest.mark.asyncio
async def test_process_shutdown_preserves_interrupted_run_for_explicit_recovery(tmp_path, monkeypatch):
    store = run_checkpoints.CheckpointStore(str(tmp_path / "shutdown.db"))
    monkeypatch.setattr(run_checkpoints, "_STORE", store)
    session_id = "shutdown-recovery-test"

    async def stream():
        yield 'data: {"delta":"partial answer"}\n\n'
        await asyncio.Event().wait()

    run = agent_runs.start(session_id, stream(), owner="alice")
    while not run.buffer:
        await asyncio.sleep(0)

    assert await agent_runs.interrupt_active_runs(timeout=1) == 1
    await asyncio.gather(run.task, return_exceptions=True)

    checkpoint = store.get(session_id, "alice")
    assert checkpoint["status"] == "interrupted"
    assert checkpoint["can_continue"] is True
    assert checkpoint["last_output"] == "partial answer"
    assert checkpoint["replay_tools"] is False
    claimed = store.claim_recovery(session_id, "alice", run.run_id)
    assert claimed["status"] == "continued"
    assert store.claim_recovery(session_id, "alice", run.run_id) is None
    if run.evict_task:
        run.evict_task.cancel()
    agent_runs._RUNS.pop(session_id, None)


@pytest.mark.asyncio
async def test_stop_before_drain_wakes_subscriber_without_checkpoint(tmp_path, monkeypatch):
    store = run_checkpoints.CheckpointStore(str(tmp_path / "incognito.db"))
    monkeypatch.setattr(run_checkpoints, "_STORE", store)

    async def stream():
        yield 'data: {"delta":"should not run"}\n\n'

    session_id = "incognito-stop-before-drain-test"
    run = agent_runs.start(session_id, stream(), owner="alice", persist=False)
    queue = asyncio.Queue()
    run.subscribers.add(queue)

    assert agent_runs.stop(session_id, "stale-run-id") is False
    assert run.status == "running"
    assert queue.empty()

    assert agent_runs.stop(session_id, run.run_id) is True
    assert await asyncio.wait_for(queue.get(), timeout=0.1) == (None, None)
    await asyncio.gather(run.task, return_exceptions=True)

    assert run.status == "stopped"
    assert store.get(session_id, "alice") is None
    if run.evict_task:
        run.evict_task.cancel()
    agent_runs._RUNS.pop(session_id, None)


@pytest.mark.asyncio
async def test_triple_replacement_before_middle_drain_keeps_transitive_save_order():
    session_id = "triple-replacement-before-middle-drain"
    agent_runs._RUNS.pop(session_id, None)
    cleanup_started = asyncio.Event()
    release_cleanup = asyncio.Event()
    third_started = asyncio.Event()

    async def first_stream():
        try:
            yield 'data: {"delta":"first"}\n\n'
            await asyncio.Event().wait()
        finally:
            cleanup_started.set()
            await release_cleanup.wait()

    async def middle_stream():
        yield 'data: {"delta":"middle"}\n\n'

    async def third_stream():
        third_started.set()
        yield 'data: {"delta":"third"}\n\n'

    first = agent_runs.start(session_id, first_stream(), persist=False)
    while not first.buffer:
        await asyncio.sleep(0)

    # Replacing twice without yielding cancels the middle task before it can
    # enter _drain and inherit the first run's partial-save barrier.
    middle = agent_runs.start(session_id, middle_stream(), persist=False)
    third = agent_runs.start(session_id, third_stream(), persist=False)
    try:
        await asyncio.wait_for(cleanup_started.wait(), timeout=1)
        await asyncio.sleep(0)
        assert not third_started.is_set()

        release_cleanup.set()
        await asyncio.wait_for(first.task, timeout=1)
        await asyncio.wait_for(third.task, timeout=1)
        assert middle.status == "stopped"
        assert third_started.is_set()
    finally:
        release_cleanup.set()
        for run in (first, middle, third):
            if run.task and not run.task.done():
                run.task.cancel()
                await asyncio.gather(run.task, return_exceptions=True)
            if run.evict_task and not run.evict_task.done():
                run.evict_task.cancel()
            agent_runs._RUNS.pop(session_id, None)


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
