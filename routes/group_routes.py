"""Owner-scoped Group Team board API."""
from fastapi import APIRouter, Depends, HTTPException, Request

from routes.session_routes import _verify_session_owner
from src.auth_helpers import require_chat_api_token_scope, storage_owner_for_request, is_delegated_credential, get_current_user
from core.middleware import INTERNAL_TOOL_HEADER
from src.owner_identity import INTERNAL_TOOL_USER
from src.group_coordination import GroupCoordinationStore, validate_board

router = APIRouter(
    prefix="/api/groups",
    tags=["groups"],
    dependencies=[Depends(require_chat_api_token_scope)],
)
_store = GroupCoordinationStore()


def delete_team_board(session_id: str, owner: str | None) -> None:
    """Internal owner-scoped cleanup hook for permanent session deletion."""
    _store.delete(session_id, owner)


@router.get("/{session_id}/team")
async def get_team_board(request: Request, session_id: str):
    _verify_session_owner(request, session_id)
    board = _store.get(session_id, storage_owner_for_request(request))
    return {"board": board}


@router.put("/{session_id}/team")
async def save_team_board(request: Request, session_id: str, body: dict):
    if (is_delegated_credential(request) or request.headers.get(INTERNAL_TOOL_HEADER)
            or get_current_user(request) == INTERNAL_TOOL_USER):
        raise HTTPException(403, "Team assignments and completion require an interactive session.")
    _verify_session_owner(request, session_id)
    try:
        board = validate_board(body.get("board"))
    except (ValueError, TypeError) as exc:
        raise HTTPException(422, str(exc)) from exc
    return {"board": _store.save(session_id, storage_owner_for_request(request), board)}
