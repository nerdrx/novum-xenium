import asyncio
from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from tests.helpers.import_state import clear_module, preserve_import_state


@pytest.fixture
def real_database_imports():
    names = ("core.database", "src.database", "routes.task.task_routes")
    with preserve_import_state(*names):
        for name in names:
            clear_module(name)
        yield


def test_stop_cancels_captured_force_runs_but_not_replacement(
    tmp_path, monkeypatch, real_database_imports,
):
    import core.database as database
    import routes.task.task_routes as task_routes
    import src.interactive_gate as interactive_gate
    from src.task_scheduler import TaskScheduler

    engine = create_engine(f"sqlite:///{tmp_path}/force-stop.db")
    database.Base.metadata.create_all(
        engine,
        tables=[database.Session.__table__, database.ScheduledTask.__table__, database.TaskRun.__table__],
    )
    sessions = sessionmaker(bind=engine, autocommit=False, autoflush=False)
    monkeypatch.setattr(database, "SessionLocal", sessions)
    monkeypatch.setattr(task_routes, "SessionLocal", sessions)
    monkeypatch.setattr(task_routes, "get_current_user", lambda _request: "alice")

    db = sessions()
    db.add(database.ScheduledTask(
        id="force-stop", owner="alice", name="Force stop regression",
        task_type="action", action="test_action", trigger_type="schedule",
        schedule="daily", scheduled_time="08:00", status="active",
    ))
    db.commit()
    db.close()

    async def quiet(*_args, **_kwargs):
        return None

    monkeypatch.setattr(interactive_gate, "wait_for_interactive_quiet", quiet)
    monkeypatch.setattr(interactive_gate, "has_foreground_activity", lambda: False)

    async def drive():
        scheduler = TaskScheduler.__new__(TaskScheduler)
        scheduler._task_handles = {}
        scheduler._all_task_handles = {}
        scheduler._execution_handles = {}
        scheduler._executing = set()
        scheduler._executing_lock = asyncio.Lock()
        scheduler._run_semaphore = asyncio.Semaphore(1)
        scheduler._task_defer_counts = {}
        scheduler._pending_notifications = []
        scheduler._last_run_model = None
        scheduler._task_needs_model_slot = lambda _task_id: False
        started = []
        effects = []
        release_original_runs = asyncio.Event()

        async def execute_action(_task, *, run_id):
            started.append(run_id)
            if len(started) <= 2:
                await release_original_runs.wait()
            effects.append(run_id)
            return f"completed:{run_id}", True

        scheduler._execute_action = execute_action
        scheduler._deliver_task_result = quiet
        scheduler._log_to_assistant = lambda *_args, **_kwargs: None

        assert await scheduler.run_task_now("force-stop", force=True)
        first = scheduler._task_handles["force-stop"]
        assert await scheduler.run_task_now("force-stop", force=True)
        second = scheduler._task_handles["force-stop"]
        assert first is not second
        for _ in range(100):
            if len(started) == 2:
                break
            await asyncio.sleep(0)
        assert len(started) == 2

        router = task_routes.setup_task_routes(scheduler)
        stop_endpoint = next(
            route.endpoint for route in router.routes
            if getattr(route, "path", None) == "/api/tasks/{task_id}/stop"
        )
        # Hold the ownership lock so Stop pauses after its synchronous run-row
        # capture. A replacement force-run created during that wait is outside
        # the capture and must not be cancelled or marked aborted.
        await scheduler._executing_lock.acquire()
        stop_request = asyncio.create_task(stop_endpoint(SimpleNamespace(), "force-stop"))
        await asyncio.sleep(0)
        assert not stop_request.done()
        db = sessions()
        try:
            original_run_ids = {
                run.id for run in db.query(database.TaskRun).filter_by(task_id="force-stop").all()
            }
            assert len(original_run_ids) == 2
            assert {
                run.status for run in db.query(database.TaskRun).filter(
                    database.TaskRun.id.in_(original_run_ids)
                ).all()
            } == {"aborted"}
        finally:
            db.close()

        assert await scheduler.run_task_now("force-stop", force=True)
        replacement = scheduler._task_handles["force-stop"]
        await replacement
        replacement_run_id = effects[0]

        scheduler._executing_lock.release()
        response = await stop_request
        assert response == {"ok": True, "message": "Stop requested"}
        await asyncio.gather(first, second, return_exceptions=True)
        assert first.done()
        assert second.done()

        db = sessions()
        try:
            original_runs = db.query(database.TaskRun).filter(
                database.TaskRun.id.in_(original_run_ids)
            ).all()
            assert {run.status for run in original_runs} == {"aborted"}
        finally:
            db.close()
        assert effects == [replacement_run_id]

        db = sessions()
        try:
            runs = db.query(database.TaskRun).filter_by(task_id="force-stop").all()
            states = {run.id: run.status for run in runs}
            assert states[replacement_run_id] == "success"
            assert sum(status == "aborted" for status in states.values()) == 2
        finally:
            db.close()

    asyncio.run(drive())


@pytest.mark.parametrize("initial_run_count", [0, None])
def test_concurrent_force_successes_atomically_increment_run_count(
    tmp_path, monkeypatch, real_database_imports, initial_run_count,
):
    import core.database as database
    import src.interactive_gate as interactive_gate
    from src.task_scheduler import TaskScheduler

    engine = create_engine(f"sqlite:///{tmp_path}/force-run-count.db")
    database.Base.metadata.create_all(
        engine,
        tables=[database.Session.__table__, database.ScheduledTask.__table__, database.TaskRun.__table__],
    )
    sessions = sessionmaker(bind=engine, autocommit=False, autoflush=False)
    monkeypatch.setattr(database, "SessionLocal", sessions)
    db = sessions()
    db.add(database.ScheduledTask(
        id="force-count", owner="alice", name="Force count regression",
        task_type="action", action="test_action", trigger_type="schedule",
        schedule="daily", scheduled_time="08:00", status="active",
        run_count=initial_run_count,
    ))
    db.commit()
    if initial_run_count is None:
        db.query(database.ScheduledTask).filter_by(id="force-count").update(
            {database.ScheduledTask.run_count: None}, synchronize_session=False,
        )
        db.commit()
        assert db.query(database.ScheduledTask).filter_by(id="force-count").one().run_count is None
    db.close()

    async def quiet(*_args, **_kwargs):
        return None

    monkeypatch.setattr(interactive_gate, "wait_for_interactive_quiet", quiet)
    monkeypatch.setattr(interactive_gate, "has_foreground_activity", lambda: False)

    async def drive():
        scheduler = TaskScheduler.__new__(TaskScheduler)
        scheduler._task_handles = {}
        scheduler._all_task_handles = {}
        scheduler._execution_handles = {}
        scheduler._executing = set()
        scheduler._executing_lock = asyncio.Lock()
        scheduler._run_semaphore = asyncio.Semaphore(1)
        scheduler._task_defer_counts = {}
        scheduler._pending_notifications = []
        scheduler._last_run_model = None
        scheduler._task_needs_model_slot = lambda _task_id: False
        starts = []
        releases = {}

        async def execute_action(_task, *, run_id):
            event = asyncio.Event()
            releases[run_id] = event
            starts.append(run_id)
            await event.wait()
            return f"done:{run_id}", True

        scheduler._execute_action = execute_action
        scheduler._deliver_task_result = quiet
        scheduler._log_to_assistant = lambda *_args, **_kwargs: None

        assert await scheduler.run_task_now("force-count", force=True)
        first = scheduler._task_handles["force-count"]
        assert await scheduler.run_task_now("force-count", force=True)
        second = scheduler._task_handles["force-count"]
        for _ in range(100):
            if len(starts) == 2:
                break
            await asyncio.sleep(0)
        assert len(starts) == 2

        releases[starts[0]].set()
        await first
        releases[starts[1]].set()
        await second

    asyncio.run(drive())
    db = sessions()
    try:
        task = db.query(database.ScheduledTask).filter_by(id="force-count").one()
        runs = db.query(database.TaskRun).filter_by(task_id="force-count").all()
        assert len(runs) == 2
        assert all(run.status == "success" for run in runs)
        assert task.run_count == 2
        assert task.last_run is not None
        assert task.schedule == "daily"
        assert task.scheduled_time == "08:00"
        assert task.next_run is not None
    finally:
        db.close()


def test_foreground_stop_cancels_normal_and_force_runs_then_allows_replacement(
    tmp_path, monkeypatch, real_database_imports,
):
    import core.database as database
    import src.interactive_gate as interactive_gate
    from src.task_scheduler import TaskScheduler

    engine = create_engine(f"sqlite:///{tmp_path}/foreground-stop.db")
    database.Base.metadata.create_all(
        engine,
        tables=[database.Session.__table__, database.ScheduledTask.__table__, database.TaskRun.__table__],
    )
    sessions = sessionmaker(bind=engine, autocommit=False, autoflush=False)
    monkeypatch.setattr(database, "SessionLocal", sessions)
    db = sessions()
    db.add(database.ScheduledTask(
        id="foreground-stop", owner="alice", name="Foreground stop regression",
        task_type="action", action="test_action", trigger_type="schedule",
        schedule="daily", scheduled_time="08:00", status="active", run_count=0,
    ))
    db.commit()
    db.close()

    async def quiet(*_args, **_kwargs):
        return None

    monkeypatch.setattr(interactive_gate, "wait_for_interactive_quiet", quiet)
    monkeypatch.setattr(interactive_gate, "has_foreground_activity", lambda: False)

    async def drive():
        scheduler = TaskScheduler.__new__(TaskScheduler)
        scheduler._task_handles = {}
        scheduler._all_task_handles = {}
        scheduler._execution_handles = {}
        scheduler._executing = set()
        scheduler._executing_lock = asyncio.Lock()
        scheduler._run_semaphore = asyncio.Semaphore(1)
        scheduler._task_defer_counts = {}
        scheduler._pending_notifications = []
        scheduler._last_run_model = None
        scheduler._task_needs_model_slot = lambda _task_id: False
        started = []
        releases = {}
        effects = []

        async def execute_action(_task, *, run_id):
            event = asyncio.Event()
            releases[run_id] = event
            started.append(run_id)
            await event.wait()
            effects.append(run_id)
            return f"done:{run_id}", True

        scheduler._execute_action = execute_action
        scheduler._deliver_task_result = quiet
        scheduler._log_to_assistant = lambda *_args, **_kwargs: None

        assert await scheduler.run_task_now("foreground-stop")
        normal = scheduler._task_handles["foreground-stop"]
        assert await scheduler.run_task_now("foreground-stop", force=True)
        forced = scheduler._task_handles["foreground-stop"]
        for _ in range(100):
            if len(started) == 2:
                break
            await asyncio.sleep(0)
        assert len(started) == 2

        # Foreground interaction cancels ordinary and force-parallel handles.
        assert await scheduler.stop_background_tasks_for_foreground(
            reason="controlled interactive API request",
        ) == 1
        await asyncio.gather(normal, forced, return_exceptions=True)
        assert normal.done() and forced.done()
        assert effects == []

        db = sessions()
        try:
            original_runs = db.query(database.TaskRun).filter_by(task_id="foreground-stop").all()
            original_ids = {run.id for run in original_runs}
            assert len(original_ids) == 2
            assert {run.status for run in original_runs} == {"aborted"}
        finally:
            db.close()

        # Once the canceled run releases its reservation, a new normal run
        # owns it until completion; old callbacks cannot clear that ownership.
        assert await scheduler.run_task_now("foreground-stop")
        replacement = scheduler._task_handles["foreground-stop"]
        for _ in range(100):
            if len(started) == 3:
                break
            await asyncio.sleep(0)
        assert len(started) == 3
        assert scheduler._execution_handles["foreground-stop"] is replacement
        assert scheduler._executing == {"foreground-stop"}
        releases[started[2]].set()
        await replacement

        db = sessions()
        try:
            task = db.query(database.ScheduledTask).filter_by(id="foreground-stop").one()
            runs = db.query(database.TaskRun).filter_by(task_id="foreground-stop").all()
            states = {run.id: run.status for run in runs}
            replacement_run_id = started[2]
            assert states[replacement_run_id] == "success"
            assert all(states[run_id] == "aborted" for run_id in original_ids)
            assert task.run_count == 1
        finally:
            db.close()
