"""Default-task reconciliation stays responsive and serialized off-thread."""

import asyncio
import threading

import pytest
from sqlalchemy import event

import core.database as database
import src.task_scheduler as scheduler_module
from src.task_scheduler import HOUSEKEEPING_DEFAULTS, TaskScheduler
from tests.helpers.database import disposable_database


@pytest.fixture
def isolated_scheduler(tmp_path, monkeypatch):
    import routes.prefs_routes as prefs

    with disposable_database(tmp_path) as factory:
        monkeypatch.setattr(database, "SessionLocal", factory)
        monkeypatch.setattr(prefs, "_load_for_user", lambda _owner: {})
        monkeypatch.setattr(scheduler_module, "_default_authority_owner_exists", lambda _owner: False)
        yield factory, TaskScheduler(session_manager=None)


@pytest.mark.asyncio
async def test_default_reconcile_database_wait_does_not_block_event_loop(
    isolated_scheduler,
):
    factory, scheduler = isolated_scheduler
    engine = factory.kw["bind"]
    query_entered = threading.Event()
    release_query = threading.Event()
    release_timer = threading.Timer(0.5, release_query.set)

    def gate_first_task_query(_connection, _cursor, statement, _params, _context, _many):
        if (
            not query_entered.is_set()
            and statement.lstrip().lower().startswith("select")
            and "scheduled_tasks" in statement.lower()
        ):
            query_entered.set()
            release_query.wait(2)

    event.listen(engine, "before_cursor_execute", gate_first_task_query)
    release_timer.start()
    pulse = asyncio.Event()
    reconcile = asyncio.create_task(scheduler.ensure_defaults("alice"))
    asyncio.get_running_loop().call_soon(pulse.set)
    try:
        assert await asyncio.wait_for(asyncio.to_thread(query_entered.wait), 1)
        await asyncio.wait_for(pulse.wait(), 0.25)
        assert not release_query.is_set(), "heartbeat ran only after the DB gate released"
    finally:
        release_query.set()
        release_timer.cancel()
        await reconcile
        event.remove(engine, "before_cursor_execute", gate_first_task_query)


@pytest.mark.asyncio
async def test_cancel_waits_for_reconcile_worker_and_finishes_assistant_seed(
    isolated_scheduler,
):
    factory, scheduler = isolated_scheduler
    engine = factory.kw["bind"]
    query_entered = threading.Event()
    release_query = threading.Event()

    def gate_first_task_query(_connection, _cursor, statement, _params, _context, _many):
        if (
            not query_entered.is_set()
            and statement.lstrip().lower().startswith("select")
            and "scheduled_tasks" in statement.lower()
        ):
            query_entered.set()
            release_query.wait(2)

    event.listen(engine, "before_cursor_execute", gate_first_task_query)
    reconcile = asyncio.create_task(scheduler.ensure_defaults("alice"))
    try:
        assert await asyncio.wait_for(asyncio.to_thread(query_entered.wait), 1)
        reconcile.cancel()
        await asyncio.sleep(0.02)
        assert not reconcile.done(), "cancel returned while its database worker was still gated"
        release_query.set()
        with pytest.raises(asyncio.CancelledError):
            await reconcile
    finally:
        release_query.set()
        if not reconcile.done():
            await reconcile
        event.remove(engine, "before_cursor_execute", gate_first_task_query)

    with factory() as db:
        task_count = db.query(database.ScheduledTask).filter(
            database.ScheduledTask.owner == "alice",
            database.ScheduledTask.task_type == "action",
        ).count()
        assistant_count = db.query(database.CrewMember).filter(
            database.CrewMember.owner == "alice",
            database.CrewMember.is_default_assistant == True,  # noqa: E712
        ).count()
    assert task_count == len(HOUSEKEEPING_DEFAULTS)
    assert assistant_count == 1


@pytest.mark.asyncio
async def test_concurrent_default_reconcile_keeps_single_seed_per_action(
    isolated_scheduler,
):
    factory, scheduler = isolated_scheduler
    engine = factory.kw["bind"]
    first_query_entered = threading.Event()
    second_query_entered = threading.Event()
    assistant_query_entered = threading.Event()
    release_first_query = threading.Event()
    gate_count_lock = threading.Lock()
    query_count = 0
    release_timer = threading.Timer(1, release_first_query.set)

    def gate_concurrent_queries(_connection, _cursor, statement, _params, _context, _many):
        nonlocal query_count
        normalized = statement.lstrip().lower()
        if not normalized.startswith("select"):
            return
        if "crew_members" in normalized:
            assistant_query_entered.set()
            return
        if "scheduled_tasks" not in normalized:
            return
        with gate_count_lock:
            query_count += 1
            current = query_count
        if current == 1:
            first_query_entered.set()
            release_first_query.wait(2)
        elif current == 2:
            second_query_entered.set()

    event.listen(engine, "before_cursor_execute", gate_concurrent_queries)
    release_timer.start()
    first = asyncio.create_task(scheduler.ensure_defaults("alice"))
    try:
        assert await asyncio.wait_for(asyncio.to_thread(first_query_entered.wait), 1)
        second = asyncio.create_task(scheduler.ensure_defaults("alice"))
        direct_assistant = asyncio.create_task(scheduler.ensure_assistant_defaults("alice"))
        await asyncio.sleep(0.05)
        assert not second_query_entered.is_set()
        assert not assistant_query_entered.is_set()
        release_first_query.set()
        await asyncio.gather(first, second, direct_assistant)
        assert second_query_entered.is_set()
        assert assistant_query_entered.is_set()
    finally:
        release_first_query.set()
        release_timer.cancel()
        event.remove(engine, "before_cursor_execute", gate_concurrent_queries)

    with factory() as db:
        counts = {
            action: count
            for action, count in db.query(
                database.ScheduledTask.action,
                database.func.count(database.ScheduledTask.id),
            ).filter(
                database.ScheduledTask.owner == "alice",
                database.ScheduledTask.task_type == "action",
            ).group_by(database.ScheduledTask.action).all()
        }
        assistant_count = db.query(database.CrewMember).filter(
            database.CrewMember.owner == "alice",
            database.CrewMember.is_default_assistant == True,  # noqa: E712
        ).count()
    assert counts == {action: 1 for action in HOUSEKEEPING_DEFAULTS}
    assert assistant_count == 1
