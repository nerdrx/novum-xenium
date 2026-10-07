"""Interactive, owner-scoped project workflow API."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request

from core.middleware import INTERNAL_TOOL_HEADER
from src.auth_helpers import get_current_user, is_delegated_credential, storage_owner_for_request
from src.owner_identity import INTERNAL_TOOL_USER
from src.tool_security import owner_is_admin_or_single_user
from src.project_workflows import (
    ProjectWorkflowError,
    create_worktree,
    get_verification_config,
    inspect_project,
    list_worktrees,
    remove_worktree,
    run_verification,
    save_verification_config,
)


def setup_project_routes() -> APIRouter:
    router = APIRouter(prefix="/api/project-workflows", tags=["project-workflows"])

    def scope(request: Request) -> str:
        user = get_current_user(request)
        if (request.headers.get(INTERNAL_TOOL_HEADER) or is_delegated_credential(request)
                or user == INTERNAL_TOOL_USER):
            raise HTTPException(403, "Project workflows require an interactive admin session")
        if not owner_is_admin_or_single_user(user):
            raise HTTPException(403, "Project workflows are admin-only")
        owner = storage_owner_for_request(request)
        if not owner:
            raise HTTPException(401, "Project workflow owner is unavailable")
        return owner

    def call(fn, *args):
        try:
            return fn(*args)
        except ProjectWorkflowError as exc:
            text = str(exc)
            raise HTTPException(409 if any(term in text.lower() for term in ("modified", "untracked", "preserved")) else 400, text) from exc

    async def async_call(fn, *args):
        try:
            return await fn(*args)
        except ProjectWorkflowError as exc:
            text = str(exc)
            raise HTTPException(409 if any(term in text.lower() for term in ("modified", "untracked", "preserved")) else 400, text) from exc

    def body_object(body):
        if not isinstance(body, dict):
            raise HTTPException(400, "Request body must be an object")
        return body

    @router.post("/inspect")
    def inspect(request: Request, body: dict):
        owner = scope(request)
        workspace = body.get("workspace") if isinstance(body, dict) else None
        if not isinstance(workspace, str):
            raise HTTPException(400, "Workspace is required")
        return call(inspect_project, owner, workspace)

    @router.get("/worktrees")
    def worktrees(request: Request):
        return {"worktrees": list_worktrees(scope(request))}

    @router.post("/worktrees")
    def worktree_create(request: Request, body: dict):
        owner = scope(request)
        workspace = body.get("workspace") if isinstance(body, dict) else None
        if not isinstance(workspace, str):
            raise HTTPException(400, "Workspace is required")
        return call(create_worktree, owner, workspace)

    @router.delete("/worktrees/{identifier}")
    def worktree_remove(request: Request, identifier: str):
        return call(remove_worktree, scope(request), identifier)

    @router.get("/verification")
    def verification_config(request: Request, workspace: str):
        return call(get_verification_config, scope(request), workspace)

    @router.put("/verification")
    def verification_config_save(request: Request, body: dict):
        owner = scope(request)
        data = body_object(body)
        workspace = data.get("workspace")
        if not isinstance(workspace, str):
            raise HTTPException(400, "Workspace is required")
        return call(save_verification_config, owner, workspace, data.get("checks"),
                    data.get("auto_run_on_completion", False))

    @router.post("/worktrees/{identifier}/verify")
    async def verification_run(request: Request, identifier: str):
        return await async_call(run_verification, scope(request), identifier)

    return router
