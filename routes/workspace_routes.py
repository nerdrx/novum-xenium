"""Workspace API - browse server directories to pick a tool workspace folder."""
import mimetypes
import os
import stat
from urllib.parse import quote
from fastapi import APIRouter, Request, HTTPException, Query
from starlette.background import BackgroundTask
from starlette.responses import StreamingResponse
from starlette.concurrency import run_in_threadpool

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
_MAX_SEARCH_HITS = 100
_MAX_SEARCH_ENTRIES = 20_000


def _search_workspace(root: str, query: str):
    """Search visible filenames without following links or reading file data."""
    from src.tool_execution import _SENSITIVE_BASENAMES_CF, _SENSITIVE_FILE_PATTERNS_CF

    needle = query.casefold()
    results = []
    visited = 0
    truncated = False
    for directory, dirs, files, dir_fd in os.fwalk(root, topdown=True, follow_symlinks=False):
        safe_dirs = []
        for name in dirs:
            visited += 1
            if visited > _MAX_SEARCH_ENTRIES:
                truncated = True
                break
            if name.startswith(".") or name.casefold() in _SENSITIVE_BASENAMES_CF:
                continue
            try:
                mode = os.stat(name, dir_fd=dir_fd, follow_symlinks=False).st_mode
                if stat.S_ISDIR(mode):
                    safe_dirs.append(name)
            except OSError:
                continue
        dirs[:] = safe_dirs
        if truncated:
            break
        for name in files:
            visited += 1
            if visited > _MAX_SEARCH_ENTRIES:
                truncated = True
                break
            folded = name.casefold()
            if name.startswith(".") or folded in _SENSITIVE_BASENAMES_CF or folded in _SENSITIVE_FILE_PATTERNS_CF:
                continue
            if needle not in folded:
                continue
            try:
                info = os.stat(name, dir_fd=dir_fd, follow_symlinks=False)
                if not stat.S_ISREG(info.st_mode) or info.st_nlink > 1:
                    continue
            except OSError:
                continue
            if len(results) >= _MAX_SEARCH_HITS:
                truncated = True
                break
            path = os.path.join(directory, name)
            results.append({"name": name, "path": os.path.relpath(path, root)})
        if truncated:
            break
    results.sort(key=lambda item: item["path"].casefold())
    return results, truncated


def _open_workspace_file(root: str, relative: str):
    """Open a regular file beneath root using no-follow directory handles."""
    parts = relative.replace("\\", "/").split("/")
    if (not relative or relative.startswith(("/", "\\")) or
            any(part in ("", ".", "..") or part.startswith(".") for part in parts)):
        raise ValueError("Invalid workspace file path")
    if not hasattr(os, "O_NOFOLLOW") or not hasattr(os, "O_DIRECTORY"):
        raise ValueError("Safe file opening is unavailable")
    fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in parts[:-1]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
        file_fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | getattr(os, "O_NONBLOCK", 0), dir_fd=fd)
    finally:
        os.close(fd)
    if not stat.S_ISREG(os.fstat(file_fd).st_mode):
        os.close(file_fd)
        raise ValueError("Workspace result is not a regular file")
    file_stat = os.fstat(file_fd)
    from src.tool_execution import _is_denied_tool_path
    if file_stat.st_nlink > 1 or _is_denied_tool_path(os.path.realpath(os.path.join(root, *parts))):
        os.close(file_fd)
        raise ValueError("Workspace file is not available")
    return os.fdopen(file_fd, "rb")


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
        validate_scope = lambda: _verify_session_owner(
            request, session_id, getattr(request.app.state, "session_manager", None)
        )
        return root, owner, validate_scope

    def snapshot_call(fn, *args, **kwargs):
        try:
            return fn(*args, **kwargs)
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
        root, owner, validate_scope = snapshot_scope(request, workspace, session_id)
        return {"snapshots": snapshot_call(list_snapshots, root, owner, session_id,
                                            validate_scope=validate_scope)}

    @router.post("/snapshots")
    async def post_snapshot(request: Request):
        body = await request.json()
        workspace, session_id = snapshot_body(body)
        root, owner, validate_scope = snapshot_scope(request, workspace, session_id)
        return await run_in_threadpool(
            snapshot_call, create_snapshot, root, owner, session_id, body.get("label"),
            validate_scope=validate_scope,
        )

    @router.post("/snapshots/{snapshot_id}/preview")
    async def post_snapshot_preview(request: Request, snapshot_id: str):
        body = await request.json()
        workspace, session_id = snapshot_body(body)
        root, owner, validate_scope = snapshot_scope(request, workspace, session_id)
        return await run_in_threadpool(
            snapshot_call, preview_snapshot, root, owner, session_id, snapshot_id,
            validate_scope=validate_scope,
        )

    @router.post("/snapshots/{snapshot_id}/restore")
    async def post_snapshot_restore(request: Request, snapshot_id: str):
        body = await request.json()
        workspace, session_id = snapshot_body(body)
        root, owner, validate_scope = snapshot_scope(request, workspace, session_id)
        return await run_in_threadpool(
            snapshot_call, restore_snapshot, root, owner, session_id, snapshot_id,
            body.get("expected_revision", ""), validate_scope=validate_scope,
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

    def search_scope(request: Request, workspace: str):
        if (request.headers.get(INTERNAL_TOOL_HEADER)
                or is_delegated_credential(request)
                or get_current_user(request) == INTERNAL_TOOL_USER):
            raise HTTPException(status_code=403, detail="Workspace search requires an interactive admin session")
        if not owner_is_admin_or_single_user(get_current_user(request)):
            raise HTTPException(status_code=403, detail="Workspace search is admin-only")
        from src.tool_execution import vet_workspace
        root = vet_workspace(workspace)
        if not root or root != os.path.realpath(workspace):
            raise HTTPException(status_code=400, detail="Workspace is no longer valid")
        return root

    @router.get("/search")
    def search_files(request: Request, workspace: str, q: str = Query(min_length=2, max_length=128)):
        """Search filenames in the selected workspace, with bounded traversal."""
        q = q.strip()
        if len(q) < 2:
            raise HTTPException(status_code=422, detail="Enter at least two characters")
        root = search_scope(request, workspace)
        results, truncated = _search_workspace(root, q)
        for result in results:
            result["url"] = (
                f"/api/workspace/open?workspace={quote(root, safe='')}"
                f"&path={quote(result['path'], safe='')}"
            )
        return {"results": results, "truncated": truncated}

    @router.get("/open")
    def open_file(request: Request, workspace: str, path: str):
        """Download a search result after rechecking workspace confinement."""
        root = search_scope(request, workspace)
        try:
            handle = _open_workspace_file(root, path)
        except (OSError, ValueError):
            raise HTTPException(status_code=404, detail="Workspace file is unavailable")
        filename = quote(os.path.basename(path), safe="")
        media_type = mimetypes.guess_type(filename)[0] or "application/octet-stream"
        return StreamingResponse(
            iter(lambda: handle.read(64 * 1024), b""),
            media_type=media_type,
            headers={
                "Content-Disposition": f"attachment; filename*=UTF-8''{filename}",
                "X-Content-Type-Options": "nosniff",
            },
            background=BackgroundTask(handle.close),
        )

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

    @router.get("/default")
    def default_workspace(request: Request):
        """Return the explicitly configured backend workspace, if usable.

        WebUI has no local launch directory: it runs against this backend's
        filesystem. An explicit default gives it the same zero-setup behavior
        as TUI while keeping workspace access opt-in and server-vetted.
        """
        owner = get_current_user(request)
        if not owner_is_admin_or_single_user(owner):
            raise HTTPException(status_code=403, detail="Workspace default is admin-only")

        configured = os.environ.get("ODYSSEUS_WORKSPACE_DEFAULT", "").strip()
        if not configured:
            return {"ok": False, "path": None}

        from src.tool_execution import vet_workspace
        from src.workspace_paths import backend_workspace_path

        resolved = vet_workspace(backend_workspace_path(configured))
        return {"ok": resolved is not None, "path": resolved}

    return router
