import asyncio
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from fastapi.responses import StreamingResponse

from routes import group_routes
from src.group_coordination import GroupCoordinationStore
from src.group_runs import GroupRunManager


def _board():
    return {
        "plan": "Review changes",
        "participants": [{"id": "builder", "display": "Builder", "role": "builder"}],
        "tasks": [{"id": "t1", "title": "Inspect", "owner_id": "builder", "reviewer_id": "",
                   "status": "pending", "work_result": ""}],
    }


def test_group_board_routes_verify_parent_and_scope_storage(tmp_path, monkeypatch):
    store = GroupCoordinationStore(str(tmp_path / "route.db"))
    verified = []
    monkeypatch.setattr(group_routes, "_store", store)
    monkeypatch.setattr(group_routes, "_runs", group_routes.GroupRunManager(store, runner=lambda *a, **k: "ok"))
    monkeypatch.setattr(group_routes, "_verify_session_owner", lambda request, sid: verified.append(sid))
    monkeypatch.setattr(group_routes, "storage_owner_for_request", lambda request: request.owner)
    request = SimpleNamespace(owner="alice", state=SimpleNamespace(), headers={})

    saved = asyncio.run(group_routes.save_team_board(request, "parent", {"board": _board()}))
    loaded = asyncio.run(group_routes.get_team_board(request, "parent"))
    assert saved == loaded
    assert loaded["board"]["plan"] == "Review changes"
    assert store.get("parent", "bob") is None
    assert verified == ["parent", "parent"]


def test_group_board_route_rejects_invalid_board(tmp_path, monkeypatch):
    store = GroupCoordinationStore(str(tmp_path / "route.db"))
    monkeypatch.setattr(group_routes, "_store", store)
    monkeypatch.setattr(group_routes, "_runs", group_routes.GroupRunManager(store, runner=lambda *a, **k: "ok"))
    monkeypatch.setattr(group_routes, "_verify_session_owner", lambda request, sid: None)
    monkeypatch.setattr(group_routes, "storage_owner_for_request", lambda request: "alice")
    with pytest.raises(HTTPException) as exc:
        asyncio.run(group_routes.save_team_board(SimpleNamespace(state=SimpleNamespace(), headers={}), "parent", {"board": {}}))
    assert exc.value.status_code == 422

@pytest.mark.parametrize("state,headers", [(SimpleNamespace(api_token=True), {}), (SimpleNamespace(), {"X-Odysseus-Internal-Tool": "test"})])
def test_group_completion_requires_human_browser(state, headers):
    from core.middleware import INTERNAL_TOOL_HEADER
    if headers: headers = {INTERNAL_TOOL_HEADER: "test"}
    request = SimpleNamespace(state=state, headers=headers)
    with pytest.raises(HTTPException) as exc:
        asyncio.run(group_routes.save_team_board(request, "parent", {"board": _board()}))
    assert exc.value.status_code == 403


def test_server_run_owner_checks_parent_and_participant_sessions(tmp_path, monkeypatch):
    async def runner(*_args, **_kwargs):
        return "done"

    store = GroupCoordinationStore(str(tmp_path / "route.db"))
    monkeypatch.setattr(group_routes, "_store", store)
    manager = group_routes.GroupRunManager(store, runner=runner)
    monkeypatch.setattr(group_routes, "_runs", manager)
    monkeypatch.setattr(group_routes, "storage_owner_for_request", lambda request: request.owner)
    verified = []
    monkeypatch.setattr(group_routes, "_verify_session_owner", lambda request, sid: verified.append(sid))
    request = SimpleNamespace(owner="alice", state=SimpleNamespace(), headers={})
    body = {"board": _board(), "participant_sessions": {"builder": "child-session"}}
    async def scenario():
        result = await group_routes.start_team_run(request, "parent", body)
        await manager._tasks[result["run"]["job_id"]]
        return result

    result = asyncio.run(scenario())
    assert result["run"]["status"] == "running"  # status at accepted time
    assert store.get_run("parent", "alice")["status"] == "completed"
    assert verified == ["parent", "child-session", "parent"]


@pytest.mark.parametrize("change_model_after_queue", [False, True])
def test_server_run_binds_real_runner_to_verified_child_model(tmp_path, monkeypatch, change_model_after_queue):
    from src import agent_runs, auth_helpers, group_chat_runner
    from routes import session_routes

    store = GroupCoordinationStore(str(tmp_path / "model-bound-route.db"))
    monkeypatch.setattr(group_routes, "_store", store)
    monkeypatch.setattr(group_routes, "_require_interactive", lambda _request: None)
    monkeypatch.setattr(group_routes, "_verify_session_owner", lambda _request, _sid: None)
    monkeypatch.setattr(group_routes, "storage_owner_for_request", lambda request: request.owner)
    monkeypatch.setattr(session_routes, "_verify_session_owner", lambda _request, _sid: None)
    monkeypatch.setattr(auth_helpers, "storage_owner_for_request", lambda request: request.state.current_user)
    monkeypatch.setattr(agent_runs, "is_active", lambda _session_id: False)

    class Sessions:
        child = SimpleNamespace(model="gpt-6-luna")

        def get_session(self, session_id):
            return self.child if session_id == "child-session" else None

    sessions = Sessions()
    calls = []

    async def chat_stream(request):
        calls.append(request.state.current_user)

        async def events():
            yield 'data: {"delta":"did work"}\n\n'
            yield "data: [DONE]\n\n"

        return StreamingResponse(events(), headers={"X-Odysseus-Run-Id": "team-child-run"})

    runner = group_chat_runner.create_assignment_runner(chat_stream, sessions)
    manager = GroupRunManager(store, runner=runner)
    monkeypatch.setattr(group_routes, "_runs", manager)
    request = SimpleNamespace(
        owner="alice", state=SimpleNamespace(current_user="alice"), headers={},
        scope={"state": {"current_user": "alice"}},
        app=SimpleNamespace(state=SimpleNamespace(session_manager=sessions)),
    )

    async def scenario():
        result = await group_routes.start_team_run(
            request, "parent", {"board": _board(), "participant_sessions": {"builder": "child-session"}}
        )
        if change_model_after_queue:
            sessions.child.model = "gpt-6-astra"
        await manager._tasks[result["run"]["job_id"]]
        return store.get_run("parent", "alice")

    record = asyncio.run(scenario())
    if change_model_after_queue:
        assert record["status"] == "failed"
        assert "model changed" in record["state"]["message"]
        assert calls == []
    else:
        assert record["status"] == "completed"
        assert calls == ["alice"]


def test_parent_delete_cancels_real_child_run_without_resurrecting_saved_board(tmp_path, monkeypatch):
    from src import agent_runs, auth_helpers, group_chat_runner
    from routes import session_routes

    store = GroupCoordinationStore(str(tmp_path / "delete-active-team.db"))
    entered = asyncio.Event()
    child_cancelled = asyncio.Event()

    class Sessions:
        def get_session(self, session_id):
            return SimpleNamespace(model="gpt-6-luna") if session_id == "child-session" else None

    async def chat_stream(_request):
        async def events():
            try:
                yield 'data: {"delta":"child is working"}\n\n'
                entered.set()
                await asyncio.Event().wait()
            finally:
                child_cancelled.set()

        return StreamingResponse(events(), headers={"X-Odysseus-Run-Id": "team-delete-child"})

    sessions = Sessions()
    runner = group_chat_runner.create_assignment_runner(chat_stream, sessions)
    manager = GroupRunManager(store, runner=runner)
    monkeypatch.setattr(group_routes, "_store", store)
    monkeypatch.setattr(group_routes, "_runs", manager)
    monkeypatch.setattr(group_routes, "_require_interactive", lambda _request: None)
    monkeypatch.setattr(group_routes, "_verify_session_owner", lambda _request, _sid: None)
    monkeypatch.setattr(group_routes, "storage_owner_for_request", lambda request: request.owner)
    monkeypatch.setattr(session_routes, "_verify_session_owner", lambda _request, _sid: None)
    monkeypatch.setattr(auth_helpers, "storage_owner_for_request", lambda request: request.state.current_user)
    monkeypatch.setattr(agent_runs, "is_active", lambda _session_id: False)
    monkeypatch.setattr(agent_runs, "get_active_run", lambda _session_id: None)
    request = SimpleNamespace(
        owner="alice", state=SimpleNamespace(current_user="alice"), headers={},
        scope={"state": {"current_user": "alice"}},
        app=SimpleNamespace(state=SimpleNamespace(session_manager=sessions)),
    )

    async def scenario():
        result = await group_routes.start_team_run(
            request, "parent", {"board": _board(), "participant_sessions": {"builder": "child-session"}}
        )
        job_id = result["run"]["job_id"]
        task = manager._tasks[job_id]
        await entered.wait()
        assert store.get("parent", "alice") is not None
        await asyncio.to_thread(group_routes.delete_team_board, "parent", "alice")
        assert store.get("parent", "alice") is None
        assert store.get_run("parent", "alice", job_id) is None
        done, _pending = await asyncio.wait({task}, timeout=1)
        if task not in done:
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
            pytest.fail("parent deletion did not cancel its active child run")
        with pytest.raises(asyncio.CancelledError):
            await task
        await asyncio.sleep(0)  # let the task's done callback release its fence
        return job_id

    job_id = asyncio.run(scenario())
    assert child_cancelled.is_set()
    assert store.get("parent", "alice") is None
    assert store.get_run("parent", "alice", job_id) is None
    assert not manager.is_active("parent", "alice")
    assert job_id not in manager._delete_fences


def test_parent_delete_cannot_split_run_creation_from_task_registration(tmp_path, monkeypatch):
    import threading

    from src import agent_runs, auth_helpers, group_chat_runner
    from routes import session_routes

    store = GroupCoordinationStore(str(tmp_path / "delete-enqueue-race.db"))
    entered_create = threading.Event()
    release_create = threading.Event()
    delete_attempted = threading.Event()
    delete_finished = threading.Event()
    child_release = asyncio.Event()
    job_ids = []
    deletion_was_blocked = []

    class Sessions:
        def get_session(self, session_id):
            return SimpleNamespace(model="gpt-6-luna") if session_id == "child-session" else None

    async def chat_stream(_request):
        async def events():
            yield 'data: {"delta":"child running"}\n\n'
            await child_release.wait()
            yield "data: [DONE]\n\n"

        return StreamingResponse(events(), headers={"X-Odysseus-Run-Id": "team-enqueue-race"})

    sessions = Sessions()
    runner = group_chat_runner.create_assignment_runner(chat_stream, sessions)
    manager = GroupRunManager(store, runner=runner)
    original_create_run = store.create_run

    def blocked_create_run(job_id, session_id, owner, state):
        job_ids.append(job_id)
        original_create_run(job_id, session_id, owner, state)
        entered_create.set()
        if not delete_attempted.wait(2):
            raise RuntimeError("deletion thread did not reach the enqueue boundary")
        release_create.set()

    store.create_run = blocked_create_run
    monkeypatch.setattr(group_routes, "_store", store)
    monkeypatch.setattr(group_routes, "_runs", manager)
    monkeypatch.setattr(group_routes, "_require_interactive", lambda _request: None)
    monkeypatch.setattr(group_routes, "_verify_session_owner", lambda _request, _sid: None)
    monkeypatch.setattr(group_routes, "storage_owner_for_request", lambda request: request.owner)
    monkeypatch.setattr(session_routes, "_verify_session_owner", lambda _request, _sid: None)
    monkeypatch.setattr(auth_helpers, "storage_owner_for_request", lambda request: request.state.current_user)
    monkeypatch.setattr(agent_runs, "is_active", lambda _session_id: False)
    monkeypatch.setattr(agent_runs, "get_active_run", lambda _session_id: None)
    request = SimpleNamespace(
        owner="alice", state=SimpleNamespace(current_user="alice"), headers={},
        scope={"state": {"current_user": "alice"}},
        app=SimpleNamespace(state=SimpleNamespace(session_manager=sessions)),
    )

    def delete_during_create():
        if not entered_create.wait(2):
            return
        acquired = manager._registry_lock.acquire(blocking=False)
        deletion_was_blocked.append(not acquired)
        if acquired:
            manager._registry_lock.release()
        delete_attempted.set()
        group_routes.delete_team_board("parent", "alice")
        delete_finished.set()

    deleter = threading.Thread(target=delete_during_create)
    deleter.start()

    async def scenario():
        await group_routes.start_team_run(
            request, "parent", {"board": _board(), "participant_sessions": {"builder": "child-session"}}
        )
        assert job_ids
        task = manager._tasks[job_ids[0]]
        assert delete_attempted.is_set()
        await asyncio.to_thread(deleter.join, 2)
        assert delete_finished.is_set()
        done, _pending = await asyncio.wait({task}, timeout=1)
        if task not in done:
            child_release.set()
            await task
            pytest.fail("deleted parent allowed the queued child run to survive")
        assert task.cancelled(), "parent deletion must cancel the exact newly registered task"
        with pytest.raises(asyncio.CancelledError):
            await task
        await asyncio.sleep(0)

    asyncio.run(scenario())
    assert deletion_was_blocked == [True]
    assert store.get("parent", "alice") is None
    assert store.get_run("parent", "alice", job_ids[0]) is None
    assert job_ids[0] not in manager._delete_fences


def test_parent_is_reverified_after_delete_before_team_run_enqueue(tmp_path, monkeypatch):
    import threading

    store = GroupCoordinationStore(str(tmp_path / "delete-after-ownercheck.db"))
    checked_parent = threading.Event()
    deleted_parent = threading.Event()
    exists = {"parent": True}
    parent_checks = []
    starts = []

    class Sessions:
        def get_session(self, _session_id):
            return SimpleNamespace(model="gpt-6-luna")

    manager = GroupRunManager(store, runner=lambda *_args, **_kwargs: starts.append(True))
    monkeypatch.setattr(group_routes, "_store", store)
    monkeypatch.setattr(group_routes, "_runs", manager)
    monkeypatch.setattr(group_routes, "_require_interactive", lambda _request: None)
    monkeypatch.setattr(group_routes, "storage_owner_for_request", lambda _request: "alice")

    def verify(_request, session_id):
        if session_id != "parent":
            return
        parent_checks.append(True)
        if not exists["parent"]:
            raise HTTPException(404, "parent deleted")
        if len(parent_checks) == 1:
            checked_parent.set()
            if not deleted_parent.wait(2):
                raise RuntimeError("deletion thread did not finish")

    monkeypatch.setattr(group_routes, "_verify_session_owner", verify)
    request = SimpleNamespace(
        state=SimpleNamespace(), headers={}, owner="alice", scope={},
        app=SimpleNamespace(state=SimpleNamespace(session_manager=Sessions())),
    )
    body = {"board": _board(), "participant_sessions": {"builder": "child-session"}}

    def delete_after_ownercheck():
        if not checked_parent.wait(2):
            return
        exists["parent"] = False
        group_routes.delete_team_board("parent", "alice")
        deleted_parent.set()

    deleter = threading.Thread(target=delete_after_ownercheck)
    deleter.start()
    with pytest.raises(HTTPException) as exc:
        asyncio.run(group_routes.start_team_run(request, "parent", body))
    deleter.join(timeout=2)

    assert exc.value.status_code == 404
    assert len(parent_checks) == 2
    assert not starts
    assert not manager._tasks
    assert store.get("parent", "alice") is None
    assert store.get_run("parent", "alice") is None


def test_team_run_rejects_uncertain_working_task_before_queueing(tmp_path, monkeypatch):
    store = GroupCoordinationStore(str(tmp_path / "uncertain-task.db"))
    starts = []

    async def runner(*_args, **_kwargs):
        starts.append(True)
        return "unexpected"

    class Sessions:
        def get_session(self, _session_id):
            return SimpleNamespace(model="gpt-6-luna")

    manager = GroupRunManager(store, runner=runner)
    monkeypatch.setattr(group_routes, "_store", store)
    monkeypatch.setattr(group_routes, "_runs", manager)
    monkeypatch.setattr(group_routes, "_require_interactive", lambda _request: None)
    monkeypatch.setattr(group_routes, "_verify_session_owner", lambda _request, _sid: None)
    monkeypatch.setattr(group_routes, "storage_owner_for_request", lambda _request: "alice")
    request = SimpleNamespace(
        state=SimpleNamespace(), headers={}, scope={},
        app=SimpleNamespace(state=SimpleNamespace(session_manager=Sessions())),
    )
    board = _board()
    board["tasks"][0]["status"] = "working"

    with pytest.raises(HTTPException) as exc:
        asyncio.run(group_routes.start_team_run(
            request, "parent", {"board": board, "participant_sessions": {"builder": "builder-session"}}
        ))

    assert exc.value.status_code == 409
    assert "inspect" in exc.value.detail.lower() and "retry" in exc.value.detail.lower()
    assert not starts
    assert not manager._tasks
    assert store.get("parent", "alice") is None
    assert store.get_run("parent", "alice") is None


def test_server_run_rejects_incognito_before_queueing(tmp_path, monkeypatch):
    store = GroupCoordinationStore(str(tmp_path / "route.db"))
    monkeypatch.setattr(group_routes, "_store", store)
    monkeypatch.setattr(group_routes, "_runs", group_routes.GroupRunManager(store, runner=lambda *a, **k: "unused"))
    monkeypatch.setattr(group_routes, "storage_owner_for_request", lambda request: request.owner)
    monkeypatch.setattr(group_routes, "_verify_session_owner", lambda request, sid: None)
    request = SimpleNamespace(owner="alice", state=SimpleNamespace(), headers={}, scope={})
    body = {"board": _board(), "participant_sessions": {"builder": "child"},
            "request_context": {"incognito": "true"}}
    with pytest.raises(HTTPException) as exc:
        asyncio.run(group_routes.start_team_run(request, "parent", body))
    assert exc.value.status_code == 422
    assert store.get_run("parent", "alice") is None


def test_isolated_run_requires_admin_and_selected_git_workspace(tmp_path, monkeypatch):
    from src import project_workflows

    store = GroupCoordinationStore(str(tmp_path / "isolated-route.db"))
    contexts = []

    async def runner(*_args, **kwargs):
        contexts.append(kwargs["context"])
        return "done"

    manager = GroupRunManager(store, runner=runner)
    monkeypatch.setattr(group_routes, "_store", store)
    monkeypatch.setattr(group_routes, "_runs", manager)
    monkeypatch.setattr(group_routes, "storage_owner_for_request", lambda request: request.owner)
    monkeypatch.setattr(group_routes, "get_current_user", lambda _request: "alice")
    monkeypatch.setattr(group_routes, "owner_is_admin_or_single_user", lambda user: user == "alice")
    monkeypatch.setattr(group_routes, "_verify_session_owner", lambda *_args: None)
    monkeypatch.setattr(project_workflows, "resolve_repository", lambda path: "/repo" if path == "/selected" else (_ for _ in ()).throw(ValueError("not a git workspace")))
    monkeypatch.setattr(project_workflows, "create_worktree", lambda owner, source: {
        "id": "a" * 32, "path": "/managed/task", "repository": source, "commit": "head",
    })
    request = SimpleNamespace(owner="alice", state=SimpleNamespace(), headers={}, scope={})

    async def scenario():
        result = await group_routes.start_team_run(request, "parent", {
            "board": _board(), "participant_sessions": {"builder": "child"},
            "request_context": {"workspace": "/selected"}, "isolate_worktrees": True,
        })
        await manager._tasks[result["run"]["job_id"]]
        return result

    asyncio.run(scenario())
    assert contexts[0]["isolate_worktrees"] is False
    assert contexts[0]["source_workspace"] == "/repo"
    assert contexts[0]["options"]["workspace"] == "/managed/task"

    with pytest.raises(HTTPException) as exc:
        asyncio.run(group_routes.start_team_run(request, "parent-2", {
            "board": _board(), "participant_sessions": {"builder": "child"},
            "request_context": {"workspace": "/invalid"}, "isolate_worktrees": True,
        }))
    assert exc.value.status_code == 422

    monkeypatch.setattr(group_routes, "owner_is_admin_or_single_user", lambda _user: False)
    with pytest.raises(HTTPException) as exc:
        asyncio.run(group_routes.start_team_run(request, "parent-3", {
            "board": _board(), "participant_sessions": {"builder": "child"},
            "request_context": {"workspace": "/selected"}, "isolate_worktrees": True,
        }))
    assert exc.value.status_code == 403
