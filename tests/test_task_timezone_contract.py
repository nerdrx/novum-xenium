"""Fake-database coverage for linked-task wall-clock timezone semantics."""
import asyncio
import json
from datetime import datetime
from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker

from tests.helpers.import_state import clear_module, preserve_import_state


@pytest.fixture
def task_db(tmp_path, monkeypatch):
    with preserve_import_state("core.database", "routes.task.task_routes", "src.tools.system"):
        for name in ("core.database", "routes.task.task_routes", "src.tools.system"):
            clear_module(name)
        import core.database as database

        engine = create_engine(f"sqlite:///{tmp_path / 'task-timezones.db'}")
        database.Base.metadata.create_all(engine, tables=[
            database.Session.__table__,
            database.CrewMember.__table__,
            database.ScheduledTask.__table__,
            database.TaskRun.__table__,
        ])
        factory = sessionmaker(bind=engine, autocommit=False, autoflush=False)
        monkeypatch.setattr(database, "SessionLocal", factory)
        yield database, factory, engine
        engine.dispose()


def _crew(database, crew_id, timezone_name):
    return database.CrewMember(id=crew_id, owner="alice", name=crew_id, timezone=timezone_name)


def _task(database, task_id, crew_id=None, *, schedule="daily", time="09:00", status="active"):
    return database.ScheduledTask(
        id=task_id, owner="alice", name=task_id, task_type="llm", prompt="test",
        schedule=schedule, scheduled_time=time, trigger_type="schedule", status=status,
        crew_member_id=crew_id,
    )


def test_timezone_resolver_validates_and_batches_one_query(task_db):
    database, factory, engine = task_db
    from src.task_scheduler import _resolve_task_timezone, _resolve_task_timezones

    with factory() as db:
        db.add_all([
            _crew(database, "crew-berlin", "Europe/Berlin"),
            _crew(database, "crew-invalid", "Mars/Phobos"),
            _task(database, "linked", "crew-berlin"),
            _task(database, "invalid", "crew-invalid"),
            _task(database, "orphan", "missing-crew"),
            _task(database, "legacy"),
        ])
        db.commit()
        tasks = db.query(database.ScheduledTask).order_by(database.ScheduledTask.id).all()
        crew_selects = []

        def count_crew_select(_conn, _cursor, statement, _params, _context, _many):
            if "from crew_members" in statement.lower():
                crew_selects.append(statement)

        event.listen(engine, "before_cursor_execute", count_crew_select)
        try:
            timezones = _resolve_task_timezones(db, tasks)
            assert len(crew_selects) == 1
        finally:
            event.remove(engine, "before_cursor_execute", count_crew_select)

        by_id = {task.id: task for task in tasks}
        assert timezones == {"crew-berlin": "Europe/Berlin"}
        assert _resolve_task_timezone(db, by_id["linked"]) == "Europe/Berlin"
        assert _resolve_task_timezone(db, by_id["invalid"]) is None
        assert _resolve_task_timezone(db, by_id["orphan"]) is None
        assert _resolve_task_timezone(db, by_id["legacy"]) is None


def test_task_list_serializes_schedule_timezone_with_batched_lookup(task_db, monkeypatch):
    database, factory, engine = task_db
    with factory() as db:
        db.add_all([
            _crew(database, "crew-berlin", "Europe/Berlin"),
            _crew(database, "crew-invalid", "invalid/zone"),
            *[_task(database, f"linked-{i}", "crew-berlin") for i in range(20)],
            _task(database, "invalid", "crew-invalid"),
            _task(database, "legacy"),
        ])
        db.commit()

    import routes.task.task_routes as task_routes

    monkeypatch.setattr(task_routes, "SessionLocal", factory)
    monkeypatch.setattr(task_routes, "get_current_user", lambda _request: "alice")

    class Scheduler:
        async def ensure_defaults(self, _owner):
            return None

    router = task_routes.setup_task_routes(Scheduler())
    endpoint = next(route.endpoint for route in router.routes if getattr(route, "path", None) == "/api/tasks")
    crew_selects = []

    def count_crew_select(_conn, _cursor, statement, _params, _context, _many):
        if "from crew_members" in statement.lower():
            crew_selects.append(statement)

    event.listen(engine, "before_cursor_execute", count_crew_select)
    try:
        response = asyncio.run(endpoint(SimpleNamespace()))
    finally:
        event.remove(engine, "before_cursor_execute", count_crew_select)

    assert len(crew_selects) == 1
    mapped = {task["id"]: task for task in response["tasks"]}
    assert mapped["linked-0"]["schedule_timezone"] == "Europe/Berlin"
    assert mapped["invalid"]["schedule_timezone"] is None
    assert mapped["legacy"]["schedule_timezone"] is None


def test_task_route_update_and_resume_use_linked_timezone(task_db, monkeypatch):
    database, factory, _engine = task_db
    with factory() as db:
        db.add(_crew(database, "crew-berlin", "Europe/Berlin"))
        db.add(_task(database, "linked", "crew-berlin", status="active"))
        db.add(_task(database, "legacy", status="active"))
        db.commit()

    import routes.task.task_routes as task_routes

    monkeypatch.setattr(task_routes, "SessionLocal", factory)
    monkeypatch.setattr(task_routes, "get_current_user", lambda _request: "alice")
    captured = []

    def next_run(*_args, **kwargs):
        captured.append(kwargs.get("tz_name"))
        return datetime(2026, 10, 4, 7, 30)

    monkeypatch.setattr(task_routes, "compute_next_run", next_run)
    router = task_routes.setup_task_routes(SimpleNamespace())
    update = next(route.endpoint for route in router.routes
                  if getattr(route, "path", None) == "/api/tasks/{task_id}" and "PUT" in route.methods)
    resume = next(route.endpoint for route in router.routes
                  if getattr(route, "path", None) == "/api/tasks/{task_id}/resume")

    updated = asyncio.run(update(SimpleNamespace(), "linked", task_routes.TaskUpdate(scheduled_time="09:30")))
    assert updated["schedule_timezone"] == "Europe/Berlin"
    legacy = asyncio.run(update(SimpleNamespace(), "legacy", task_routes.TaskUpdate(scheduled_time="09:30")))
    assert legacy["schedule_timezone"] is None
    with factory() as db:
        db.get(database.ScheduledTask, "linked").status = "paused"
        db.commit()
    asyncio.run(resume(SimpleNamespace(), "linked"))
    assert captured == ["Europe/Berlin", None, "Europe/Berlin"]


@pytest.mark.asyncio
async def test_manage_tasks_linked_edit_resume_and_zone_reporting(task_db, monkeypatch):
    database, factory, engine = task_db
    with factory() as db:
        db.add(_crew(database, "crew-berlin", "Europe/Berlin"))
        db.add(_crew(database, "crew-invalid", "Mars/Phobos"))
        db.add(_task(database, "linked", "crew-berlin", status="active"))
        db.add(_task(database, "invalid-linked", "crew-invalid", status="active"))
        db.commit()

    monkeypatch.setattr(database, "SessionLocal", factory)
    monkeypatch.setattr("src.task_scheduler._utcnow", lambda: datetime(2026, 10, 4, 0, 0))
    from src.tools.system import do_manage_tasks

    edited = await do_manage_tasks(json.dumps({
        "action": "edit", "task_id": "linked", "scheduled_time": "09:30",
    }), owner="alice")
    assert edited["exit_code"] == 0
    with factory() as db:
        assert db.get(database.ScheduledTask, "linked").next_run == datetime(2026, 10, 4, 7, 30)
        db.get(database.ScheduledTask, "linked").status = "paused"
        db.commit()

    resumed = await do_manage_tasks(json.dumps({"action": "resume", "task_id": "linked"}), owner="alice")
    assert resumed["exit_code"] == 0
    with factory() as db:
        assert db.get(database.ScheduledTask, "linked").next_run == datetime(2026, 10, 4, 7, 30)

    crew_selects = []

    def count_crew_select(_conn, _cursor, statement, _params, _context, _many):
        if "from crew_members" in statement.lower():
            crew_selects.append(statement)

    event.listen(engine, "before_cursor_execute", count_crew_select)
    try:
        listed = await do_manage_tasks(json.dumps({"action": "list"}), owner="alice")
    finally:
        event.remove(engine, "before_cursor_execute", count_crew_select)
    assert len(crew_selects) == 1
    assert "timezone Europe/Berlin" in listed["response"]
    assert "invalid-linked (invalid-linked) — active, daily, 09:00, timezone UTC" in listed["response"]


def test_once_remains_absolute_and_cron_uses_resolved_zone():
    from src.task_scheduler import compute_next_run

    after = datetime(2026, 10, 4, 0, 0)
    one_off = datetime(2026, 10, 5, 6, 30)
    assert compute_next_run("once", "09:00", scheduled_date=one_off,
                            after=after, tz_name="Europe/Berlin") == one_off
    assert compute_next_run("cron", "09:00", after=after,
                            cron_expression="0 9 * * *", tz_name="Europe/Berlin") == datetime(2026, 10, 4, 7, 0)
    assert compute_next_run("cron", "09:00", after=after,
                            cron_expression="0 9 * * *", tz_name=None) == datetime(2026, 10, 4, 9, 0)


def test_manage_tasks_schema_documents_linked_timezone_exception():
    from src.tool_schemas import FUNCTION_TOOL_SCHEMAS

    schema = next(item for item in FUNCTION_TOOL_SCHEMAS
                  if item["function"]["name"] == "manage_tasks")
    props = schema["function"]["parameters"]["properties"]
    assert "linked to a Crew Member" in props["scheduled_time"]["description"]
    assert "wall-clock time" in props["scheduled_time"]["description"]
    assert "linked Crew Member's timezone" in props["cron_expression"]["description"]
