import asyncio
import os
import shlex
import sys
import textwrap

import pytest
from sqlalchemy import Column, DateTime, String, Text, create_engine
from sqlalchemy.orm import declarative_base, sessionmaker


async def _run_with_sealed_authority(argv, *, workspace=None, **kwargs):
    """Exercise the subprocess lifecycle under an exact server-sealed command."""
    from src.agent_runtime.authority import (
        ExactOperation, OperationGrant, RequestAuthority, bind_request_authority,
    )
    from src.builtin_actions import _run_subprocess

    command = shlex.join([str(arg) for arg in argv])
    operation = ExactOperation.normalize("bash", command)
    authority = RequestAuthority(
        "scheduler-test", "alice", "scheduler-test", str(workspace or os.getcwd()),
        (OperationGrant("bash", inputs=frozenset({operation.input})),),
    )
    with bind_request_authority(authority):
        return await _run_subprocess(argv, **kwargs)


POSIX_PROCESS_GROUP = pytest.mark.skipif(
    os.name == "nt", reason="process-group assertions are POSIX-specific",
)


def _containment_snapshot():
    from src import containment
    return dict(containment._load_records())


def _assert_containment_stopped(before, workspace):
    from src import containment, process_ownership

    records = containment._load_records()
    created = [
        record for key, record in records.items()
        if key not in before and record.get("workspace") == str(workspace)
    ]
    assert created, "the test command must have a persisted containment identity"
    for record in created:
        assert record.get("release", {}).get("dead") is True
        for pid_key, token_key in (("pid", "start_token"), ("namespace_pid", "namespace_start_token")):
            pid, token = record.get(pid_key), record.get(token_key)
            if pid and token:
                assert process_ownership.verify(pid, token) != process_ownership.OWNED


def _child_process_script(tmp_path):
    child_pid_file = tmp_path / "child.pid"
    script = tmp_path / "parent.py"
    script.write_text(textwrap.dedent(f"""\
        import subprocess, sys, time
        child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])
        open({str(child_pid_file)!r}, 'w').write('started')
        print('parent ready', flush=True)
        time.sleep(60)
    """), encoding="utf-8")
    return script, child_pid_file


def _exited_parent_child_script(tmp_path):
    child_pid_file = tmp_path / "detached-child.pid"
    script = tmp_path / "exited-parent.py"
    script.write_text(textwrap.dedent(f"""\
        import os, subprocess, sys
        child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])
        open({str(child_pid_file)!r}, 'w').write('started')
    """), encoding="utf-8")
    return script, child_pid_file


def _overflow_child_process_script(tmp_path):
    child_pid_file = tmp_path / "overflow-child.pid"
    script = tmp_path / "overflow-parent.py"
    script.write_text(textwrap.dedent(f"""\
        import subprocess, sys, time
        sys.stdout.write('x' * 200000)
        sys.stdout.flush()
        child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])
        open({str(child_pid_file)!r}, 'w').write('started')
        time.sleep(60)
    """), encoding="utf-8")
    return script, child_pid_file


async def _wait_for_file(path):
    for _ in range(200):
        if path.exists():
            return
        await asyncio.sleep(0.01)
    raise AssertionError("fixture child did not start")


async def _cancel_and_drain(task):
    if not task.done():
        task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass


@POSIX_PROCESS_GROUP
def test_subprocess_cancellation_kills_only_owned_process_group(tmp_path):
    script, child_pid_file = _child_process_script(tmp_path)

    async def drive():
        before = _containment_snapshot()
        run = asyncio.create_task(_run_with_sealed_authority([sys.executable, str(script)], workspace=tmp_path))
        try:
            await _wait_for_file(child_pid_file)
            run.cancel()
            with pytest.raises(asyncio.CancelledError):
                await run
            _assert_containment_stopped(before, tmp_path)
        finally:
            await _cancel_and_drain(run)

    asyncio.run(drive())


@POSIX_PROCESS_GROUP
def test_subprocess_cancellation_kills_child_after_parent_exits(tmp_path):
    script, child_pid_file = _exited_parent_child_script(tmp_path)

    async def drive():
        before = _containment_snapshot()
        run = asyncio.create_task(_run_with_sealed_authority([sys.executable, str(script)], workspace=tmp_path))
        try:
            await _wait_for_file(child_pid_file)
            # The parent exits immediately; the contained process-tree owner
            # must still reap its child before reporting command completion.
            result = await run
            assert result[1] is True
            _assert_containment_stopped(before, tmp_path)
        finally:
            await _cancel_and_drain(run)

    asyncio.run(drive())


@POSIX_PROCESS_GROUP
def test_subprocess_cancellation_during_spawn_reaps_created_group(tmp_path, monkeypatch):
    script, child_pid_file = _child_process_script(tmp_path)
    created = asyncio.Event()
    release_spawn = asyncio.Event()
    spawned = []
    original_create = asyncio.create_subprocess_exec

    async def delayed_create(*args, **kwargs):
        process = await original_create(*args, **kwargs)
        spawned.append(process)
        created.set()
        await release_spawn.wait()
        return process

    monkeypatch.setattr(asyncio, "create_subprocess_exec", delayed_create)

    async def drive():
        run = asyncio.create_task(_run_with_sealed_authority([sys.executable, str(script)], workspace=tmp_path))
        before = _containment_snapshot()
        try:
            await asyncio.wait_for(created.wait(), timeout=5)
            run.cancel()
            await asyncio.sleep(0)
            assert not run.done(), "runner should still be cleaning up shielded spawn"
            release_spawn.set()
            with pytest.raises(asyncio.CancelledError):
                await run
            _assert_containment_stopped(before, tmp_path)
            assert not child_pid_file.exists(), "cancellation before execution must not start the command"
        finally:
            release_spawn.set()
            await _cancel_and_drain(run)
            if spawned:
                await spawned[0].wait()

    asyncio.run(drive())


@POSIX_PROCESS_GROUP
def test_subprocess_timeout_still_returns_label_and_reaps_children(tmp_path):
    script, child_pid_file = _child_process_script(tmp_path)

    async def drive():
        before = _containment_snapshot()
        result = await _run_with_sealed_authority(
            [sys.executable, str(script)], workspace=tmp_path, timeout=3, label="Fixture",
        )
        assert "timed out after 3s" in result[0]
        assert result[1] is False
        assert child_pid_file.exists()
        _assert_containment_stopped(before, tmp_path)

    asyncio.run(drive())


def test_subprocess_bounds_both_streams_and_preserves_unicode(tmp_path):
    from src.constants import MAX_OUTPUT_CHARS

    async def drive():
        success = await _run_with_sealed_authority([
            sys.executable,
            "-c",
            "import sys; sys.stdout.write('λ' + 'o' * 150000); sys.stdout.flush(); "
            "sys.stderr.write('é' + 'e' * 150000); sys.stderr.flush()",
        ], workspace=tmp_path)
        success_suffix = "…[output truncated by containment capture limit]…"
        assert success[1] is True
        assert success[0].startswith("λ")
        assert success[0].endswith(success_suffix)
        assert len(success[0]) <= MAX_OUTPUT_CHARS

        failure = await _run_with_sealed_authority([
            sys.executable,
            "-c",
            "import sys; sys.stdout.write('ok'); sys.stdout.flush(); "
            "sys.stderr.write('é' + 'e' * 150000); sys.stderr.flush(); sys.exit(7)",
        ], workspace=tmp_path)
        failure_suffix = "…[output truncated by containment capture limit]…"
        assert failure[1] is False
        assert failure[0].startswith("ok\nSTDERR: é")
        assert failure[0].endswith(failure_suffix)
        assert len(failure[0]) <= MAX_OUTPUT_CHARS

    asyncio.run(drive())


def test_subprocess_trims_stdout_before_appending_failure_stderr():
    async def drive():
        result = await _run_with_sealed_authority([
            sys.executable,
            "-c",
            "import sys; sys.stdout.write('hi  \\n'); "
            "sys.stderr.write('err'); sys.exit(3)",
        ], workspace=os.getcwd())
        assert result == ("hi\nSTDERR: err", False)

    asyncio.run(drive())


def test_subprocess_without_authority_is_refused():
    from src.builtin_actions import _run_subprocess

    result = asyncio.run(_run_subprocess([sys.executable, "-c", "pass"]))
    assert result == ("Scheduled process launch has no server authority.", False)


@POSIX_PROCESS_GROUP
def test_subprocess_cancellation_after_output_overflow_stops_child(tmp_path):
    script, child_pid_file = _overflow_child_process_script(tmp_path)

    async def drive():
        before = _containment_snapshot()
        run = asyncio.create_task(_run_with_sealed_authority([sys.executable, str(script)], workspace=tmp_path))
        try:
            await _wait_for_file(child_pid_file)
            run.cancel()
            with pytest.raises(asyncio.CancelledError):
                await run
            _assert_containment_stopped(before, tmp_path)
        finally:
            await _cancel_and_drain(run)

    asyncio.run(drive())


def test_scheduler_shutdown_cancels_and_drains_owned_runs(tmp_path, monkeypatch):
    from src.task_scheduler import TaskScheduler

    scheduler = TaskScheduler.__new__(TaskScheduler)
    scheduler._running = True
    scheduler._task = None
    scheduler._note_pings_task = None
    scheduler._event_pings_task = None
    scheduler._executing = {"fixture"}
    scheduler._executing_lock = asyncio.Lock()
    scheduler._execution_handles = {}
    scheduler._task_handles = {}
    scheduler._all_task_handles = {}
    Base = declarative_base()

    class TaskRun(Base):
        __tablename__ = "task_runs"
        id = Column(String, primary_key=True)
        task_id = Column(String)
        started_at = Column(DateTime)
        finished_at = Column(DateTime)
        status = Column(String)
        result = Column(Text)
        error = Column(Text)

    engine = create_engine(f"sqlite:///{tmp_path / 'shutdown.db'}")
    Base.metadata.create_all(engine)
    session_local = sessionmaker(bind=engine)
    import core.database as cd
    monkeypatch.setattr(cd, "SessionLocal", session_local)
    monkeypatch.setattr(cd, "TaskRun", TaskRun)
    import datetime
    db = session_local()
    db.add(TaskRun(
        id="fixture-run", task_id="fixture", started_at=datetime.datetime.now(),
        status="running", result="working",
    ))
    db.commit()
    db.close()

    async def drive():
        async def run_action():
            await asyncio.Event().wait()

        handle = scheduler._track_task("fixture", run_action())
        await scheduler.stop()
        assert handle.done()

    asyncio.run(drive())
    db = session_local()
    try:
        run = db.query(TaskRun).filter(TaskRun.id == "fixture-run").one()
        assert run.status == "aborted"
        assert run.error == "Scheduler shutting down"
        assert run.finished_at is not None
    finally:
        db.close()
