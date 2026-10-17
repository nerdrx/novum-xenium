"""Only exact, server-owned default tasks may recover a missing grant."""

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

import core.database as database
from src.agent_runtime.authority import restore_task_authority, seal_task_authority, task_operation
from src.owner_identity import DEFAULT_LOCAL_OWNER
from src.task_scheduler import (
    HOUSEKEEPING_DEFAULTS, TaskScheduler, _default_authority_owner_exists,
)
from tests.helpers.database import disposable_database


def _default_task(action, *, owner="alice", **overrides):
    defaults = HOUSEKEEPING_DEFAULTS[action]
    values = {
        "id": f"{owner}-{action}",
        "owner": owner,
        "name": defaults["name"],
        "task_type": "action",
        "action": action,
        "prompt": None,
        "request_authority_json": None,
        "status": "paused",
        "output_target": "notification",
        "model": "preserved-model",
        "endpoint_url": "https://endpoint.example.test/v1",
        "notifications_enabled": True,
    }
    values.update(overrides)
    return database.ScheduledTask(**values)


@pytest.fixture
def task_store(tmp_path, monkeypatch):
    with disposable_database(tmp_path) as factory:
        monkeypatch.setattr(database, "SessionLocal", factory)
        import routes.prefs_routes as prefs
        monkeypatch.setattr(prefs, "_load_for_user", lambda _owner: {"tasks_enabled": True})
        monkeypatch.setattr(
            "src.task_scheduler._default_authority_owner_exists",
            lambda owner: owner == "alice",
        )
        scheduler = TaskScheduler(session_manager=None)
        scheduler.ensure_assistant_defaults = AsyncMock()
        yield factory, scheduler


def test_default_authority_recovery_requires_a_real_owner(monkeypatch):
    import core.auth as auth
    import src.owner_identity as owner_identity

    names = {"alice", "internal-tool", "api", "demo", "system", "sft_fixture"}
    monkeypatch.setattr(owner_identity, "auth_disabled", lambda: False)
    monkeypatch.setattr(auth, "AuthManager", lambda: SimpleNamespace(users=names))
    assert _default_authority_owner_exists("alice")
    for owner in ("unknown", "internal-tool", "api", "demo", "system", "sft_fixture"):
        assert not _default_authority_owner_exists(owner)

    monkeypatch.setattr(owner_identity, "auth_disabled", lambda: True)
    assert _default_authority_owner_exists(DEFAULT_LOCAL_OWNER)
    assert not _default_authority_owner_exists("alice")
    assert not _default_authority_owner_exists("unknown")


@pytest.mark.asyncio
async def test_exact_empty_canonical_default_recovers_and_runs_builtin(task_store, monkeypatch):
    factory, scheduler = task_store
    task = _default_task("tidy_sessions")
    task_id = task.id
    with factory() as db:
        db.add(task)
        db.commit()

    await scheduler.ensure_defaults("alice")

    with factory() as db:
        stored = db.get(database.ScheduledTask, task_id)
        snapshot = stored.request_authority_json
        assert snapshot
        authority = restore_task_authority(
            snapshot, stored.prompt, stored.task_type, stored.action, owner="alice"
        )
        assert authority.permits(task_operation(stored.task_type, stored.action, stored.prompt))
        assert (stored.status, stored.output_target, stored.model, stored.endpoint_url) == (
            "paused", "notification", "preserved-model", "https://endpoint.example.test/v1"
        )

    import src.builtin_actions as actions
    handler = AsyncMock(return_value=("tidied", True))
    monkeypatch.setitem(actions.BUILTIN_ACTIONS, "tidy_sessions", handler)
    result, success = await scheduler._execute_action(stored)
    assert (result, success) == ("tidied", True)
    handler.assert_awaited_once()


@pytest.mark.asyncio
async def test_recovery_is_idempotent_and_scoped_to_requested_owner(task_store):
    factory, scheduler = task_store
    alice = _default_task("tidy_sessions", owner="alice")
    bob = _default_task("tidy_documents", owner="bob")
    alice_id, bob_id = alice.id, bob.id
    with factory() as db:
        db.add_all([alice, bob])
        db.commit()

    await scheduler.ensure_defaults("alice")
    with factory() as db:
        recovered = db.get(database.ScheduledTask, alice_id).request_authority_json
        assert recovered
        assert db.get(database.ScheduledTask, bob_id).request_authority_json is None

    await scheduler.ensure_defaults("alice")
    with factory() as db:
        assert db.get(database.ScheduledTask, alice_id).request_authority_json == recovered
        assert db.get(database.ScheduledTask, bob_id).request_authority_json is None


@pytest.mark.asyncio
async def test_custom_or_noncanonical_legacy_rows_do_not_gain_authority(task_store):
    factory, scheduler = task_store
    custom_prompt = _default_task("tidy_sessions", prompt="Run a custom operation")
    custom_name = _default_task("tidy_documents", name="My custom task")
    task_ids = (custom_prompt.id, custom_name.id)
    with factory() as db:
        db.add_all([custom_prompt, custom_name])
        db.commit()

    await scheduler.ensure_defaults("alice")

    with factory() as db:
        for task_id in task_ids:
            stored = db.get(database.ScheduledTask, task_id)
            assert stored.request_authority_json is None
            authority = restore_task_authority(
                stored.request_authority_json, stored.prompt, stored.task_type,
                stored.action, owner=stored.owner,
            )
            assert not authority.permits(task_operation(stored.task_type, stored.action, stored.prompt))


@pytest.mark.asyncio
async def test_nonempty_invalid_or_parent_denied_snapshots_are_never_replaced(task_store):
    factory, scheduler = task_store
    invalid = _default_task("tidy_sessions", request_authority_json="not-json")
    denied_snapshot = seal_task_authority(
        None, "action", "tidy_documents", owner="alice", parent_authority=None
    )
    denied = _default_task("tidy_documents", request_authority_json=denied_snapshot)
    invalid_id, denied_id = invalid.id, denied.id
    with factory() as db:
        db.add_all([invalid, denied])
        db.commit()

    await scheduler.ensure_defaults("alice")

    with factory() as db:
        assert db.get(database.ScheduledTask, invalid_id).request_authority_json == "not-json"
        stored_denied = db.get(database.ScheduledTask, denied_id)
        assert stored_denied.request_authority_json == denied_snapshot
        authority = restore_task_authority(
            stored_denied.request_authority_json, stored_denied.prompt,
            stored_denied.task_type, stored_denied.action, owner="alice",
        )
        assert not authority.permits(task_operation(
            stored_denied.task_type, stored_denied.action, stored_denied.prompt
        ))
