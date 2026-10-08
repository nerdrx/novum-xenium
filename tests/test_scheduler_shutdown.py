import asyncio
import os
import sys
import textwrap

import pytest
from sqlalchemy import Column, DateTime, String, Text, create_engine
from sqlalchemy.orm import declarative_base, sessionmaker


pytestmark = pytest.mark.skipif(os.name == "nt", reason="process-group assertions are POSIX-specific")


def _is_running(pid):
    try:
        with open(f"/proc/{pid}/stat", encoding="ascii") as stream:
            stat = stream.read().split()[2]
        return stat != "Z"
    except (FileNotFoundError, ProcessLookupError):
        return False


def _child_process_script(tmp_path):
    child_pid_file = tmp_path / "child.pid"
    script = tmp_path / "parent.py"
    script.write_text(textwrap.dedent(f"""\
        import subprocess, sys, time
        child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])
        open({str(child_pid_file)!r}, 'w').write(str(child.pid))
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
        open({str(child_pid_file)!r}, 'w').write(f'{{os.getpid()}} {{child.pid}}')
    """), encoding="utf-8")
    return script, child_pid_file


async def _wait_for_file(path):
    for _ in range(200):
        if path.exists():
            return
        await asyncio.sleep(0.01)
    raise AssertionError("fixture child did not start")


async def _wait_for_process_exit(pid):
    for _ in range(200):
        if not _is_running(pid):
            return
        await asyncio.sleep(0.01)
    raise AssertionError(f"fixture process {pid} survived cancellation")


async def _cancel_and_drain(task):
    if not task.done():
        task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass


def _kill_group(pid):
    try:
        os.killpg(pid, 9)
    except ProcessLookupError:
        pass


def _kill_pid(pid):
    try:
        os.kill(pid, 9)
    except ProcessLookupError:
        pass


def test_subprocess_cancellation_kills_only_owned_process_group(tmp_path):
    from src.builtin_actions import _run_subprocess

    script, child_pid_file = _child_process_script(tmp_path)

    async def drive():
        run = asyncio.create_task(_run_subprocess([sys.executable, str(script)]))
        try:
            await _wait_for_file(child_pid_file)
            child_pid = int(child_pid_file.read_text())
            run.cancel()
            with pytest.raises(asyncio.CancelledError):
                await run
            await _wait_for_process_exit(child_pid)
        finally:
            await _cancel_and_drain(run)

    asyncio.run(drive())


def test_subprocess_cancellation_kills_child_after_parent_exits(tmp_path):
    from src.builtin_actions import _run_subprocess

    script, child_pid_file = _exited_parent_child_script(tmp_path)

    async def drive():
        run = asyncio.create_task(_run_subprocess([sys.executable, str(script)]))
        child_pid = None
        try:
            await _wait_for_file(child_pid_file)
            parent_pid, child_pid = map(int, child_pid_file.read_text().split())
            # Parent exits immediately, but its child inherited our captured pipes.
            for _ in range(200):
                if not _is_running(parent_pid):
                    break
                await asyncio.sleep(0.01)
            else:
                raise AssertionError("fixture parent did not exit")
            assert not run.done()
            run.cancel()
            with pytest.raises(asyncio.CancelledError):
                await run
            await _wait_for_process_exit(child_pid)
        finally:
            await _cancel_and_drain(run)
            if child_pid is not None:
                _kill_pid(child_pid)

    asyncio.run(drive())


def test_subprocess_cancellation_during_spawn_reaps_created_group(tmp_path, monkeypatch):
    from src.builtin_actions import _run_subprocess

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
        run = asyncio.create_task(_run_subprocess([sys.executable, str(script)]))
        child_pid = None
        try:
            await asyncio.wait_for(created.wait(), timeout=5)
            await _wait_for_file(child_pid_file)
            child_pid = int(child_pid_file.read_text())
            run.cancel()
            await asyncio.sleep(0)
            assert not run.done(), "runner should still be cleaning up shielded spawn"
            release_spawn.set()
            with pytest.raises(asyncio.CancelledError):
                await run
            await _wait_for_process_exit(child_pid)
        finally:
            release_spawn.set()
            await _cancel_and_drain(run)
            if spawned:
                _kill_group(spawned[0].pid)
            if child_pid is not None:
                _kill_pid(child_pid)

    asyncio.run(drive())


def test_subprocess_timeout_still_returns_label_and_reaps_children(tmp_path):
    from src.builtin_actions import _run_subprocess

    script, child_pid_file = _child_process_script(tmp_path)

    async def drive():
        child_pid = None
        try:
            result = await _run_subprocess(
                [sys.executable, str(script)], timeout=3, label="Fixture",
            )
            assert result == ("Fixture timed out (3s)", False)
            child_pid = int(child_pid_file.read_text())
            await _wait_for_process_exit(child_pid)
        finally:
            if child_pid_file.exists():
                child_pid = int(child_pid_file.read_text())
                _kill_pid(child_pid)

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
