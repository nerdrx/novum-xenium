"""Backup preset imports must not restore or overwrite local revision metadata."""
import json
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import core.atomic_io
import routes.backup_routes as backup_routes
from core.middleware import require_admin
from routes.preset_routes import setup_preset_routes
from src.preset_manager import PresetManager


def _client(tmp_path, monkeypatch):
    manager = PresetManager(str(tmp_path))
    app = FastAPI()
    app.include_router(setup_preset_routes(manager))
    app.include_router(backup_routes.setup_backup_routes(None, manager, None))
    app.dependency_overrides[require_admin] = lambda: None
    monkeypatch.setattr(backup_routes, "require_admin", lambda request: None)
    monkeypatch.setattr(backup_routes, "get_current_user", lambda request: "test-user")
    return TestClient(app), manager


def _custom(name, prompt):
    return {"name": name, "character_name": name, "system_prompt": prompt, "enabled": True}


def test_imported_custom_advances_local_revision_and_stale_delete_conflicts(tmp_path, monkeypatch):
    client, manager = _client(tmp_path, monkeypatch)
    manager.save_user_template({"id": "saved-a", "name": "A", "system_prompt": "template"})
    old_revision = manager.get_custom_revision()

    with client:
        imported = client.post("/api/import", json={"presets": {
            "custom": _custom("A", "restored A"), "custom_revision": old_revision,
        }})
        assert imported.status_code == 200
        assert imported.json()["imported"] == ["presets"]
        assert client.get("/api/presets").json()["custom_revision"] == old_revision + 1
        before = manager.presets.copy()
        stale = client.delete(
            f"/api/presets/templates/saved-a?expected_custom_revision={old_revision}"
        )

    assert stale.status_code == 409
    assert manager.presets == before
    assert manager.presets["custom"]["system_prompt"] == "restored A"
    assert manager.presets["user_templates"][0]["id"] == "saved-a"


@pytest.mark.parametrize("untrusted", [{"revision": 900}, [999]])
def test_import_ignores_non_numeric_or_untrusted_revision_shapes(tmp_path, monkeypatch, untrusted):
    client, manager = _client(tmp_path, monkeypatch)
    manager.save({**manager.presets, "custom_revision": 7})

    with client:
        response = client.post("/api/import", json={"presets": {
            "custom_revision": untrusted,
            "brainstorm": {"name": "Imported"},
        }})
        result = client.get("/api/presets").json()

    assert response.status_code == 200
    assert result["custom_revision"] == 7
    assert manager.presets["custom_revision"] == 7
    assert manager.presets["brainstorm"] == {"name": "Imported"}


@pytest.mark.parametrize("preset_payload", [
    pytest.param({"code_analyze": {"name": "Imported"}}, id="absent-custom"),
    pytest.param({"custom": None}, id="null-custom"),
])
def test_import_without_custom_does_not_advance_revision(tmp_path, monkeypatch, preset_payload):
    client, manager = _client(tmp_path, monkeypatch)
    manager.save({**manager.presets, "custom_revision": 7})
    before_custom = manager.presets["custom"].copy()

    with client:
        response = client.post("/api/import", json={"presets": preset_payload})
        result = client.get("/api/presets").json()

    assert response.status_code == 200
    assert result["custom_revision"] == 7
    assert manager.presets["custom_revision"] == 7
    assert result["custom"] == before_custom
    if "code_analyze" in preset_payload:
        assert result["code_analyze"] == {"name": "Imported"}


@pytest.mark.parametrize("invalid_custom", [[], "not-an-object"])
def test_import_rejects_nonobject_custom_without_mutation(tmp_path, monkeypatch, invalid_custom):
    client, manager = _client(tmp_path, monkeypatch)
    manager.save({**manager.presets, "custom_revision": 12})
    before_cache = json.loads(json.dumps(manager.presets))
    path = Path(manager.presets_file)
    before_disk = path.read_bytes()

    with client:
        response = client.post("/api/import", json={"presets": {"custom": invalid_custom}})

    assert response.status_code == 400
    assert response.json()["detail"] == "Preset custom must be a JSON object"
    assert manager.presets == before_cache
    assert path.read_bytes() == before_disk
    assert manager.get_custom_revision() == 12


def test_failed_custom_import_reports_failure_without_cache_or_disk_change(tmp_path, monkeypatch):
    client, manager = _client(tmp_path, monkeypatch)
    manager.save({**manager.presets, "custom_revision": 12})
    before_cache = json.loads(json.dumps(manager.presets))
    path = Path(manager.presets_file)
    before_disk = path.read_bytes()

    monkeypatch.setattr(core.atomic_io, "atomic_write_json", lambda *args, **kwargs: (_ for _ in ()).throw(OSError("disk full")))
    with client:
        response = client.post("/api/import", json={"presets": {
            "custom": _custom("A", "restored A"), "custom_revision": 999,
        }})

    assert response.status_code == 500
    assert "Presets were not saved" in response.json()["detail"]
    assert "earlier backup sections may already have been imported" in response.json()["detail"]
    assert manager.presets == before_cache
    assert path.read_bytes() == before_disk
    assert manager.get_custom_revision() == 12
