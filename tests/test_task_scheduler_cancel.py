import asyncio
import sqlite3
import threading
from types import SimpleNamespace
import pytest
from datetime import datetime, timedelta, timezone

from sqlalchemy import Column, DateTime, String, Text, create_engine
from sqlalchemy.orm import declarative_base, sessionmaker


def _setup_db(tmp_path, monkeypatch):
    import core.database as cd

    base = declarative_base()

    class ScheduledTask(base):
        __tablename__ = "scheduled_tasks"

        id = Column(String, primary_key=True)
        owner = Column(String)
        name = Column(String)
        task_type = Column(String, default="llm")
        action = Column(String)
        status = Column(String, default="active")
        next_run = Column(DateTime)
        last_run = Column(DateTime)
        prompt = Column(Text, default='')
        request_authority_json = Column(Text)
        trigger_type = Column(String, default='schedule')
        schedule = Column(String, default='daily')
        scheduled_time = Column(String, default='08:00')
        scheduled_day = Column(String)
        scheduled_date = Column(DateTime)
        cron_expression = Column(String)
        then_task_id = Column(String)

    class TaskRun(base):
        __tablename__ = "task_runs"

        id = Column(String, primary_key=True)
        task_id = Column(String)
        started_at = Column(DateTime)
        finished_at = Column(DateTime)
        status = Column(String)
        result = Column(Text)
        error = Column(Text)
        model = Column(String)

    engine = create_engine(f"sqlite:///{tmp_path / 'tasks.db'}")
    base.metadata.create_all(engine)
    session_local = sessionmaker(bind=engine, autocommit=False, autoflush=False)
    monkeypatch.setattr(cd, "SessionLocal", session_local)
    monkeypatch.setattr(cd, "ScheduledTask", ScheduledTask)
    monkeypatch.setattr(cd, "TaskRun", TaskRun)
    return session_local, ScheduledTask, TaskRun


def test_stop_task_cleans_up_queued_handle_and_run(tmp_path, monkeypatch):
    session_local, ScheduledTask, TaskRun = _setup_db(tmp_path, monkeypatch)

    db = session_local()
    db.add(ScheduledTask(
        id="queued-task",
        owner="alice",
        name="Queued Task",
        task_type="llm",
        status="active",
    ))
    db.commit()
    db.close()

    from src.task_scheduler import TaskScheduler

    async def drive():
        scheduler = TaskScheduler.__new__(TaskScheduler)
        scheduler._executing = {"queued-task"}
        scheduler._executing_lock = asyncio.Lock()
        scheduler._run_semaphore = asyncio.Semaphore(1)
        scheduler._task_handles = {}
        scheduler._execution_handles = {}
        scheduler._concurrency_cap = 1
        scheduler._task_defer_counts = {}
        await scheduler._run_semaphore.acquire()

        task = asyncio.create_task(scheduler._execute_task("queued-task"))
        try:
            for _ in range(50):
                if "queued-task" in scheduler._task_handles:
                    db2 = session_local()
                    try:
                        run = db2.query(TaskRun).filter(TaskRun.task_id == "queued-task").first()
                        if run:
                            break
                    finally:
                        db2.close()
                await asyncio.sleep(0.01)
            else:
                raise AssertionError("queued run was not created")

            assert await scheduler.stop_task("queued-task") is True
            try:
                await task
            except asyncio.CancelledError:
                pass
        finally:
            scheduler._run_semaphore.release()

        assert "queued-task" not in scheduler._task_handles
        assert "queued-task" not in scheduler._executing

    asyncio.run(drive())

    db = session_local()
    try:
        run = db.query(TaskRun).filter(TaskRun.task_id == "queued-task").first()
        assert run.status == "aborted"
        assert run.error == "Stop requested"
        assert run.finished_at is not None
        assert run.finished_at >= run.started_at
    finally:
        db.close()


@pytest.mark.parametrize('mode', ['foreground', 'single', 'queued', 'queued_repeat'])
@pytest.mark.parametrize('lock_mode', ['EXCLUSIVE', 'IMMEDIATE'])
def test_cancel_keeps_event_loop_responsive_during_database_lock(tmp_path, monkeypatch, mode, lock_mode):
    session_local, ScheduledTask, TaskRun = _setup_db(tmp_path, monkeypatch)
    with session_local() as db:
        if mode.startswith('queued'):
            db.add(ScheduledTask(id='locked-task', owner='alice', name='Fixture',
                task_type='llm', status='active',
                next_run=datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(minutes=1)))
        else:
            db.add(TaskRun(id='locked-run', task_id='locked-task', status='running'))
        db.commit()
    from src.task_scheduler import TaskScheduler

    holder = sqlite3.connect(tmp_path / 'tasks.db', check_same_thread=False)
    assert holder.execute('PRAGMA journal_mode').fetchone()[0] == 'wal'
    heartbeat = threading.Event()
    progress_before_release = []
    def release_lock():
        progress_before_release.append(heartbeat.is_set())
        holder.commit()
    release = threading.Timer(0.25, release_lock)

    async def drive():
        scheduler = TaskScheduler(None)
        scheduler._executing.add('locked-task')
        pending = None
        if mode.startswith('queued'):
            await scheduler._run_semaphore.acquire()
            pending = asyncio.create_task(scheduler._execute_task('locked-task'))
            await asyncio.sleep(0)
            assert 'locked-task' in scheduler._task_handles
        holder.execute(f'BEGIN {lock_mode}')
        asyncio.get_running_loop().call_later(0.02, heartbeat.set)
        repeated_stops = []
        if mode == 'queued_repeat':
            asyncio.get_running_loop().call_later(0.04, lambda: repeated_stops.append(
                asyncio.create_task(scheduler.stop_task('locked-task'))))
        release.start()
        if mode == 'foreground':
            assert await scheduler.stop_background_tasks_for_foreground() == 1
        else:
            assert await scheduler.stop_task('locked-task') is True
        if pending:
            with pytest.raises(asyncio.CancelledError):
                await pending
            scheduler._run_semaphore.release()
        if repeated_stops:
            await asyncio.gather(*repeated_stops)

    try:
        asyncio.run(drive())
    finally:
        release.join(timeout=2)
        holder.close()
    assert progress_before_release == [True], 'foreground event loop froze behind SQLite'
    with session_local() as db:
        assert db.query(TaskRun).filter_by(task_id='locked-task').one().status == 'aborted'
        if mode.startswith('queued'):
            task = db.get(ScheduledTask, 'locked-task')
            assert task.status == 'active'
            assert task.next_run > datetime.now(timezone.utc).replace(tzinfo=None)


def test_running_task_cancel_keeps_event_loop_responsive_during_database_lock(tmp_path, monkeypatch):
    session_local, ScheduledTask, TaskRun = _setup_db(tmp_path, monkeypatch)
    from src.task_scheduler import TaskScheduler
    from src.builtin_actions import BUILTIN_ACTIONS
    monkeypatch.setenv('BACKGROUND_TASK_FOREGROUND_GATE', 'false')
    from src.agent_runtime.authority import seal_task_authority
    with session_local() as db:
        db.add(ScheduledTask(id='running-task', owner='alice', name='Fixture action',
            task_type='action', action='fixture_wait', status='active',
            request_authority_json=seal_task_authority('', 'action', 'fixture_wait', owner='alice')))
        db.commit()
    started = asyncio.Event()
    async def external_action(**kwargs):
        started.set()
        await asyncio.Event().wait()
    monkeypatch.setitem(BUILTIN_ACTIONS, 'fixture_wait', external_action)
    holder = sqlite3.connect(tmp_path / 'tasks.db', check_same_thread=False)
    heartbeat = threading.Event()
    progress_before_release = []
    def release_lock():
        progress_before_release.append(heartbeat.is_set())
        holder.commit()
    release = threading.Timer(0.25, release_lock)

    async def drive():
        scheduler = TaskScheduler(None)
        assert await scheduler.run_task_now('running-task')
        await asyncio.wait_for(started.wait(), timeout=2)
        pending = scheduler._task_handles['running-task']
        holder.execute('BEGIN EXCLUSIVE')
        asyncio.get_running_loop().call_later(0.02, heartbeat.set)
        release.start()
        assert await scheduler.stop_task('running-task')
        await pending
    try:
        asyncio.run(drive())
    finally:
        if release.ident is not None:
            release.join(timeout=2)
        holder.close()
    assert progress_before_release == [True], 'running-task cleanup blocked foreground'
    with session_local() as db:
        assert db.query(TaskRun).filter_by(task_id='running-task').one().status == 'aborted'
        task = db.get(ScheduledTask, 'running-task')
        assert task.status == 'active'
        assert task.next_run > datetime.now(timezone.utc).replace(tzinfo=None)

def test_stop_before_task_starts_cancels_registered_handle(tmp_path, monkeypatch):
    session_local, ScheduledTask, _ = _setup_db(tmp_path, monkeypatch)

    db = session_local()
    db.add(ScheduledTask(
        id="immediate-stop",
        owner="alice",
        name="Immediate Stop",
        task_type="llm",
        status="active",
    ))
    db.commit()
    db.close()

    import routes.task_routes as task_routes
    from src.task_scheduler import TaskScheduler

    async def drive():
        scheduler = TaskScheduler.__new__(TaskScheduler)
        scheduler._executing = set()
        scheduler._executing_lock = asyncio.Lock()
        scheduler._run_semaphore = asyncio.Semaphore(1)
        scheduler._task_handles = {}
        scheduler._execution_handles = {}
        scheduler._concurrency_cap = 1
        scheduler._task_defer_counts = {}
        started = asyncio.Event()

        async def should_not_start(self, task_id, run_id, **kwargs):
            started.set()

        scheduler._execute_task_locked = should_not_start.__get__(scheduler)
        class FakeQuery:
            def filter(self, *_args):
                return self

            def first(self):
                return SimpleNamespace(owner="alice", task_type="llm", action=None)

        class FakeDb:
            def query(self, *_args):
                return FakeQuery()

            def close(self):
                pass

        monkeypatch.setattr(task_routes, "SessionLocal", FakeDb)
        monkeypatch.setattr(task_routes, "get_current_user", lambda _request: "alice")
        router = task_routes.setup_task_routes(scheduler)
        endpoints = {
            route.path: route.endpoint
            for route in router.routes
            if getattr(route, "path", None) in (
                "/api/tasks/{task_id}/run",
                "/api/tasks/{task_id}/stop",
            )
        }

        await endpoints["/api/tasks/{task_id}/run"](SimpleNamespace(), "immediate-stop")
        handle = scheduler._task_handles["immediate-stop"]
        await endpoints["/api/tasks/{task_id}/stop"](SimpleNamespace(), "immediate-stop")
        assert handle.cancelled() or handle.cancelling()
        await asyncio.sleep(0)
        await asyncio.sleep(0)  # task done callback removes pre-start cancellation

        assert not started.is_set()
        assert "immediate-stop" not in scheduler._executing
        assert "immediate-stop" not in scheduler._task_handles
        assert "immediate-stop" not in scheduler._execution_handles

    asyncio.run(drive())

def test_stopped_run_cleanup_does_not_release_restarted_run(tmp_path, monkeypatch):
    session_local, ScheduledTask, _ = _setup_db(tmp_path, monkeypatch)

    db = session_local()
    db.add(ScheduledTask(
        id="restart-task",
        owner="alice",
        name="Restart Task",
        task_type="llm",
        status="active",
    ))
    db.commit()
    db.close()

    from src.task_scheduler import TaskScheduler

    async def drive():
        scheduler = TaskScheduler.__new__(TaskScheduler)
        scheduler._executing = set()
        scheduler._executing_lock = asyncio.Lock()
        scheduler._run_semaphore = asyncio.Semaphore(1)
        scheduler._task_handles = {}
        scheduler._execution_handles = {}
        scheduler._concurrency_cap = 1
        scheduler._task_defer_counts = {}
        await scheduler._run_semaphore.acquire()

        try:
            assert await scheduler.run_task_now("restart-task") is True
            old_handle = scheduler._task_handles["restart-task"]
            await asyncio.sleep(0)  # old run starts and waits on semaphore

            assert await scheduler.stop_task("restart-task") is True
            assert await scheduler.run_task_now("restart-task") is True
            new_handle = scheduler._task_handles["restart-task"]
            assert new_handle is not old_handle

            await asyncio.sleep(0)  # old cancellation cleanup runs before new run
            assert "restart-task" in scheduler._executing
            assert scheduler._task_handles["restart-task"] is new_handle

            assert await scheduler.stop_task("restart-task") is True
            await asyncio.sleep(0)
        finally:
            scheduler._run_semaphore.release()

        for handle in (old_handle, new_handle):
            try:
                await handle
            except asyncio.CancelledError:
                pass

        assert "restart-task" not in scheduler._executing
        assert "restart-task" not in scheduler._task_handles

    asyncio.run(drive())

def test_inner_executor_cleanup_does_not_release_restarted_run(tmp_path, monkeypatch):
    session_local, ScheduledTask, _ = _setup_db(tmp_path, monkeypatch)

    db = session_local()
    db.add(ScheduledTask(
        id="inner-restart-task",
        owner="alice",
        name="Inner Restart Task",
        task_type="llm",
        trigger_type="event",
        status="active",
    ))
    db.commit()
    db.close()

    import src.interactive_gate as interactive_gate
    from src.task_scheduler import TaskScheduler

    first_entered = asyncio.Event()
    second_entered = asyncio.Event()
    release_first = asyncio.Event()
    release_second = asyncio.Event()
    calls = 0

    async def wait_for_quiet(_reason):
        nonlocal calls
        calls += 1
        if calls == 1:
            first_entered.set()
            await release_first.wait()
        else:
            second_entered.set()
            await release_second.wait()

    monkeypatch.setattr(interactive_gate, "wait_for_interactive_quiet", wait_for_quiet)
    monkeypatch.setattr(interactive_gate, "has_foreground_activity", lambda: False)

    async def drive():
        scheduler = TaskScheduler.__new__(TaskScheduler)
        scheduler._executing = set()
        scheduler._executing_lock = asyncio.Lock()
        scheduler._run_semaphore = asyncio.Semaphore(1)
        scheduler._task_handles = {}
        scheduler._execution_handles = {}
        scheduler._concurrency_cap = 1
        scheduler._task_defer_counts = {}

        assert await scheduler.run_task_now("inner-restart-task") is True
        old_handle = scheduler._task_handles["inner-restart-task"]
        await asyncio.wait_for(first_entered.wait(), 1)

        assert await scheduler.stop_task("inner-restart-task") is True
        assert await scheduler.run_task_now("inner-restart-task") is True
        new_handle = scheduler._task_handles["inner-restart-task"]
        await asyncio.wait_for(second_entered.wait(), 1)
        try:
            await asyncio.wait_for(old_handle, 1)
        except asyncio.CancelledError:
            pass

        assert scheduler._task_handles["inner-restart-task"] is new_handle
        assert scheduler._execution_handles["inner-restart-task"] is new_handle
        assert "inner-restart-task" in scheduler._executing

        assert await scheduler.stop_task("inner-restart-task") is True
        try:
            await asyncio.wait_for(new_handle, 1)
        except asyncio.CancelledError:
            pass
        await asyncio.sleep(0)
        assert "inner-restart-task" not in scheduler._executing
        assert "inner-restart-task" not in scheduler._task_handles

    asyncio.run(drive())

def test_chained_run_registers_handle_and_skips_duplicate(tmp_path, monkeypatch):
    _setup_db(tmp_path, monkeypatch)
    from src.task_scheduler import TaskScheduler

    async def drive():
        scheduler = TaskScheduler.__new__(TaskScheduler)
        scheduler._executing = set()
        scheduler._executing_lock = asyncio.Lock()
        scheduler._task_handles = {}
        scheduler._execution_handles = {}
        started = asyncio.Event()
        release = asyncio.Event()

        async def block(task_id):
            started.set()
            await release.wait()

        scheduler._execute_task = block
        await scheduler._run_chained("chain-task")
        handle = scheduler._task_handles["chain-task"]
        assert scheduler._execution_handles["chain-task"] is handle
        await scheduler._run_chained("chain-task")
        assert scheduler._task_handles["chain-task"] is handle
        await started.wait()

        assert await scheduler.stop_task("chain-task") is True
        try:
            await handle
        except asyncio.CancelledError:
            pass
        await asyncio.sleep(0)
        assert "chain-task" not in scheduler._executing
        assert "chain-task" not in scheduler._task_handles

    asyncio.run(drive())

def test_force_runs_remain_parallel_and_track_latest_handle(tmp_path, monkeypatch):
    _setup_db(tmp_path, monkeypatch)
    from src.task_scheduler import TaskScheduler

    async def drive():
        scheduler = TaskScheduler.__new__(TaskScheduler)
        scheduler._executing = set()
        scheduler._executing_lock = asyncio.Lock()
        scheduler._task_handles = {}
        scheduler._execution_handles = {}
        started = []
        release = asyncio.Event()

        async def block(task_id, **kwargs):
            started.append(task_id)
            await release.wait()

        scheduler._execute_task = block
        assert await scheduler.run_task_now("forced-task", force=True) is True
        first = scheduler._task_handles["forced-task"]
        assert await scheduler.run_task_now("forced-task", force=True) is True
        latest = scheduler._task_handles["forced-task"]
        assert first is not latest
        assert scheduler._executing == set()
        assert scheduler._execution_handles == {}

        await asyncio.sleep(0)
        assert started == ["forced-task", "forced-task"]
        assert await scheduler.stop_task("forced-task") is True
        await asyncio.sleep(0)
        assert first.cancelled() or first.cancelling()
        assert latest.cancelled() or latest.cancelling()

        first.cancel()
        try:
            await first
        except asyncio.CancelledError:
            pass
        try:
            await latest
        except asyncio.CancelledError:
            pass

    asyncio.run(drive())

def test_stop_does_not_release_replacement_execution_reservation(tmp_path, monkeypatch):
    _setup_db(tmp_path, monkeypatch)
    from src.task_scheduler import TaskScheduler

    async def drive():
        scheduler = TaskScheduler.__new__(TaskScheduler)
        scheduler._executing = set()
        scheduler._executing_lock = asyncio.Lock()
        scheduler._task_handles = {}
        scheduler._all_task_handles = {}
        scheduler._execution_handles = {}
        scheduler._task_defer_counts = {}
        scheduler._mark_run_aborted = lambda *_args, **_kwargs: False
        first_started = asyncio.Event()
        replacement_started = asyncio.Event()
        release_replacement = asyncio.Event()
        run_handles = []

        async def execute(_task_id, **_kwargs):
            handle = asyncio.current_task()
            run_handles.append(handle)
            if len(run_handles) == 1:
                first_started.set()
                await asyncio.Future()
            replacement_started.set()
            await release_replacement.wait()

        scheduler._execute_task = execute
        assert await scheduler.run_task_now("reservation-race")
        first = scheduler._task_handles["reservation-race"]
        await first_started.wait()

        # Queue a legitimate retry before Stop reaches the same lock. The old
        # run's cancellation cleanup clears its reservation while both calls
        # wait; Stop must not then erase the replacement's new ownership.
        await scheduler._executing_lock.acquire()
        replacement_request = asyncio.create_task(scheduler.run_task_now("reservation-race"))
        await asyncio.sleep(0)
        stop_request = asyncio.create_task(scheduler.stop_task("reservation-race"))
        await asyncio.sleep(0)
        await asyncio.sleep(0)  # let the canceled original clean up its owner
        scheduler._executing_lock.release()

        assert await replacement_request is True
        replacement = scheduler._task_handles["reservation-race"]
        assert await stop_request is True
        await replacement_started.wait()

        assert scheduler._executing == {"reservation-race"}
        assert scheduler._execution_handles["reservation-race"] is replacement
        assert await scheduler.run_task_now("reservation-race") is False
        assert run_handles == [first, replacement]

        release_replacement.set()
        await replacement

    asyncio.run(drive())

def test_delete_task_drains_active_run_before_removing_task(tmp_path, monkeypatch):
    session_local, ScheduledTask, TaskRun = _setup_db(tmp_path, monkeypatch)
    db = session_local()
    db.add(ScheduledTask(
        id="delete-active-task", owner="alice", name="Delete active task",
        task_type="llm", status="active",
    ))
    db.commit()
    db.close()

    import routes.task.task_routes as task_routes
    from src.task_scheduler import TaskScheduler

    async def drive():
        scheduler = TaskScheduler.__new__(TaskScheduler)
        scheduler._executing = set()
        scheduler._executing_lock = asyncio.Lock()
        scheduler._task_handles = {}
        scheduler._execution_handles = {}
        scheduler._run_semaphore = asyncio.Semaphore(1)
        scheduler._task_defer_counts = {}
        scheduler._task_needs_model_slot = lambda _task_id: False
        started = asyncio.Event()
        release = asyncio.Event()
        side_effects = []
        replacement_results = []

        async def paused_run(_task_id, _run_id, **_kwargs):
            started.set()
            try:
                await release.wait()
            except asyncio.CancelledError:
                replacement_results.append(
                    await scheduler.run_task_now("delete-active-task", force=True)
                )
                raise
            side_effects.append("ran after deletion")

        scheduler._execute_task_locked = paused_run
        assert await scheduler.run_task_now("delete-active-task") is True
        handle = scheduler._task_handles["delete-active-task"]
        await started.wait()

        monkeypatch.setattr(task_routes, "SessionLocal", session_local)
        monkeypatch.setattr(task_routes, "ScheduledTask", ScheduledTask)
        monkeypatch.setattr(task_routes, "get_current_user", lambda _request: "alice")
        router = task_routes.setup_task_routes(scheduler)
        delete_endpoint = next(
            route.endpoint for route in router.routes
            if getattr(route, "path", None) == "/api/tasks/{task_id}"
            and "DELETE" in getattr(route, "methods", set())
        )

        await delete_endpoint(SimpleNamespace(), "delete-active-task")
        assert handle.done()
        assert replacement_results == [False]

        release.set()
        await asyncio.sleep(0)
        assert side_effects == []

        db = session_local()
        try:
            assert db.query(ScheduledTask).filter_by(id="delete-active-task").first() is None
            run = db.query(TaskRun).filter_by(task_id="delete-active-task").one()
            assert run.status == "aborted"
        finally:
            db.close()

    asyncio.run(drive())

def test_calendar_cascade_does_not_block_async_task_delete(tmp_path, monkeypatch):
    session_local, ScheduledTask, _ = _setup_db(tmp_path, monkeypatch)
    db = session_local()
    db.add(ScheduledTask(
        id="delete-calendar-task", owner="alice", name="Serve model",
        task_type="action", action="cookbook_serve", status="active",
    ))
    db.commit()
    db.close()

    import routes.task.task_routes as task_routes

    entered = threading.Event()
    release = threading.Event()
    received = []

    def blocked_cascade(task):
        received.append((task, threading.get_ident()))
        entered.set()
        release.wait(timeout=3)

    class Scheduler:
        def begin_task_deletion(self, _task_id): pass
        async def stop_task(self, _task_id, drain_timeout): return True
        def finish_task_deletion(self, _task_id): pass

    monkeypatch.setattr(task_routes, "SessionLocal", session_local)
    monkeypatch.setattr(task_routes, "ScheduledTask", ScheduledTask)
    monkeypatch.setattr(task_routes, "get_current_user", lambda _request: "alice")
    monkeypatch.setattr(task_routes, "_maybe_cascade_calendar_event", blocked_cascade)
    router = task_routes.setup_task_routes(Scheduler())
    delete_endpoint = next(
        route.endpoint for route in router.routes
        if getattr(route, "path", None) == "/api/tasks/{task_id}"
        and "DELETE" in getattr(route, "methods", set())
    )

    async def drive():
        safety_release = threading.Timer(2, release.set)
        safety_release.start()
        try:
            deletion = asyncio.create_task(delete_endpoint(SimpleNamespace(), "delete-calendar-task"))
            assert await asyncio.to_thread(entered.wait, 1), "calendar cascade did not start"

            # A tiny event-loop turn must complete while the synchronous
            # internal HTTP cascade is still blocked in its worker thread.
            loop_progress = []
            await asyncio.sleep(0)
            loop_progress.append(not release.is_set())
            assert loop_progress == [True]

            release.set()
            assert await deletion == {"ok": True}
        finally:
            release.set()
            safety_release.cancel()

    asyncio.run(drive())
    assert len(received) == 1
    dto, worker_thread = received[0]
    assert type(dto) is SimpleNamespace
    assert (dto.id, dto.task_type, dto.action, dto.owner, dto.name) == (
        "delete-calendar-task", "action", "cookbook_serve", "alice", "Serve model",
    )
    assert worker_thread != threading.get_ident()

    db = session_local()
    try:
        assert db.query(ScheduledTask).filter_by(id="delete-calendar-task").first() is None
    finally:
        db.close()

def test_timed_out_delete_keeps_dispatch_fence_until_cancelled_run_exits(tmp_path, monkeypatch):
    _setup_db(tmp_path, monkeypatch)
    from src.task_scheduler import TaskScheduler

    async def drive():
        scheduler = TaskScheduler.__new__(TaskScheduler)
        scheduler._executing = set()
        scheduler._executing_lock = asyncio.Lock()
        scheduler._task_handles = {}
        scheduler._execution_handles = {}
        started = asyncio.Event()
        release = asyncio.Event()

        async def ignores_first_cancel():
            started.set()
            try:
                await release.wait()
            except asyncio.CancelledError:
                await release.wait()

        handle = scheduler._track_task("slow-delete", ignores_first_cancel(), release_executing=False)
        await started.wait()
        scheduler.begin_task_deletion("slow-delete")
        try:
            await scheduler.stop_task("slow-delete", drain_timeout=0.01)
        except asyncio.TimeoutError:
            pass
        else:
            raise AssertionError("stubborn run should exceed the bounded drain")
        scheduler.finish_task_deletion("slow-delete")

        assert "slow-delete" in scheduler._deleting_tasks
        assert await scheduler.run_task_now("slow-delete", force=True) is False
        release.set()
        await handle
        await asyncio.sleep(0)
        assert "slow-delete" not in scheduler._deleting_tasks

    asyncio.run(drive())

def test_task_delete_owner_check_precedes_run_cancellation(tmp_path, monkeypatch):
    session_local, ScheduledTask, _ = _setup_db(tmp_path, monkeypatch)
    db = session_local()
    db.add(ScheduledTask(
        id="bob-task", owner="bob", name="Bob task", task_type="llm", status="active",
    ))
    db.commit()
    db.close()

    import routes.task.task_routes as task_routes
    from fastapi import HTTPException
    from src.task_scheduler import TaskScheduler

    async def drive():
        scheduler = TaskScheduler.__new__(TaskScheduler)
        scheduler._executing = set()
        scheduler._executing_lock = asyncio.Lock()
        scheduler._task_handles = {}
        scheduler._execution_handles = {}
        scheduler._run_semaphore = asyncio.Semaphore(1)
        scheduler._task_defer_counts = {}
        scheduler._task_needs_model_slot = lambda _task_id: False
        started = asyncio.Event()
        release = asyncio.Event()

        async def paused_run(_task_id, _run_id, **_kwargs):
            started.set()
            await release.wait()

        scheduler._execute_task_locked = paused_run
        assert await scheduler.run_task_now("bob-task") is True
        handle = scheduler._task_handles["bob-task"]
        await started.wait()

        monkeypatch.setattr(task_routes, "SessionLocal", session_local)
        monkeypatch.setattr(task_routes, "ScheduledTask", ScheduledTask)
        monkeypatch.setattr(task_routes, "get_current_user", lambda _request: "alice")
        router = task_routes.setup_task_routes(scheduler)
        delete_endpoint = next(
            route.endpoint for route in router.routes
            if getattr(route, "path", None) == "/api/tasks/{task_id}"
            and "DELETE" in getattr(route, "methods", set())
        )
        try:
            await delete_endpoint(SimpleNamespace(), "bob-task")
        except HTTPException as exc:
            assert exc.status_code == 403
        else:
            raise AssertionError("another owner's task must not be deleted")
        assert not handle.done()
        assert "bob-task" not in getattr(scheduler, "_deleting_tasks", set())

        release.set()
        await handle
        db = session_local()
        try:
            assert db.query(ScheduledTask).filter_by(id="bob-task").first() is not None
        finally:
            db.close()

    asyncio.run(drive())

def test_overlapping_deletes_keep_fence_until_last_request_and_run_finish(tmp_path, monkeypatch):
    _setup_db(tmp_path, monkeypatch)
    from src.task_scheduler import TaskScheduler

    async def drive():
        scheduler = TaskScheduler.__new__(TaskScheduler)
        scheduler._task_handles = {}
        scheduler._execution_handles = {}
        started = asyncio.Event()
        release = asyncio.Event()

        async def paused_run():
            started.set()
            await release.wait()

        handle = scheduler._track_task("overlap-delete", paused_run(), release_executing=False)
        await started.wait()
        scheduler.begin_task_deletion("overlap-delete")  # first DELETE
        scheduler.begin_task_deletion("overlap-delete")  # overlapping retry

        scheduler.finish_task_deletion("overlap-delete")
        handle.cancel()
        try:
            await handle
        except asyncio.CancelledError:
            pass
        await asyncio.sleep(0)  # run the handle's cleanup callback

        assert "overlap-delete" in scheduler._deleting_tasks
        assert scheduler._task_deletion_refs["overlap-delete"] == 1
        scheduler.finish_task_deletion("overlap-delete")
        assert "overlap-delete" not in scheduler._deleting_tasks

    asyncio.run(drive())
