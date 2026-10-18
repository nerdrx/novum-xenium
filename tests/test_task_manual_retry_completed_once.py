"""Completed one-shot failures are retryable only through a bounded manual run."""
import asyncio
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock

from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy import event
from sqlalchemy.orm import sessionmaker
import pytest

from tests.helpers.import_state import clear_module, preserve_import_state


@pytest.fixture
def retry_db(tmp_path, monkeypatch):
    names = ("core.database", "src.database", "routes.task.task_routes")
    with preserve_import_state(*names):
        for name in names:
            clear_module(name)
        import core.database as database
        import routes.task.task_routes as task_routes

        engine = create_engine(f"sqlite:///{tmp_path / 'completed-once-retry.db'}")
        database.Base.metadata.create_all(
            engine,
            tables=[database.Session.__table__, database.ScheduledTask.__table__, database.TaskRun.__table__],
        )
        sessions = sessionmaker(bind=engine, autocommit=False, autoflush=False)
        monkeypatch.setattr(database, "SessionLocal", sessions)
        monkeypatch.setattr(task_routes, "SessionLocal", sessions)
        monkeypatch.setattr(task_routes, "get_current_user", lambda _request: "alice")
        yield database, task_routes, sessions


def _task(database, **overrides):
    values = {
        "id": "once-task", "owner": "alice", "name": "One-shot",
        "task_type": "action", "action": "test_action", "schedule": "once",
        "trigger_type": "schedule", "scheduled_date": datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(days=1),
        "next_run": None, "status": "completed", "notifications_enabled": False,
    }
    values.update(overrides)
    return database.ScheduledTask(**values)


def _endpoint(router, path):
    return next(route.endpoint for route in router.routes if getattr(route, "path", None) == path)


def test_completed_once_retry_eligibility_is_latest_run_and_schedule_scoped(retry_db):
    database, task_routes, sessions = retry_db
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    db = sessions()
    db.add(_task(database))
    db.add(database.TaskRun(id="failed", task_id="once-task", started_at=now - timedelta(minutes=2), status="error"))
    db.commit()
    db.close()

    scheduler = SimpleNamespace(run_task_now=AsyncMock(return_value=True))
    router = task_routes.setup_task_routes(scheduler)
    run_task = _endpoint(router, "/api/tasks/{task_id}/run")

    async def drive():
        response = await run_task(SimpleNamespace(), "once-task")
        assert response["ok"]
        scheduler.run_task_now.assert_awaited_once_with(
            "once-task", completed_once_retry_run_id="failed",
        )

    asyncio.run(drive())

    # A successful latest attempt supersedes the earlier error. The API also
    # rejects force retries and schedule/trigger variants without dispatch.
    db = sessions()
    db.add(database.TaskRun(id="success", task_id="once-task", started_at=now, status="success"))
    db.commit()
    db.close()
    scheduler.run_task_now.reset_mock()

    async def reject():
        with pytest.raises(HTTPException) as exc:
            await run_task(SimpleNamespace(), "once-task")
        assert exc.value.status_code == 409
        with pytest.raises(HTTPException):
            await run_task(SimpleNamespace(), "once-task", force=True)
        scheduler.run_task_now.assert_not_awaited()

    asyncio.run(reject())

    for overrides in (
        {"schedule": "daily"},
        {"trigger_type": "event"},
        {"next_run": now},
    ):
        db = sessions()
        task = db.query(database.ScheduledTask).filter_by(id="once-task").one()
        for key, value in overrides.items():
            setattr(task, key, value)
        db.query(database.TaskRun).filter_by(id="success").delete()
        db.commit()
        db.close()
        scheduler.run_task_now.reset_mock()
        with pytest.raises(HTTPException):
            asyncio.run(run_task(SimpleNamespace(), "once-task"))
        scheduler.run_task_now.assert_not_awaited()

    for latest_status in ("skipped", None):
        db = sessions()
        task = db.query(database.ScheduledTask).filter_by(id="once-task").one()
        task.schedule = "once"
        task.trigger_type = "schedule"
        task.next_run = None
        db.query(database.TaskRun).filter_by(task_id="once-task").delete()
        if latest_status:
            db.add(database.TaskRun(
                id=f"latest-{latest_status}", task_id="once-task", started_at=now,
                status=latest_status,
            ))
        db.commit()
        db.close()
        scheduler.run_task_now.reset_mock()
        with pytest.raises(HTTPException):
            asyncio.run(run_task(SimpleNamespace(), "once-task"))
        scheduler.run_task_now.assert_not_awaited()


def test_retry_failure_then_success_keeps_one_shot_completed_and_not_due(retry_db, monkeypatch):
    database, task_routes, sessions = retry_db
    from src.task_scheduler import TaskScheduler
    import src.interactive_gate as interactive_gate

    now = datetime.now(timezone.utc).replace(tzinfo=None)
    db = sessions()
    db.add(_task(database, status="active", next_run=now - timedelta(minutes=1)))
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
        attempts = iter([("first attempt failed", False), ("retry succeeded", True)])

        async def execute_action(_task, *, run_id):
            return next(attempts)

        async def quiet_result(*_args, **_kwargs):
            return None

        scheduler._execute_action = execute_action
        scheduler._deliver_task_result = quiet_result
        scheduler._log_to_assistant = lambda *_args, **_kwargs: None
        router = task_routes.setup_task_routes(scheduler)
        run_task = _endpoint(router, "/api/tasks/{task_id}/run")

        await run_task(SimpleNamespace(), "once-task")
        await scheduler._task_handles["once-task"]
        db = sessions()
        failed = db.query(database.TaskRun).filter_by(task_id="once-task").one()
        assert failed.status == "error"
        task = db.query(database.ScheduledTask).filter_by(id="once-task").one()
        assert task.status == "completed"
        assert task.next_run is None
        db.close()

        # Retry admission reuses the latest failed run identity.
        await run_task(SimpleNamespace(), "once-task")
        await scheduler._task_handles["once-task"]
        db = sessions()
        task = db.query(database.ScheduledTask).filter_by(id="once-task").one()
        runs = db.query(database.TaskRun).filter_by(task_id="once-task").order_by(database.TaskRun.started_at).all()
        assert [run.status for run in runs] == ["error", "success"]
        assert task.status == "completed"
        assert task.next_run is None
        await scheduler._check_due_tasks()
        assert scheduler._task_handles == {}
        db.close()

    asyncio.run(drive())


def test_retry_eligibility_serializes_once_and_only_on_latest_activity_run(retry_db):
    database, task_routes, sessions = retry_db
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    db = sessions()
    db.add(_task(database))
    db.add_all([
        database.TaskRun(
            id="older-error", task_id="once-task", started_at=now - timedelta(minutes=2), status="error",
        ),
        database.TaskRun(
            id="latest-error", task_id="once-task", started_at=now - timedelta(minutes=1), status="aborted",
        ),
    ])
    db.commit()
    db.close()

    scheduler = SimpleNamespace(ensure_defaults=AsyncMock())
    router = task_routes.setup_task_routes(scheduler)
    get_task = _endpoint(router, "/api/tasks/{task_id}")
    list_tasks = _endpoint(router, "/api/tasks")
    recent_runs = _endpoint(router, "/api/tasks/runs/recent")

    async def drive():
        single = await get_task(SimpleNamespace(), "once-task")
        assert single["can_run_again"] is True
        assert single["can_force_run"] is False
        listing = await list_tasks(SimpleNamespace(), include_last_run=True)
        assert listing["tasks"][0]["can_run_again"] is True
        assert listing["tasks"][0]["can_force_run"] is False
        assert listing["tasks"][0]["last_run_status"] == "aborted"
        statements = []
        bind = sessions.kw["bind"]
        listener = lambda _conn, _cursor, statement, _params, _context, _many: statements.append(statement)
        event.listen(bind, "before_cursor_execute", listener)
        try:
            lean_listing = await list_tasks(SimpleNamespace(), include_last_run=False)
        finally:
            event.remove(bind, "before_cursor_execute", listener)
        assert lean_listing["tasks"][0]["can_run_again"] is True
        latest_run_sql = next(sql.lower() for sql in statements if "task_runs" in sql.lower())
        assert "task_runs.result" not in latest_run_sql
        assert "task_runs.error" not in latest_run_sql
        activity = await recent_runs(SimpleNamespace())
        eligible = {run["id"]: run["can_run_again"] for run in activity["runs"]}
        assert eligible["latest-error"] is True
        assert eligible["older-error"] is False
        assert all(not run["can_force_run"] for run in activity["runs"])

        db = sessions()
        task = db.query(database.ScheduledTask).filter_by(id="once-task").one()
        task.status = "active"
        db.commit()
        db.close()
        active = await get_task(SimpleNamespace(), "once-task")
        assert active["can_run_again"] is True
        assert active["can_force_run"] is True
        active_activity = await recent_runs(SimpleNamespace())
        assert all(run["can_run_again"] and run["can_force_run"] for run in active_activity["runs"])

    asyncio.run(drive())


@pytest.mark.parametrize("outcome", ["exception", "skip", "deferred"])
def test_retry_non_success_outcomes_do_not_rearm_completed_once(retry_db, monkeypatch, outcome):
    database, _task_routes, sessions = retry_db
    from src.task_scheduler import TaskScheduler
    from src.builtin_actions import TaskDeferred, TaskNoop

    now = datetime.now(timezone.utc).replace(tzinfo=None)
    db = sessions()
    db.add(_task(database))
    db.add(database.TaskRun(
        id="prior-failure", task_id="once-task", started_at=now - timedelta(minutes=1), status="error",
    ))
    db.commit()
    db.close()

    async def quiet(*_args, **_kwargs):
        return None

    import src.interactive_gate as interactive_gate
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

        async def execute_action(_task, *, run_id):
            if outcome == "exception":
                raise RuntimeError("synthetic retry failure")
            if outcome == "skip":
                raise TaskNoop("nothing to do")
            raise TaskDeferred("wait for quiet", delay_seconds=60)

        scheduler._execute_action = execute_action
        scheduler._deliver_task_result = quiet
        scheduler._log_to_assistant = lambda *_args, **_kwargs: None
        assert await scheduler.run_task_now(
            "once-task", completed_once_retry_run_id="prior-failure",
        )
        await scheduler._task_handles["once-task"]

        db = sessions()
        task = db.query(database.ScheduledTask).filter_by(id="once-task").one()
        runs = db.query(database.TaskRun).filter_by(task_id="once-task").all()
        assert task.status == "completed"
        assert task.next_run is None
        if outcome == "exception":
            assert task.last_run is not None
        if outcome == "deferred":
            assert len(runs) == 1  # deferred attempt is removed, prior error remains retryable
        else:
            assert any(run.status == ("error" if outcome == "exception" else "skipped") for run in runs)
        db.close()

    asyncio.run(drive())


def test_cancelled_retry_keeps_completed_schedule_and_does_not_defer(retry_db):
    database, _task_routes, sessions = retry_db
    from src.task_scheduler import TaskScheduler

    now = datetime.now(timezone.utc).replace(tzinfo=None)
    db = sessions()
    db.add(_task(database))
    db.add(database.TaskRun(
        id="prior-failure", task_id="once-task", started_at=now - timedelta(minutes=1), status="error",
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
        scheduler._run_semaphore = asyncio.Semaphore(0)
        scheduler._task_defer_counts = {}
        scheduler._pending_notifications = []
        scheduler._task_needs_model_slot = lambda _task_id: True
        assert await scheduler.run_task_now(
            "once-task", completed_once_retry_run_id="prior-failure",
        )
        handle = scheduler._task_handles["once-task"]
        for _ in range(20):
            await asyncio.sleep(0)
            db = sessions()
            queued = db.query(database.TaskRun).filter_by(task_id="once-task", status="queued").count()
            db.close()
            if queued:
                break
        handle.cancel()
        with pytest.raises(asyncio.CancelledError):
            await handle

        db = sessions()
        task = db.query(database.ScheduledTask).filter_by(id="once-task").one()
        latest = db.query(database.TaskRun).filter_by(task_id="once-task").order_by(
            database.TaskRun.started_at.desc(), database.TaskRun.id.desc(),
        ).first()
        assert task.status == "completed"
        assert task.next_run is None
        assert latest.status == "aborted"
        db.close()

    asyncio.run(drive())


def test_foreground_cancelled_retry_preserves_completed_status_and_null_next_run(retry_db):
    database, _task_routes, sessions = retry_db
    from src.task_scheduler import TaskScheduler

    db = sessions()
    db.add(_task(database))
    db.add(database.TaskRun(
        id="running-retry", task_id="once-task", started_at=datetime.now(timezone.utc).replace(tzinfo=None),
        status="running",
    ))
    db.commit()
    db.close()

    scheduler = TaskScheduler.__new__(TaskScheduler)
    scheduler._finish_cancelled_run(
        "once-task", "running-retry", "Paused because Novum Xenium became active",
        foreground=True, completed_once_retry=True,
    )

    db = sessions()
    task = db.query(database.ScheduledTask).filter_by(id="once-task").one()
    run = db.query(database.TaskRun).filter_by(id="running-retry").one()
    assert task.status == "completed"
    assert task.next_run is None
    assert run.status == "aborted"
    db.close()


def test_retry_rechecks_state_after_idle_wait_and_preserves_concurrent_edit(retry_db, monkeypatch):
    database, _task_routes, sessions = retry_db
    from src.task_scheduler import TaskScheduler
    import src.interactive_gate as interactive_gate

    now = datetime.now(timezone.utc).replace(tzinfo=None)
    db = sessions()
    db.add(_task(database))
    db.add(database.TaskRun(
        id="prior-failure", task_id="once-task", started_at=now - timedelta(minutes=1), status="error",
    ))
    db.commit()
    db.close()

    async def drive():
        waiting = asyncio.Event()
        release = asyncio.Event()

        async def quiet(*_args, **_kwargs):
            waiting.set()
            await release.wait()

        monkeypatch.setattr(interactive_gate, "wait_for_interactive_quiet", quiet)
        scheduler = TaskScheduler.__new__(TaskScheduler)
        scheduler._task_handles = {}
        scheduler._all_task_handles = {}
        scheduler._execution_handles = {}
        scheduler._executing = set()
        scheduler._executing_lock = asyncio.Lock()
        scheduler._run_semaphore = asyncio.Semaphore(1)
        scheduler._task_defer_counts = {}
        scheduler._pending_notifications = []
        scheduler._task_needs_model_slot = lambda _task_id: False
        invoked = []

        async def execute_action(_task, *, run_id):
            invoked.append(run_id)
            return "should not run", True

        scheduler._execute_action = execute_action
        scheduler._deliver_task_result = AsyncMock()
        scheduler._log_to_assistant = lambda *_args, **_kwargs: None
        assert await scheduler.run_task_now(
            "once-task", completed_once_retry_run_id="prior-failure",
        )
        handle = scheduler._task_handles["once-task"]
        await waiting.wait()

        edited_next = now + timedelta(days=1)
        db = sessions()
        task = db.query(database.ScheduledTask).filter_by(id="once-task").one()
        task.status = "active"
        task.schedule = "daily"
        task.next_run = edited_next
        db.commit()
        db.close()

        release.set()
        await handle
        assert invoked == []
        db = sessions()
        task = db.query(database.ScheduledTask).filter_by(id="once-task").one()
        latest = db.query(database.TaskRun).filter_by(task_id="once-task").order_by(
            database.TaskRun.started_at.desc(), database.TaskRun.id.desc(),
        ).first()
        assert task.status == "active"
        assert task.schedule == "daily"
        assert task.next_run == edited_next
        assert latest.status == "skipped"
        db.close()

    asyncio.run(drive())


def test_retry_worker_rejects_stale_previous_run_identity(retry_db, monkeypatch):
    database, _task_routes, sessions = retry_db
    from src.task_scheduler import TaskScheduler
    import src.interactive_gate as interactive_gate

    now = datetime.now(timezone.utc).replace(tzinfo=None)
    db = sessions()
    db.add(_task(database))
    db.add_all([
        database.TaskRun(id="expected-error", task_id="once-task", started_at=now - timedelta(minutes=2), status="error"),
        database.TaskRun(id="newer-error", task_id="once-task", started_at=now - timedelta(minutes=1), status="error"),
    ])
    db.commit()
    db.close()

    async def quiet(*_args, **_kwargs):
        return None

    monkeypatch.setattr(interactive_gate, "wait_for_interactive_quiet", quiet)

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
        scheduler._task_needs_model_slot = lambda _task_id: False
        invoked = []

        async def execute_action(_task, *, run_id):
            invoked.append(run_id)
            return "stale retry ran", True

        scheduler._execute_action = execute_action
        assert await scheduler.run_task_now(
            "once-task", completed_once_retry_run_id="expected-error",
        )
        await scheduler._task_handles["once-task"]
        assert invoked == []
        db = sessions()
        task = db.query(database.ScheduledTask).filter_by(id="once-task").one()
        stale = db.query(database.TaskRun).filter_by(task_id="once-task", status="skipped").one()
        assert task.status == "completed"
        assert task.next_run is None
        assert "status=completed" in stale.error
        db.close()

    asyncio.run(drive())
