"""Conditional active-persona deletion is atomic and revision scoped."""
import copy
import json
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

from core import atomic_io
from core.middleware import require_admin
from routes.preset_routes import setup_preset_routes
from src.preset_manager import PresetManager


def _fixture(tmp_path, *, active_name="A", revision=4, enabled=True):
    manager = PresetManager(str(tmp_path))
    custom = {
        "name": active_name or "Custom",
        "character_name": active_name,
        "temperature": 0.4,
        "max_tokens": 1200,
        "system_prompt": f"active {active_name}",
        "inject_prefix": "prefix",
        "inject_suffix": "suffix",
        "reasoning_mode": "on",
        "thinking_mode": "off",
        "show_persona_name": False,
        "enabled": enabled,
        "persona_memory": "preserve only when not deleting this active persona",
        "persona_memory_schema": "health",
        "unknown_custom_field": "preserve",
    }
    assert manager.save({
        **manager.presets,
        "custom": custom,
        "custom_revision": revision,
        "user_templates": [{"id": "template-a", "name": "A", "system_prompt": "template A"}],
    })
    app = FastAPI()
    app.include_router(setup_preset_routes(manager))
    app.dependency_overrides[require_admin] = lambda: None
    return TestClient(app), manager, Path(manager.presets_file)


def _disk(path):
    return json.loads(path.read_text(encoding="utf-8"))


def test_matching_revision_clears_active_persona_and_template_in_one_write(tmp_path):
    client, manager, path = _fixture(tmp_path)
    before = _disk(path)

    with client:
        assert client.get("/api/presets").json()["custom_revision"] == 4
        response = client.delete("/api/presets/templates/template-a?expected_custom_revision=4")

    assert response.status_code == 200
    assert response.json() == {"success": True, "custom_revision": 5}
    disk = _disk(path)
    assert disk == manager.presets
    assert disk["user_templates"] == []
    custom = disk["custom"]
    assert custom["character_name"] == ""
    assert custom["system_prompt"] == ""
    assert custom["enabled"] is False
    assert custom["persona_memory"] == ""
    assert custom["persona_memory_schema"] == "general"
    for key in ("temperature", "max_tokens", "inject_prefix", "inject_suffix", "reasoning_mode", "thinking_mode", "show_persona_name", "unknown_custom_field"):
        assert custom[key] == before["custom"][key]
    assert disk["custom_revision"] == 5


def test_stale_same_persona_revision_conflicts_without_mutation(tmp_path):
    client, manager, path = _fixture(tmp_path)
    with client:
        saved = client.post("/api/presets/custom", json={
            "name": "A", "enabled": True, "temperature": 0.7,
            "max_tokens": 2000, "system_prompt": "newer A",
        })
        assert saved.status_code == 200
        assert saved.json()["custom_revision"] == 5
        before_cache = copy.deepcopy(manager.presets)
        before_disk = path.read_bytes()
        stale_delete = client.delete("/api/presets/templates/template-a?expected_custom_revision=4")

    assert stale_delete.status_code == 409
    assert manager.presets == before_cache
    assert path.read_bytes() == before_disk
    assert manager.presets["user_templates"][0]["name"] == "A"
    assert manager.presets["custom"]["system_prompt"] == "newer A"


def test_newer_different_active_persona_survives_deleting_old_template(tmp_path):
    client, manager, path = _fixture(tmp_path)
    with client:
        newer = client.post("/api/presets/custom", json={
            "name": "B", "enabled": True, "temperature": 0.8,
            "max_tokens": 2100, "system_prompt": "newer B",
        })
        assert newer.status_code == 200
        assert newer.json()["custom_revision"] == 5
        deleted = client.delete("/api/presets/templates/template-a?expected_custom_revision=4")

    assert deleted.status_code == 200
    assert deleted.json() == {"success": True, "custom_revision": 5}
    assert manager.presets["user_templates"] == []
    assert manager.presets["custom"]["character_name"] == "B"
    assert manager.presets["custom"]["system_prompt"] == "newer B"
    assert _disk(path) == manager.presets


def test_legacy_delete_without_token_removes_only_template(tmp_path):
    client, manager, path = _fixture(tmp_path)
    with client:
        response = client.delete("/api/presets/templates/template-a")

    assert response.status_code == 200
    assert response.json() == {"success": True, "custom_revision": 4}
    assert manager.presets["user_templates"] == []
    assert manager.presets["custom"]["character_name"] == "A"
    assert manager.presets["custom"]["enabled"] is True
    assert manager.presets["custom_revision"] == 4
    assert _disk(path) == manager.presets


def test_legacy_presets_expose_zero_revision_without_migration_write(tmp_path):
    client, manager, path = _fixture(tmp_path)
    legacy = {key: value for key, value in manager.presets.items() if key != "custom_revision"}
    assert manager.save(legacy)
    before_disk = path.read_bytes()

    with client:
        response = client.get("/api/presets")

    assert response.status_code == 200
    assert response.json()["custom_revision"] == 0
    assert path.read_bytes() == before_disk
    assert "custom_revision" not in _disk(path)


def test_negative_expected_revision_is_rejected_without_mutation(tmp_path):
    client, manager, path = _fixture(tmp_path)
    before_cache = copy.deepcopy(manager.presets)
    before_disk = path.read_bytes()

    with client:
        response = client.delete("/api/presets/templates/template-a?expected_custom_revision=-1")

    assert response.status_code == 422
    assert manager.presets == before_cache
    assert path.read_bytes() == before_disk


def test_custom_revision_starts_at_zero_and_advances_only_after_successful_write(tmp_path, monkeypatch):
    client, manager, path = _fixture(tmp_path, active_name="", revision=0, enabled=False)
    with client:
        assert client.get("/api/presets").json()["custom_revision"] == 0
        saved = client.post("/api/presets/custom", json={
            "name": "A", "enabled": True, "temperature": 0.5,
            "max_tokens": 1500, "system_prompt": "saved A",
        })
        assert saved.json()["custom_revision"] == 1
        before_cache = copy.deepcopy(manager.presets)
        before_disk = path.read_bytes()

        def fail_write(*_args, **_kwargs):
            raise PermissionError("synthetic readonly fixture")

        monkeypatch.setattr(atomic_io, "atomic_write_json", fail_write)
        failed = client.post("/api/presets/custom", json={
            "name": "B", "enabled": True, "temperature": 0.9,
            "max_tokens": 3000, "system_prompt": "not saved",
        })

    assert failed.status_code == 200
    assert failed.json()["success"] is False
    assert manager.presets == before_cache
    assert manager.presets["custom_revision"] == 1
    assert path.read_bytes() == before_disk


def test_failed_conditional_delete_keeps_cache_disk_and_revision(tmp_path, monkeypatch):
    client, manager, path = _fixture(tmp_path)
    before_cache = copy.deepcopy(manager.presets)
    before_disk = path.read_bytes()

    def fail_write(*_args, **_kwargs):
        raise PermissionError("synthetic readonly fixture")

    monkeypatch.setattr(atomic_io, "atomic_write_json", fail_write)
    with client:
        response = client.delete("/api/presets/templates/template-a?expected_custom_revision=4")

    assert response.status_code == 200
    assert response.json() == {"success": False, "message": "Failed to delete template"}
    assert manager.presets == before_cache
    assert manager.presets["custom_revision"] == 4
    assert path.read_bytes() == before_disk
