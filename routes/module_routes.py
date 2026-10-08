"""Admin-managed, data-only workspace modules."""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, Body, Depends, File, HTTPException, Request, UploadFile
from starlette.responses import Response

from core.database import McpServer, SessionLocal
from core.middleware import require_admin
from src.auth_helpers import require_user
from src.constants import DATA_DIR
from src.module_store import MAX_PACKAGE_BYTES, ModulePackageError, ModuleStore


def _public_module(item: dict, configured: dict, mcp_manager=None) -> dict:
    servers = []
    server_ids = list(dict.fromkeys([*item.get("mcp_server_ids", []), *configured.keys()]))
    for server_id in server_ids:
        server = configured.get(server_id)
        status = None
        if server and mcp_manager:
            try:
                status = mcp_manager.get_server_status(server_id).get("status")
            except Exception:
                status = None
        servers.append({
            "id": server_id,
            "name": server.name if server else server_id,
            "configured": server is not None,
            "enabled": bool(server.is_enabled) if server else False,
            "status": status or ("configured" if server else "not_configured"),
            "manifest_match": bool(server and item.get("mcp")
                                    and server.transport == item["mcp"].get("transport")
                                    and server.url == item["mcp"].get("url")),
        })
    result = {
        "id": item["id"], "name": item["name"], "version": item["version"],
        "description": item.get("description", ""), "enabled": bool(item.get("enabled")),
        "panel_url": f"/api/modules/{item['id']}/panel" if item.get("enabled") and item.get("panel") else None,
        "mcp": item.get("mcp"), "mcp_servers": servers,
        "previous_version": (item.get("previous") or {}).get("version"),
    }
    return result


def setup_module_routes(data_dir: str | Path | None = None, mcp_manager=None) -> APIRouter:
    router = APIRouter(prefix="/api/modules", tags=["modules"])
    store = ModuleStore(data_dir or DATA_DIR)

    def configured_servers(ids, mcp=None):
        if not ids and not mcp:
            return {}
        db = SessionLocal()
        try:
            rows = db.query(McpServer).all() if mcp else db.query(McpServer).filter(McpServer.id.in_(ids)).all()
            wanted = {server.id: server for server in rows if server.id in ids}
            if mcp:
                wanted.update({server.id: server for server in rows
                               if server.transport == mcp.get("transport") and server.url == mcp.get("url")})
            return wanted
        finally:
            db.close()

    def translate_error(error: ModulePackageError):
        raise HTTPException(error.status_code, error.detail) from None

    @router.get("")
    def list_modules(request: Request, _user: str = Depends(require_user)):
        items = store.list()
        auth_manager = getattr(request.app.state, "auth_manager", None)
        user = getattr(request.state, "current_user", None)
        from src.owner_identity import auth_disabled
        is_admin = auth_disabled() or bool(auth_manager and user and auth_manager.is_admin(user))
        modules = []
        for item in items:
            configured = configured_servers(item.get("mcp_server_ids", []), item.get("mcp"))
            modules.append(_public_module(item, configured, mcp_manager))
        return {"modules": modules, "is_admin": is_admin}

    @router.post("/install")
    async def install_module(file: UploadFile = File(...), _admin: None = Depends(require_admin)):
        package = await file.read(MAX_PACKAGE_BYTES + 1)
        await file.close()
        try:
            item, updated = store.install(package)
            configured = configured_servers(item.get("mcp_server_ids", []), item.get("mcp"))
            return {"module": _public_module(item, configured, mcp_manager), "updated": updated}
        except ModulePackageError as error:
            translate_error(error)

    @router.post("/{module_id}/enabled")
    def set_module_enabled(module_id: str, payload: dict = Body(...), _admin: None = Depends(require_admin)):
        try:
            if not isinstance(payload, dict) or set(payload) != {"enabled"}:
                raise ModulePackageError(400, "Request must contain only enabled")
            item = store.set_enabled(module_id, payload["enabled"])
            configured = configured_servers(item.get("mcp_server_ids", []), item.get("mcp"))
            return {"module": _public_module(item, configured, mcp_manager)}
        except ModulePackageError as error:
            translate_error(error)

    @router.post("/{module_id}/rollback")
    def rollback_module(module_id: str, _admin: None = Depends(require_admin)):
        try:
            item = store.rollback(module_id)
            configured = configured_servers(item.get("mcp_server_ids", []), item.get("mcp"))
            return {"module": _public_module(item, configured, mcp_manager)}
        except ModulePackageError as error:
            translate_error(error)

    @router.delete("/{module_id}")
    def delete_module(module_id: str, _admin: None = Depends(require_admin)):
        try:
            store.delete(module_id)
            return {"ok": True}
        except ModulePackageError as error:
            translate_error(error)

    @router.get("/{module_id}/panel")
    def module_panel(module_id: str, _user: str = Depends(require_user)):
        try:
            content = store.read_panel(module_id)
            return Response(content, media_type="text/html; charset=utf-8", headers={"Cache-Control": "no-store"})
        except ModulePackageError as error:
            translate_error(error)

    @router.get("/{module_id}/assets/{asset_path:path}")
    def module_asset(module_id: str, asset_path: str, _user: str = Depends(require_user)):
        try:
            content, media_type = store.read_asset(module_id, f"assets/{asset_path}")
            return Response(content, media_type=media_type, headers={"Cache-Control": "private, max-age=300"})
        except ModulePackageError as error:
            translate_error(error)

    return router
