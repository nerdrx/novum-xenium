"""Group preset updates stay consistent when atomic persistence fails."""
import asyncio
import json

import httpx
from fastapi import FastAPI

import core.atomic_io as atomic_io
from core.middleware import require_admin
from routes.preset_routes import setup_preset_routes
from src.preset_manager import PresetManager


def test_group_preset_route_reports_failed_save_and_preserves_cache(tmp_path, monkeypatch):
    manager = PresetManager(str(tmp_path))
    app = FastAPI()
    app.include_router(setup_preset_routes(manager))
    app.dependency_overrides[require_admin] = lambda: None
    target = tmp_path / "presets.json"
    before_disk = target.read_bytes()
    before_groups = manager.get_group_presets()
    failed_groups = [{"name": "synthetic failed group", "models": ["fixture-a"]}]
    successful_groups = [{"name": "synthetic saved group", "models": ["fixture-b"]}]
    original_writer = atomic_io.atomic_write_json

    def fail_write(*_args, **_kwargs):
        raise PermissionError("synthetic preset write failure")

    async def exercise_route():
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://fixture"
        ) as client:
            failed_post = await client.post(
                "/api/presets/groups", json={"groups": failed_groups}
            )
            failed_get = await client.get("/api/presets/groups")

            assert failed_post.status_code == 500
            assert failed_post.json() == {"detail": "Failed to save group presets"}
            assert target.read_bytes() == before_disk
            assert manager.get_group_presets() == before_groups
            assert failed_get.json() == {"groups": before_groups}

            monkeypatch.setattr(atomic_io, "atomic_write_json", original_writer)
            saved_post = await client.post(
                "/api/presets/groups", json={"groups": successful_groups}
            )
            saved_get = await client.get("/api/presets/groups")

            assert saved_post.status_code == 200
            assert saved_post.json() == {"ok": True}
            assert json.loads(target.read_text(encoding="utf-8"))["group_presets"] == successful_groups
            assert manager.get_group_presets() == successful_groups
            assert saved_get.json() == {"groups": successful_groups}

    monkeypatch.setattr(atomic_io, "atomic_write_json", fail_write)
    try:
        asyncio.run(exercise_route())
    finally:
        monkeypatch.setattr(atomic_io, "atomic_write_json", original_writer)
