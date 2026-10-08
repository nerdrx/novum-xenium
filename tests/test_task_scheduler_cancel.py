import asyncio
from types import SimpleNamespace

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
        trigger_type = Column(String, default="schedule")
        schedule = Column(String)
        next_run = Column(DateTime)
        last_run = Column(DateTime)
        status = Column(String, default="active")

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
        scheduler._concurrency_cap = 1
        scheduler._task_defer_counts = {}
        scheduler._execution_handles = {}
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
