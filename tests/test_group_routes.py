import asyncio
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

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
    assert verified == ["parent", "child-session"]


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
