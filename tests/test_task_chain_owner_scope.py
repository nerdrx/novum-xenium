"""Task chaining must not cross owner boundaries."""

import tempfile
import uuid
import hashlib
import json
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine, event
from sqlalchemy.orm import Session as OrmSession, sessionmaker
from sqlalchemy.pool import NullPool

from tests.helpers.import_state import clear_fake_database_modules

clear_fake_database_modules()

import core.database as cdb
import routes.task_routes as task_routes
from core.database import ScheduledTask, TaskCreateIdempotency

_TMPDB = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_ENGINE = create_engine(
    f"sqlite:///{_TMPDB.name}",
    connect_args={"check_same_thread": False},
    poolclass=NullPool,
)
cdb.Base.metadata.create_all(_ENGINE)
_TS = sessionmaker(bind=_ENGINE, autoflush=False, autocommit=False)
task_routes.SessionLocal = _TS


def _req(user="alice", idempotency_key=None):
    headers = {"Idempotency-Key": idempotency_key} if idempotency_key else {}
    return SimpleNamespace(state=SimpleNamespace(current_user=user), headers=headers)


def _endpoint(method, path):
    task_routes.SessionLocal = _TS
    router = task_routes.setup_task_routes(MagicMock())
    for route in router.routes:
        if getattr(route, "path", None) == path and method in getattr(route, "methods", set()):
            return route.endpoint
    raise RuntimeError(f"{method} {path} not found")


def _seed_task(task_id, owner, *, then_task_id=None):
    db = _TS()
    try:
        task = ScheduledTask(
            id=task_id,
            owner=owner,
            name=task_id,
            prompt="do work",
            task_type="llm",
            trigger_type="webhook",
            status="active",
            output_target="session",
            then_task_id=then_task_id,
        )
        db.add(task)
        db.commit()
    finally:
        db.close()


@pytest.mark.asyncio
async def test_create_task_rejects_cross_owner_chain_target():
    _seed_task("bob-target-create", "bob")
    create_task = _endpoint("POST", "/api/tasks")

    req = task_routes.TaskCreate(
        prompt="alice source",
        trigger_type="webhook",
        then_task_id="bob-target-create",
    )
    with pytest.raises(HTTPException) as exc:
        await create_task(_req("alice"), req)

    assert exc.value.status_code == 404


@pytest.mark.asyncio
async def test_create_task_idempotency_replays_only_matching_owner_request():
    create_task = _endpoint("POST", "/api/tasks")
    key = str(uuid.uuid4())
    req = task_routes.TaskCreate(
        name="retry-safe task",
        prompt="perform this once",
        trigger_type="webhook",
    )

    first = await create_task(_req("alice", key), req)
    replay = await create_task(_req("alice", key), req)
    other_owner = await create_task(_req("bob", key), req)

    assert first["id"] == replay["id"]
    assert other_owner["id"] != first["id"]

    db = _TS()
    try:
        assert db.query(ScheduledTask).filter(
            ScheduledTask.name == "retry-safe task",
        ).count() == 2
        assert db.query(TaskCreateIdempotency).filter_by(
            owner_key="alice", key=key,
        ).count() == 1
        assert db.query(TaskCreateIdempotency).filter_by(
            owner_key="bob", key=key,
        ).count() == 1
    finally:
        db.close()


@pytest.mark.asyncio
async def test_create_task_idempotency_rejects_changed_payload():
    create_task = _endpoint("POST", "/api/tasks")
    key = str(uuid.uuid4())
    original = task_routes.TaskCreate(
        name="retry-safe task",
        prompt="first request",
        trigger_type="webhook",
    )
    await create_task(_req("alice", key), original)

    changed = task_routes.TaskCreate(
        name="retry-safe task",
        prompt="different request",
        trigger_type="webhook",
    )
    with pytest.raises(HTTPException) as exc:
        await create_task(_req("alice", key), changed)

    assert exc.value.status_code == 409


@pytest.mark.asyncio
async def test_create_task_retry_does_not_recreate_deleted_task():
    create_task = _endpoint("POST", "/api/tasks")
    key = str(uuid.uuid4())
    req = task_routes.TaskCreate(
        name="deleted retry-safe task",
        prompt="do not recreate after delete",
        trigger_type="webhook",
    )
    created = await create_task(_req("alice", key), req)

    db = _TS()
    try:
        task = db.query(ScheduledTask).filter_by(id=created["id"]).one()
        db.delete(task)
        db.commit()
    finally:
        db.close()

    with pytest.raises(HTTPException) as exc:
        await create_task(_req("alice", key), req)
    assert exc.value.status_code == 409


@pytest.mark.asyncio
async def test_create_task_idempotency_database_race_returns_winning_row():
    create_task = _endpoint("POST", "/api/tasks")
    key = str(uuid.uuid4())
    req = task_routes.TaskCreate(
        name="concurrent create",
        prompt="same concurrent intent",
        trigger_type="webhook",
    )
    canonical = json.dumps(req.model_dump(), sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    fingerprint = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    winning_task_id = str(uuid.uuid4())
    injected = False

    def insert_competing_request(session, _flush_context, _instances):
        nonlocal injected
        if injected or not any(
            isinstance(obj, TaskCreateIdempotency) and obj.key == key
            for obj in session.new
        ):
            return
        injected = True
        competitor = _TS()
        try:
            competitor.add(ScheduledTask(
                id=winning_task_id,
                owner="alice",
                name="concurrent create",
                prompt=req.prompt,
                task_type="llm",
                trigger_type="webhook",
                status="active",
                output_target="session",
            ))
            competitor.add(TaskCreateIdempotency(
                owner_key="alice",
                key=key,
                fingerprint=fingerprint,
                task_id=winning_task_id,
            ))
            competitor.commit()
        finally:
            competitor.close()

    event.listen(OrmSession, "before_flush", insert_competing_request)
    try:
        result = await create_task(_req("alice", key), req)
    finally:
        event.remove(OrmSession, "before_flush", insert_competing_request)

    assert injected
    assert result["id"] == winning_task_id
    db = _TS()
    try:
        assert db.query(ScheduledTask).filter_by(name="concurrent create").count() == 1
    finally:
        db.close()


@pytest.mark.asyncio
async def test_create_task_idempotency_expires_after_retention_window():
    create_task = _endpoint("POST", "/api/tasks")
    key = str(uuid.uuid4())
    req = task_routes.TaskCreate(
        name="expired create key",
        prompt="new operation after retention",
        trigger_type="webhook",
    )
    original = await create_task(_req("alice", key), req)

    db = _TS()
    try:
        record = db.query(TaskCreateIdempotency).filter_by(
            owner_key="alice", key=key,
        ).one()
        record.created_at = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(days=2)
        db.commit()
    finally:
        db.close()

    fresh = await create_task(_req("alice", key), req)
    assert fresh["id"] != original["id"]


@pytest.mark.asyncio
async def test_update_task_rejects_cross_owner_chain_target():
    _seed_task("alice-source-update", "alice")
    _seed_task("bob-target-update", "bob")
    update_task = _endpoint("PUT", "/api/tasks/{task_id}")

    with pytest.raises(HTTPException) as exc:
        await update_task(
            _req("alice"),
            "alice-source-update",
            task_routes.TaskUpdate(then_task_id="bob-target-update"),
        )

    assert exc.value.status_code == 404
    db = _TS()
    try:
        source = db.query(ScheduledTask).filter(ScheduledTask.id == "alice-source-update").first()
        assert source.then_task_id is None
    finally:
        db.close()


@pytest.mark.asyncio
async def test_update_task_allows_same_owner_chain_target():
    _seed_task("alice-source-allow", "alice")
    _seed_task("alice-target-allow", "alice")
    update_task = _endpoint("PUT", "/api/tasks/{task_id}")

    out = await update_task(
        _req("alice"),
        "alice-source-allow",
        task_routes.TaskUpdate(then_task_id="alice-target-allow"),
    )

    assert out["then_task_id"] == "alice-target-allow"


def test_scheduler_cycle_guard_treats_cross_owner_chain_as_unsafe():
    _seed_task("bob-target-cycle", "bob")
    from src.task_scheduler import TaskScheduler

    scheduler = TaskScheduler.__new__(TaskScheduler)
    db = _TS()
    try:
        assert scheduler._has_chain_cycle(db, "bob-target-cycle", owner="alice") is True
    finally:
        db.close()
