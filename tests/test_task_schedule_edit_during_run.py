import asyncio
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker


def _isolated_task_db(tmp_path, monkeypatch):
    import core.database as database

    engine = create_engine(f"sqlite:///{tmp_path / 'task-edit.db'}")
    database.Base.metadata.create_all(
        engine,
        tables=[database.Session.__table__, database.ScheduledTask.__table__, database.TaskRun.__table__],
    )
    sessions = sessionmaker(bind=engine, autocommit=False, autoflush=False)
    monkeypatch.setattr(database, "SessionLocal", sessions)
    return sessions


def test_schedule_edit_during_run_survives_run_completion(tmp_path, monkeypatch):
    sessions = _isolated_task_db(tmp_path, monkeypatch)
    import core.database as database
    import routes.task.task_routes as task_routes
    from src.task_scheduler import TaskScheduler

    db = sessions()
    db.add(database.ScheduledTask(
        id="schedule-edit", owner="alice", name="Schedule edit",
        task_type="action", action="test_action", schedule="daily",
        scheduled_time="08:00", scheduled_day=0, trigger_type="schedule",
        next_run=datetime.now(timezone.utc).replace(tzinfo=None) + timedelta(hours=1), status="active",
    ))
    db.add(database.TaskRun(
        id="active-run", task_id="schedule-edit",
        started_at=datetime.now(timezone.utc).replace(tzinfo=None),
        status="running", result="Starting…",
    ))
    db.commit()
    db.close()

    async def drive():
        scheduler = TaskScheduler.__new__(TaskScheduler)
        scheduler._execution_handles = {}
        scheduler._executing = set()
        scheduler._task_handles = {}
        scheduler._task_defer_counts = {}
        scheduler._pending_notifications = []
        scheduler._last_run_model = None
        started = asyncio.Event()
        release = asyncio.Event()

        async def execute_action(_task, *, run_id):
            assert run_id == "active-run"
            started.set()
            await release.wait()
            return "done", True

        async def deliver_result(*_args, **_kwargs):
            return None

        scheduler._execute_action = execute_action
        scheduler._deliver_task_result = deliver_result
        scheduler._log_to_assistant = lambda *_args, **_kwargs: None
        runner = asyncio.create_task(scheduler._execute_task_locked(
            "schedule-edit", "active-run", gate_foreground=False,
        ))
        await started.wait()

        monkeypatch.setattr(task_routes, "SessionLocal", sessions)
        monkeypatch.setattr(task_routes, "get_current_user", lambda _request: "alice")
        router = task_routes.setup_task_routes(scheduler)
        update_endpoint = next(
            route.endpoint for route in router.routes
            if getattr(route, "path", None) == "/api/tasks/{task_id}"
            and "PUT" in getattr(route, "methods", set())
        )
        await update_endpoint(
            SimpleNamespace(), "schedule-edit",
            task_routes.TaskUpdate(schedule="weekly", scheduled_time="10:00", scheduled_day=3),
        )
        db = sessions()
        try:
            saved_next_run = db.query(database.ScheduledTask).filter_by(id="schedule-edit").one().next_run
        finally:
            db.close()

        release.set()
        await runner

        db = sessions()
        try:
            task = db.query(database.ScheduledTask).filter_by(id="schedule-edit").one()
            assert task.schedule == "weekly"
            assert task.scheduled_time == "10:00"
            assert task.next_run == saved_next_run
        finally:
            db.close()

    asyncio.run(drive())
