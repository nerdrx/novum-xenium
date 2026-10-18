"""Task list includes one latest-run summary without loading run histories."""

import asyncio
from datetime import datetime, timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker


def test_task_list_batches_latest_run_summaries_by_owned_task(tmp_path, monkeypatch):
    from tests.helpers.import_state import clear_module, preserve_import_state

    with preserve_import_state("core.database", "routes.task.task_routes"):
        clear_module("core.database")
        clear_module("routes.task.task_routes")
        import core.database as database
        import routes.task.task_routes as task_routes

        engine = create_engine(f"sqlite:///{tmp_path / 'task-list.db'}")
        database.Base.metadata.create_all(
            engine,
            tables=[
                database.Session.__table__,
                database.ScheduledTask.__table__,
                database.TaskRun.__table__,
            ],
        )
        sessions = sessionmaker(bind=engine, autoflush=False, autocommit=False)
        monkeypatch.setattr(database, "SessionLocal", sessions)
        monkeypatch.setattr(task_routes, "SessionLocal", sessions)

        db = sessions()
        now = datetime(2026, 1, 1)
        for task_id, owner, created_offset in (
            ("alice-a", "alice", 1),
            ("alice-b", "alice", 2),
            ("alice-empty", "alice", 3),
            ("bob", "bob", 4),
        ):
            db.add(database.ScheduledTask(
                id=task_id, owner=owner, name=task_id, task_type="llm",
                status="active", trigger_type="schedule",
                created_at=now + timedelta(seconds=created_offset),
            ))
        for task_id, run_id, offset, status, result, error in (
            ("alice-a", "a-old", 1, "error", "old result", "old error"),
            ("alice-a", "a-new", 2, "success", "new result", "ignored error"),
            ("alice-a", "a-history", 3, "error", "x" * 700, "fallback"),
            ("alice-b", "b-new", 2, "error", "", "e" * 700),
            ("bob", "bob-new", 2, "success", "foreign", ""),
        ):
            db.add(database.TaskRun(
                id=run_id, task_id=task_id, started_at=now + timedelta(seconds=offset),
                status=status, result=result, error=error,
            ))
        db.commit()
        db.close()

        scheduler = MagicMock()
        scheduler.ensure_defaults = AsyncMock()
        router = task_routes.setup_task_routes(scheduler)
        list_tasks = next(
            route.endpoint for route in router.routes
            if getattr(route, "path", None) == "/api/tasks"
            and "GET" in getattr(route, "methods", set())
        )
        statement_count = 0

        def count_statement(_connection, _cursor, _statement, _parameters, _context, _executemany):
            nonlocal statement_count
            statement_count += 1

        event.listen(engine, "before_cursor_execute", count_statement)
        try:
            result = asyncio.run(
                list_tasks(
                    SimpleNamespace(state=SimpleNamespace(current_user="alice")),
                    include_last_run=True,
                )
            )
        finally:
            event.remove(engine, "before_cursor_execute", count_statement)

        by_id = {task["id"]: task for task in result["tasks"]}
        assert [task["id"] for task in result["tasks"]] == [
            "alice-empty", "alice-b", "alice-a",
        ]
        assert set(by_id) == {"alice-a", "alice-b", "alice-empty"}
        assert by_id["alice-a"]["last_run_status"] == "error"
        assert by_id["alice-a"]["last_run_result"] == "x" * 500
        assert by_id["alice-b"]["last_run_status"] == "error"
        assert by_id["alice-b"]["last_run_result"] == "e" * 500
        assert "last_run_status" not in by_id["alice-empty"]
        # One task-list query plus one latest-run query, independent of task
        # count and history length.
        assert statement_count == 2
