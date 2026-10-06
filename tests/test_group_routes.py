import asyncio
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from routes import group_routes
from src.group_coordination import GroupCoordinationStore


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
    monkeypatch.setattr(group_routes, "_store", GroupCoordinationStore(str(tmp_path / "route.db")))
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
