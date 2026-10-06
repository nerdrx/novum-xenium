"""Workspace API - browse server directories to pick a tool workspace folder."""
import os
from fastapi import APIRouter, Request, HTTPException, Query

from src.auth_helpers import get_current_user
from src.tool_security import owner_is_admin_or_single_user
from src.auth_helpers import is_delegated_credential, storage_owner_for_request
from core.middleware import INTERNAL_TOOL_HEADER
from src.owner_identity import INTERNAL_TOOL_USER
from routes.session_routes import _verify_session_owner
from src.workspace_snapshots import (
    SnapshotError, create_snapshot, list_snapshots, preview_snapshot, restore_snapshot,
)

# Cap entries returned per directory (mirrors filesystem_tools._CODENAV_MAX_HITS).
# A huge directory shouldn't dump thousands of rows into the picker; the user can
# type/paste a path to jump straight in instead.
_MAX_BROWSE_DIRS = 500


def setup_workspace_routes():
    router = APIRouter(prefix="/api/workspace", tags=["workspace"])

    def snapshot_scope(request: Request, workspace: str, session_id: str):
        if (request.headers.get(INTERNAL_TOOL_HEADER)
                or is_delegated_credential(request)
                or get_current_user(request) == INTERNAL_TOOL_USER):
            raise HTTPException(status_code=403, detail="Workspace snapshots require an interactive admin session")
        user = get_current_user(request)
        if not owner_is_admin_or_single_user(user):
            raise HTTPException(status_code=403, detail="Workspace snapshots are admin-only")
        owner = storage_owner_for_request(request)
        if not owner:
            raise HTTPException(status_code=401, detail="Workspace snapshot owner is unavailable")
        _verify_session_owner(request, session_id, getattr(request.app.state, "session_manager", None))
        from src.tool_execution import vet_workspace
        root = vet_workspace(workspace)
        if not root or root != os.path.realpath(workspace):
            raise HTTPException(status_code=400, detail="Workspace is no longer valid")
        return root, owner

    def snapshot_call(fn, *args):
        try:
            return fn(*args)
        except SnapshotError as exc:
            message = str(exc)
            raise HTTPException(status_code=409 if "changed after preview" in message else 400, detail=message)

    def snapshot_body(body):
        if not isinstance(body, dict):
            raise HTTPException(status_code=400, detail="Snapshot request must be an object")
        workspace, session_id = body.get("workspace"), body.get("session_id")
        if not isinstance(workspace, str) or not isinstance(session_id, str):
            raise HTTPException(status_code=400, detail="Workspace and session are required")
        return workspace, session_id

    @router.get("/snapshots")
    def get_snapshots(request: Request, workspace: str, session_id: str):
        root, owner = snapshot_scope(request, workspace, session_id)
        return {"snapshots": snapshot_call(list_snapshots, root, owner, session_id)}

    @router.post("/snapshots")
    async def post_snapshot(request: Request):
        body = await request.json()
        workspace, session_id = snapshot_body(body)
        root, owner = snapshot_scope(request, workspace, session_id)
        return snapshot_call(create_snapshot, root, owner, session_id, body.get("label"))

    @router.post("/snapshots/{snapshot_id}/preview")
    async def post_snapshot_preview(request: Request, snapshot_id: str):
        body = await request.json()
        workspace, session_id = snapshot_body(body)
        root, owner = snapshot_scope(request, workspace, session_id)
        return snapshot_call(preview_snapshot, root, owner, session_id, snapshot_id)

    @router.post("/snapshots/{snapshot_id}/restore")
    async def post_snapshot_restore(request: Request, snapshot_id: str):
        body = await request.json()
        workspace, session_id = snapshot_body(body)
        root, owner = snapshot_scope(request, workspace, session_id)
        return snapshot_call(
            restore_snapshot, root, owner, session_id, snapshot_id, body.get("expected_revision", "")
        )

    @router.get("/browse")
    def browse(request: Request, path: str = Query(default="")):
        """List subdirectories of `path` (default: home) so the UI can navigate
        the server filesystem and pick a workspace folder. Directories only.

        ADMIN-ONLY: this enumerates the server filesystem, so it is gated the
        same way the file/shell tools are (read_file/write_file/bash are in
        NON_ADMIN_BLOCKED_TOOLS). A non-admin who can't use those tools must not
        be able to map the host's directory tree either.
        """
        owner = get_current_user(request)
        if not owner_is_admin_or_single_user(owner):
            raise HTTPException(status_code=403, detail="Workspace browsing is admin-only")

        # Resolve symlinks so the reported path is canonical and the UI navigates
        # real directories (defends against symlink games in displayed paths).
        target = os.path.realpath(os.path.expanduser(path.strip() or "~"))
        if not os.path.isdir(target):
            target = os.path.realpath(os.path.expanduser("~"))

        dirs = []
        try:
            with os.scandir(target) as it:
                for entry in it:
                    try:
                        # Don't follow symlinks when classifying - a symlinked
                        # dir is skipped rather than letting the browser wander
                        # off via a link. Hidden entries are omitted.
                        if entry.is_dir(follow_symlinks=False) and not entry.name.startswith("."):
                            # Build the child path server-side with os.path.join
                            # so it's correct on Windows (backslashes) and Linux.
                            dirs.append({"name": entry.name, "path": os.path.join(target, entry.name)})
                    except OSError:
                        continue
        except (PermissionError, OSError):
            dirs = []

        dirs_sorted = sorted(dirs, key=lambda d: d["name"].lower())
        truncated = len(dirs_sorted) > _MAX_BROWSE_DIRS
        parent = os.path.dirname(target)
        from src.tool_execution import vet_workspace
        return {
            "path": target,
            "parent": parent if parent and parent != target else None,
            "dirs": dirs_sorted[:_MAX_BROWSE_DIRS],
            "truncated": truncated,
            # Whether this directory may be bound as a workspace (filesystem
            # roots and sensitive dirs may be browsed through but not chosen).
            "selectable": vet_workspace(target) is not None,
        }

    @router.get("/vet")
    def vet(request: Request, path: str = Query(default="")):
        """Validate a workspace path without binding it.

        The UI calls this before persisting a manually typed path (/workspace
        set) so a typo, file path, deleted folder, sensitive dir, or filesystem
        root is rejected up front with the canonical path returned on success,
        instead of being stored client-side and silently dropped at chat time.
        Admin-gated like /browse: it confirms path existence on the host.
        """
        owner = get_current_user(request)
        if not owner_is_admin_or_single_user(owner):
            raise HTTPException(status_code=403, detail="Workspace selection is admin-only")
        from src.tool_execution import vet_workspace
        resolved = vet_workspace(path)
        return {"ok": resolved is not None, "path": resolved}

    return router
