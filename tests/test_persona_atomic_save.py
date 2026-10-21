"""Persona cache edits become visible only after atomic persistence succeeds."""
import json
from pathlib import Path

from core import atomic_io
from src.preset_manager import PresetManager


def _manager(tmp_path):
    manager = PresetManager(str(tmp_path))
    assert manager.save({
        "custom": {
            "name": "Shared",
            "character_name": "Shared",
            "persona_memory": "custom before",
            "persona_memory_schema": "health",
            "enabled": True,
        },
        "user_templates": [
            {"id": "one", "name": "Shared", "persona_memory": "template before", "tag": 1},
            {"id": "two", "name": "Shared", "persona_memory": "template before", "tag": 2},
        ],
    })
    return manager


def _disk(manager):
    return json.loads(Path(manager.presets_file).read_text(encoding="utf-8"))


def _fail_writer(*args, **kwargs):
    raise PermissionError("synthetic read-only fixture")


def test_failed_custom_update_keeps_cache_and_disk_unchanged(tmp_path, monkeypatch):
    manager = _manager(tmp_path)
    before = _disk(manager)
    monkeypatch.setattr(atomic_io, "atomic_write_json", _fail_writer)

    assert manager.update_custom(
        0.4, 1200, "New prompt", name="New", enabled=True,
        persona_memory="new note", persona_memory_schema="general",
    ) is False
    assert manager.presets == before
    assert _disk(manager) == before


def test_custom_update_success_persists_candidate_and_refreshes_cache(tmp_path):
    manager = _manager(tmp_path)

    assert manager.update_custom(
        0.4, 1200, "New prompt", name="New", enabled=True,
        persona_memory="new note", persona_memory_schema="general",
    ) is True
    assert manager.presets["custom"]["character_name"] == "New"
    assert manager.presets["custom"]["persona_memory"] == "new note"
    assert _disk(manager) == manager.presets


def test_failed_persona_memory_update_keeps_cache_and_disk_unchanged(tmp_path, monkeypatch):
    manager = _manager(tmp_path)
    before = _disk(manager)
    monkeypatch.setattr(atomic_io, "atomic_write_json", _fail_writer)

    assert manager.update_persona_memory("Shared", " updated note ") is False
    assert manager.presets == before
    assert _disk(manager) == before


def test_persona_memory_success_updates_all_matching_entries(tmp_path):
    manager = _manager(tmp_path)

    assert manager.update_persona_memory(" Shared ", " updated note ") is True
    assert manager.presets["custom"]["persona_memory"] == "updated note"
    assert manager.presets["custom"]["persona_memory_schema"] == "health"
    assert [item["persona_memory"] for item in manager.presets["user_templates"]] == [
        "updated note", "updated note",
    ]
    assert [item["tag"] for item in manager.presets["user_templates"]] == [1, 2]
    assert _disk(manager) == manager.presets


def test_persona_memory_noop_does_not_write(tmp_path, monkeypatch):
    manager = _manager(tmp_path)
    assert manager.save({
        **manager.presets,
        "user_templates": [
            {**item, "persona_memory": "custom before"}
            for item in manager.presets["user_templates"]
        ],
    })
    before = manager.presets
    monkeypatch.setattr(atomic_io, "atomic_write_json", _fail_writer)

    assert manager.update_persona_memory("Shared", "custom before") is True
    assert manager.presets is before
