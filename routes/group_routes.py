"""Owner-scoped Group Team board API."""
from fastapi import APIRouter, Depends, HTTPException, Request

from routes.session_routes import _verify_session_owner
from src.auth_helpers import require_chat_api_token_scope, storage_owner_for_request, is_delegated_credential, get_current_user
from core.middleware import INTERNAL_TOOL_HEADER
from src.owner_identity import INTERNAL_TOOL_USER
from src.group_coordination import GroupCoordinationStore, validate_board
from src.group_runs import GroupRunManager
from src.tool_security import owner_is_admin_or_single_user

router = APIRouter(
    prefix="/api/groups",
    tags=["groups"],
    dependencies=[Depends(require_chat_api_token_scope)],
)
_store = GroupCoordinationStore()
_runs = GroupRunManager(_store)


def _require_interactive(request):
    if (is_delegated_credential(request) or request.headers.get(INTERNAL_TOOL_HEADER)
            or get_current_user(request) == INTERNAL_TOOL_USER):
        raise HTTPException(403, "Team assignments and completion require an interactive session.")


def delete_team_board(session_id: str, owner: str | None) -> None:
    """Internal owner-scoped cleanup hook for permanent session deletion."""
    _runs.delete_session(session_id, owner)


@router.get("/{session_id}/team")
async def get_team_board(request: Request, session_id: str):
    _verify_session_owner(request, session_id)
    board = _store.get(session_id, storage_owner_for_request(request))
    return {"board": board}


@router.put("/{session_id}/team")
async def save_team_board(request: Request, session_id: str, body: dict):
    _require_interactive(request)
    _verify_session_owner(request, session_id)
    owner = storage_owner_for_request(request)
    if _store.active_run(session_id, owner) or _runs.is_active(session_id, owner):
        raise HTTPException(409, "Team board is locked while its server pass is running.")
    try:
        board = validate_board(body.get("board"))
    except (ValueError, TypeError) as exc:
        raise HTTPException(422, str(exc)) from exc
    return {"board": _store.save(session_id, owner, board)}


@router.post("/{session_id}/team/run")
async def start_team_run(request: Request, session_id: str, body: dict):
    _require_interactive(request)
    _verify_session_owner(request, session_id)
    try:
        isolate_worktrees = body.get("isolate_worktrees", False)
        if not isinstance(isolate_worktrees, bool):
            raise ValueError("isolate_worktrees must be a boolean")
        if isolate_worktrees and not owner_is_admin_or_single_user(get_current_user(request)):
            raise HTTPException(403, "Isolated team worktrees require an admin session")
        board = validate_board(body.get("board"))
        sessions = body.get("participant_sessions")
        if not isinstance(sessions, dict) or set(sessions) != {p["id"] for p in board["participants"]}:
            raise ValueError("Provide one participant chat session for every team member")
        if any(not isinstance(sid, str) or not sid or len(sid) > 256 for sid in sessions.values()):
            raise ValueError("Invalid participant chat session")
        if session_id in sessions.values():
            raise ValueError("Each team member needs a separate participant chat")
        if len(set(sessions.values())) != len(sessions):
            raise ValueError("Each team member needs a separate chat session")
        for child_session in sessions.values():
            _verify_session_owner(request, child_session)
        options = body.get("request_context") or {}
        allowed = {"mode", "plan_mode", "allow_bash", "allow_web_search", "use_web", "use_rag", "workspace", "incognito"}
        if not isinstance(options, dict) or set(options) - allowed:
            raise ValueError("Invalid team request context")
        options = {key: value for key, value in options.items() if isinstance(value, (str, bool, int))}
        if any(len(str(value)) > 2048 for value in options.values()):
            raise ValueError("Team request context is too large")
        if str(options.get("incognito", "false")).lower() == "true":
            raise ValueError("Server-owned team passes are unavailable in incognito sessions")
        source_workspace = None
        if isolate_worktrees:
            selected_workspace = options.get("workspace")
            if not isinstance(selected_workspace, str) or not selected_workspace.strip():
                raise ValueError("Choose a Git workspace before isolating team tasks")
            from src.project_workflows import resolve_repository
            source_workspace = resolve_repository(selected_workspace)
    except (ValueError, TypeError) as exc:
        raise HTTPException(422, str(exc)) from exc
    except HTTPException:
        raise
    try:
        scope = getattr(request, "scope", {})
        safe_headers = [(key, value) for key, value in scope.get("headers", [])
                        if key.lower() in {b"accept-language", b"user-agent", b"x-timezone", b"x-user-timezone"}]
        app_state = getattr(getattr(request, "app", None), "state", None)
        session_manager = getattr(app_state, "session_manager", None)
        models = {}
        if session_manager is not None:
            for child_session in sessions.values():
                child = session_manager.get_session(child_session)
                model = getattr(child, "model", None)
                if not model:
                    raise HTTPException(409, "Team participant session is unavailable; reopen the team chat")
                models[child_session] = model
        context = {
            "request_scope": {
                "app": getattr(request, "app", None),
                "state": dict(scope.get("state") or {}),
                "client": scope.get("client"),
                "server": scope.get("server"),
                "headers": safe_headers,
            },
            "options": options,
            "models": models,
            "isolate_worktrees": isolate_worktrees,
            "source_workspace": source_workspace,
        }
        run = await _runs.start(
            session_id, storage_owner_for_request(request), board, sessions, context,
            validate_parent=lambda: _verify_session_owner(request, session_id),
        )
    except RuntimeError as exc:
        detail = str(exc)
        status = 409 if any(marker in detail for marker in ("already running", "queued", "still marked working")) else 503
        raise HTTPException(status, detail) from exc
    return {"run": run}


@router.get("/{session_id}/team/run")
async def get_team_run(request: Request, session_id: str, job_id: str | None = None):
    _verify_session_owner(request, session_id)
    return {"run": _store.get_run(session_id, storage_owner_for_request(request), job_id)}


@router.post("/{session_id}/team/stop")
async def stop_team_run(request: Request, session_id: str, body: dict):
    _require_interactive(request)
    _verify_session_owner(request, session_id)
    stopped = await _runs.stop(
        session_id, storage_owner_for_request(request), str(body.get("job_id") or "") or None,
    )
    return {"stopped": stopped}
