"""User-template changes must not enter the cache before atomic persistence."""
import json
from pathlib import Path

from core import atomic_io
from src.preset_manager import PresetManager


def _manager_with_template(tmp_path):
    manager = PresetManager(str(tmp_path))
    assert manager.save({
        "custom": {"name": "Custom"},
        "user_templates": [{"id": "existing", "name": "Before"}],
    })
    return manager


def _state(manager):
    return manager.presets, json.loads(Path(manager.presets_file).read_text(encoding="utf-8"))


def test_failed_add_update_delete_leave_cache_and_disk_unchanged(tmp_path, monkeypatch):
    manager = _manager_with_template(tmp_path)
    before = json.loads(Path(manager.presets_file).read_text(encoding="utf-8"))

    def fail_write(*args, **kwargs):
        raise PermissionError("synthetic read-only fixture")

    monkeypatch.setattr(atomic_io, "atomic_write_json", fail_write)

    assert manager.save_user_template({"id": "new", "name": "Added"}) is False
    assert _state(manager) == (before, before)

    assert manager.save_user_template({"id": "existing", "name": "Changed"}) is False
    assert _state(manager) == (before, before)

    assert manager.delete_user_template("existing") is False
    assert _state(manager) == (before, before)


def test_successful_add_update_delete_persist_and_refresh_cache(tmp_path):
    manager = _manager_with_template(tmp_path)

    assert manager.save_user_template({"id": "new", "name": "Added"}) is True
    assert {item["id"] for item in manager.presets["user_templates"]} == {"existing", "new"}
    assert json.loads(Path(manager.presets_file).read_text(encoding="utf-8")) == manager.presets

    assert manager.save_user_template({"id": "existing", "name": "Changed"}) is True
    assert next(item for item in manager.presets["user_templates"] if item["id"] == "existing")["name"] == "Changed"
    assert json.loads(Path(manager.presets_file).read_text(encoding="utf-8")) == manager.presets

    assert manager.delete_user_template("new") is True
    assert [item["id"] for item in manager.presets["user_templates"]] == ["existing"]
    assert json.loads(Path(manager.presets_file).read_text(encoding="utf-8")) == manager.presets
