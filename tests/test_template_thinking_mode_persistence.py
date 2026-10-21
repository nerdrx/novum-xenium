"""Saved templates preserve the custom preset's thinking-mode contract."""
import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from core.middleware import require_admin
from routes.preset_routes import setup_preset_routes
from src.preset_manager import PresetManager


def _fixture(tmp_path):
    manager = PresetManager(str(tmp_path))
    app = FastAPI()
    app.include_router(setup_preset_routes(manager))
    app.dependency_overrides[require_admin] = lambda: None
    return TestClient(app), manager


@pytest.mark.parametrize("thinking_mode", ["on", "off", ""])
def test_template_thinking_mode_post_get_and_disk_round_trip(tmp_path, thinking_mode):
    client, manager = _fixture(tmp_path)
    payload = {
        "id": f"synthetic-{thinking_mode or 'empty'}",
        "name": f"Synthetic {thinking_mode or 'empty'}",
        "system_prompt": "synthetic only",
        "thinking_mode": thinking_mode,
    }

    with client:
        posted = client.post("/api/presets/templates", json=payload)
        assert posted.status_code == 200
        saved = posted.json()["template"]
        assert posted.json()["success"] is True
        assert all(saved[key] == value for key, value in payload.items())
        assert manager.get_user_templates() == [saved]

        fetched = client.get("/api/presets/templates")
        assert fetched.status_code == 200
        assert fetched.json() == [saved]
        assert json.loads((tmp_path / "presets.json").read_text(encoding="utf-8"))["user_templates"] == [saved]


def test_legacy_template_defaults_thinking_mode_to_empty(tmp_path):
    client, manager = _fixture(tmp_path)
    payload = {"id": "legacy", "name": "Legacy", "system_prompt": "synthetic only"}

    with client:
        posted = client.post("/api/presets/templates", json=payload)
        assert posted.status_code == 200
        saved = posted.json()["template"]
        assert saved["thinking_mode"] == ""
        assert manager.get_user_templates() == [saved]
        assert client.get("/api/presets/templates").json() == [saved]
        assert json.loads((tmp_path / "presets.json").read_text(encoding="utf-8"))["user_templates"] == [saved]


def test_invalid_template_thinking_mode_is_rejected_without_write(tmp_path):
    client, manager = _fixture(tmp_path)
    before_disk = (tmp_path / "presets.json").read_bytes()

    with client:
        response = client.post(
            "/api/presets/templates",
            json={"id": "invalid", "name": "Invalid", "thinking_mode": "sometimes"},
        )
        assert response.status_code == 422
        assert manager.get_user_templates() == []
        assert json.loads((tmp_path / "presets.json").read_text(encoding="utf-8")).get("user_templates", []) == []
        assert (tmp_path / "presets.json").read_bytes() == before_disk
