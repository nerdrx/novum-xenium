import asyncio
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
import pytest

from tests.helpers.import_state import clear_module, preserve_import_state


@pytest.fixture
def real_database_imports():
    # Isolate from tests that mutate core.database's model classes in place.
    names = ("core.database", "src.database", "routes.task.task_routes")
    with preserve_import_state(*names):
        for name in names:
            clear_module(name)
        yield


def test_manual_run_executes_paused_task_without_resuming_schedule(tmp_path, monkeypatch, real_database_imports):
    import core.database as database
    import routes.task.task_routes as task_routes
    from src.task_scheduler import TaskScheduler

    engine = create_engine(f"sqlite:///{tmp_path / 'paused-task.db'}")
    database.Base.metadata.create_all(
        engine,
        tables=[database.Session.__table__, database.ScheduledTask.__table__, database.TaskRun.__table__],
    )
    sessions = sessionmaker(bind=engine, autocommit=False, autoflush=False)
    monkeypatch.setattr(database, "SessionLocal", sessions)
    monkeypatch.setattr(task_routes, "SessionLocal", sessions)
    monkeypatch.setattr(task_routes, "get_current_user", lambda _request: "alice")

    paused_next_run = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(days=2)
    db = sessions()
    db.add(database.ScheduledTask(
        id="paused-manual", owner="alice", name="Paused manual run",
        task_type="action", action="test_action", schedule="daily",
        scheduled_time="08:00", trigger_type="schedule", next_run=paused_next_run,
        status="paused",
    ))
    db.commit()
    db.close()

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
        invoked = []

        async def execute_action(_task, *, run_id):
            invoked.append(run_id)
            return "completed manually", True

        async def quiet(*_args, **_kwargs):
            return None

        scheduler._execute_action = execute_action
        scheduler._deliver_task_result = quiet
        scheduler._log_to_assistant = lambda *_args, **_kwargs: None
        import src.interactive_gate as interactive_gate
        monkeypatch.setattr(interactive_gate, "wait_for_interactive_quiet", quiet)
        monkeypatch.setattr(interactive_gate, "has_foreground_activity", lambda: False)

        router = task_routes.setup_task_routes(scheduler)
        run_endpoint = next(
            route.endpoint for route in router.routes
            if getattr(route, "path", None) == "/api/tasks/{task_id}/run"
        )
        response = await run_endpoint(SimpleNamespace(), "paused-manual")
        assert response["ok"] is True
        handle = scheduler._task_handles["paused-manual"]
        await handle

        assert len(invoked) == 1
        await scheduler._check_due_tasks()
        assert scheduler._task_handles == {}
        db = sessions()
        try:
            task = db.query(database.ScheduledTask).filter_by(id="paused-manual").one()
            run = db.query(database.TaskRun).filter_by(task_id="paused-manual").one()
            assert task.status == "paused"
            assert task.next_run == paused_next_run
            assert run.status == "success"
            assert run.result == "completed manually"
        finally:
            db.close()

    asyncio.run(drive())


def test_manual_run_rejects_completed_task_before_scheduler_dispatch(
    tmp_path, monkeypatch, real_database_imports,
):
    import core.database as database
    import routes.task.task_routes as task_routes
    from fastapi import HTTPException

    engine = create_engine(f"sqlite:///{tmp_path / 'completed-task.db'}")
    database.Base.metadata.create_all(
        engine,
        tables=[database.Session.__table__, database.ScheduledTask.__table__, database.TaskRun.__table__],
    )
    sessions = sessionmaker(bind=engine, autocommit=False, autoflush=False)
    monkeypatch.setattr(task_routes, "SessionLocal", sessions)
    monkeypatch.setattr(task_routes, "get_current_user", lambda _request: "alice")

    db = sessions()
    db.add(database.ScheduledTask(
        id="completed-manual", owner="alice", name="Completed task",
        task_type="action", action="test_action", schedule="once",
        trigger_type="schedule", status="completed",
    ))
    db.commit()
    db.close()

    scheduler = SimpleNamespace(run_task_now=AsyncMock())
    router = task_routes.setup_task_routes(scheduler)
    run_endpoint = next(
        route.endpoint for route in router.routes
        if getattr(route, "path", None) == "/api/tasks/{task_id}/run"
    )

    async def drive():
        with pytest.raises(HTTPException) as exc:
            await run_endpoint(SimpleNamespace(), "completed-manual")
        assert exc.value.status_code == 409
        assert "completed" in exc.value.detail
        scheduler.run_task_now.assert_not_awaited()

    asyncio.run(drive())
