"""Offline harness preflight API."""
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query, Request

from core.database import Session as DbSession, SessionLocal
from routes.session_routes import _verify_session_owner
from src.auth_helpers import effective_user, is_delegated_credential, require_chat_api_token_scope, require_user
from src.owner_identity import is_request_sentinel_owner
from src.harness_preflight import build_preflight


def _interactive_admin(request: Request, owner: str) -> bool:
    if (not owner or is_delegated_credential(request) or is_request_sentinel_owner(owner)
            or request.headers.get("X-Odysseus-Internal-Token")
            or getattr(request.state, "current_user", None) == "internal-tool"):
        return False
    manager = getattr(request.app.state, "auth_manager", None)
    check = getattr(manager, "is_admin", None)
    try:
        return callable(check) and bool(check(owner))
    except Exception:
        return False


def setup_harness_routes(session_manager=None) -> APIRouter:
    router = APIRouter(prefix="/api/harness", tags=["harness"])

    @router.get("/preflight/{session_id}")
    async def preflight(
        request: Request,
        session_id: str,
        workspace: str | None = Query(default=None, max_length=4096),
        include_details: bool = False,
    ):
        require_chat_api_token_scope(request)
        _verify_session_owner(request, session_id, session_manager)
        owner = effective_user(request) or ""
        if include_details and not _interactive_admin(request, owner):
            raise HTTPException(403, "Interactive admin access is required for file details")

        db = SessionLocal()
        try:
            session = db.query(DbSession).filter(DbSession.id == session_id).first()
        finally:
            db.close()
        if session is None and session_manager is not None:
            session = getattr(session_manager, "sessions", {}).get(session_id)
        if session is None:
            raise HTTPException(404, "Session not found")

        details = None
        if include_details:
            user = require_user(request)
            if not user or user != owner or not _interactive_admin(request, user):
                raise HTTPException(403, "Interactive admin access is required for file details")
            from src.tool_execution import vet_workspace
            vetted = vet_workspace(workspace or "")
            path = Path(vetted) if vetted else None
            details = {"workspace": {
                "provided": bool(workspace),
                "vetted": path is not None,
                "exists": path.exists() if path else None,
                "is_directory": path.is_dir() if path else None,
            }}
        return build_preflight(session, owner, workspace, details=details)

    return router
