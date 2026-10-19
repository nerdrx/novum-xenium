"""Interactive/local-native controls for owned inference engines."""
from __future__ import annotations

import asyncio
import ipaddress
from typing import Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict

from src.auth_helpers import is_delegated_credential
from routes.shell_routes import _require_admin


class ImageEngineAction(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    action: Literal["start", "stop", "refresh", "configure"]
    mode: Literal["auto", "cpu", "vulkan", "zvram"] | None = None
    auto_start: bool | None = None
    idle_seconds: int | None = None


def native_authorized(request, engine):
    """A native capability is local-only, never forwarded through a tunnel."""
    forwarded = ("cf-connecting-ip", "cf-ray", "cf-visitor", "x-forwarded-for",
                 "x-forwarded-host", "x-real-ip", "forwarded")
    try:
        local = bool(request.client and ipaddress.ip_address(request.client.host).is_loopback)
    except ValueError:
        local = False
    return bool(engine is not None and local and not request.headers.get("Origin")
                and not any(request.headers.get(key) for key in forwarded)
                and engine.native_authorized(request.headers.get("X-Novum-Engine-Token")))


def _engine(request):
    engine = getattr(request.app.state, "local_image_engine", None)
    if engine is None:
        raise HTTPException(503, "The local engine manager is starting.")
    if not native_authorized(request, engine):
        if is_delegated_credential(request):
            raise HTTPException(403, "Engine control requires interactive administration.")
        _require_admin(request)
    return engine


def setup_local_engine_routes():
    router = APIRouter()

    @router.get("/api/local-engines/image")
    async def status(request: Request):
        engine = _engine(request)
        return await asyncio.to_thread(engine.status)

    @router.post("/api/local-engines/image")
    async def action(request: Request, body: ImageEngineAction):
        engine = _engine(request)
        values = body.model_dump(exclude_none=True)
        selected = values.pop("action")
        if selected != "configure" and values:
            raise HTTPException(400, "Settings belong to the configure action.")
        try:
            if selected == "start":
                await asyncio.to_thread(engine.start)
            elif selected == "stop":
                await asyncio.to_thread(engine.configure, {"auto_start": False})
                await asyncio.to_thread(engine.stop, disable_endpoint=True)
            elif selected == "refresh":
                await asyncio.to_thread(engine.refresh)
            else:
                await asyncio.to_thread(engine.configure, values)
                await asyncio.to_thread(engine.refresh)
            return await asyncio.to_thread(engine.status)
        except (ValueError, OSError) as exc:
            raise HTTPException(409, str(exc)[:300]) from None

    return router
