"""Conditional custom-preset saves reject stale revisions without losing edits."""
import asyncio
import copy
import json
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest
from starlette.middleware.base import BaseHTTPMiddleware

from core import atomic_io
from core.middleware import require_admin
from routes.preset_routes import setup_preset_routes
from src.preset_manager import PresetManager


def _fixture(tmp_path, *, revision=4):
    manager = PresetManager(str(tmp_path))
    custom = {
        "name": "A",
        "character_name": "A",
        "temperature": 0.4,
        "max_tokens": 1200,
        "system_prompt": "active A",
        "inject_prefix": "prefix",
        "inject_suffix": "suffix",
        "reasoning_mode": "on",
        "thinking_mode": "off",
        "show_persona_name": False,
        "enabled": True,
        "persona_memory": "retain me",
        "persona_memory_schema": "health",
    }
    assert manager.save({
        **manager.presets,
        "custom": custom,
        "custom_revision": revision,
    })
    app = FastAPI()
    app.include_router(setup_preset_routes(manager))
    app.dependency_overrides[require_admin] = lambda: None
    return app, manager, Path(manager.presets_file)


def _payload(name, prompt):
    return {
        "name": name,
        "enabled": True,
        "temperature": 0.8,
        "max_tokens": 2100,
        "system_prompt": prompt,
    }


def _template(template_id, name, prompt):
    return {
        "id": template_id,
        "name": name,
        "system_prompt": prompt,
        "temperature": 0.8,
        "max_tokens": 2100,
        "reasoning_mode": "auto",
        "thinking_mode": "",
        "persona_memory": "",
        "persona_memory_schema": "general",
    }


def test_stale_custom_save_waiting_before_handler_conflicts_without_write(tmp_path):
    app, manager, path = _fixture(tmp_path)
    entered = threading.Event()
    release = threading.Event()

    class HoldFirstSave(BaseHTTPMiddleware):
        async def dispatch(self, request, call_next):
            if request.url.path == "/api/presets/custom" and request.headers.get("x-hold-before-handler") == "1":
                entered.set()
                await asyncio.to_thread(release.wait, 10)
            return await call_next(request)

    app.add_middleware(HoldFirstSave)
    client_a = TestClient(app)
    client_b = TestClient(app)
    before_revision = manager.get_custom_revision()

    with ThreadPoolExecutor(max_workers=1) as pool:
        with client_a, client_b:
            old_save = pool.submit(
                client_a.post,
                f"/api/presets/custom?expected_custom_revision={before_revision}",
                json=_payload("A", "older A edit"),
                headers={"x-hold-before-handler": "1"},
            )
            assert entered.wait(5), "older save did not reach the pre-handler barrier"
            newer = client_b.post(
                f"/api/presets/custom?expected_custom_revision={before_revision}",
                json=_payload("B", "accepted B edit"),
            )
            assert newer.status_code == 200
            assert newer.json()["custom_revision"] == before_revision + 1
            accepted_cache = copy.deepcopy(manager.presets)
            accepted_disk = path.read_bytes()
            release.set()
            stale = old_save.result(timeout=10)

    assert stale.status_code == 409
    assert stale.json() == {
        "success": False,
        "message": "Persona settings changed; retry saving your preserved edits.",
        "custom_revision": before_revision + 1,
    }
    assert manager.presets == accepted_cache
    assert path.read_bytes() == accepted_disk
    assert manager.presets["custom"]["character_name"] == "B"
    assert manager.presets["custom"]["system_prompt"] == "accepted B edit"


def test_fifo_custom_saves_accept_successive_revisions(tmp_path):
    app, manager, path = _fixture(tmp_path)
    with TestClient(app) as client:
        first = client.post("/api/presets/custom?expected_custom_revision=4", json=_payload("A", "first"))
        second = client.post("/api/presets/custom?expected_custom_revision=5", json=_payload("B", "second"))

    assert first.status_code == 200
    assert first.json()["custom_revision"] == 5
    assert second.status_code == 200
    assert second.json()["custom_revision"] == 6
    assert manager.presets["custom"]["character_name"] == "B"
    assert manager.presets["custom"]["system_prompt"] == "second"
    assert json.loads(path.read_text(encoding="utf-8")) == manager.presets


def test_legacy_custom_save_without_revision_remains_accepted(tmp_path):
    app, manager, _path = _fixture(tmp_path)
    with TestClient(app) as client:
        response = client.post("/api/presets/custom", json=_payload("Legacy", "legacy body"))

    assert response.status_code == 200
    assert response.json()["custom_revision"] == 5
    assert manager.presets["custom"]["system_prompt"] == "legacy body"


def test_revision_guard_capability_is_advertised_without_persisting_it(tmp_path):
    app, manager, path = _fixture(tmp_path)
    with TestClient(app) as client:
        loaded = client.get("/api/presets")
        saved = client.post(
            "/api/presets/custom?expected_custom_revision=4",
            json=_payload("A", "capability control"),
        )

    assert loaded.status_code == 200
    assert loaded.json()["custom_save_revision_guard"] is True
    assert loaded.json()["custom_template_autosave"] is True
    assert saved.status_code == 200
    assert saved.json()["success"] is True
    assert saved.json()["custom_save_revision_guard"] is True
    assert saved.json()["custom_template_autosave"] is True
    assert "custom_save_revision_guard" not in manager.presets
    assert "custom_save_revision_guard" not in json.loads(path.read_text(encoding="utf-8"))


def test_bundled_custom_and_template_save_updates_cache_and_disk(tmp_path):
    app, manager, path = _fixture(tmp_path)
    template = _template("template-a", "A", "captured A template")

    with TestClient(app) as client:
        response = client.post(
            "/api/presets/custom?expected_custom_revision=4",
            json={**_payload("A", "active A"), "template_autosave": template},
        )

    assert response.status_code == 200
    body = response.json()
    assert body["success"] is True
    assert body["custom_revision"] == 5
    assert body["custom_template_autosave"] is True
    assert body["template_save"] == {"success": True, "template": template}
    assert manager.presets["custom"]["system_prompt"] == "active A"
    assert manager.get_user_templates() == [template]
    assert json.loads(path.read_text(encoding="utf-8")) == manager.presets


def test_custom_save_with_bundled_template_requires_revision_before_any_write(tmp_path):
    app, manager, path = _fixture(tmp_path)
    before_cache = copy.deepcopy(manager.presets)
    before_disk = path.read_bytes()

    with TestClient(app) as client:
        response = client.post(
            "/api/presets/custom",
            json={**_payload("A", "active A"), "template_autosave": _template("t-a", "A", "A")},
        )

    assert response.status_code == 422
    assert manager.presets == before_cache
    assert path.read_bytes() == before_disk


def test_malformed_bundled_template_is_rejected_before_custom_write(tmp_path):
    app, manager, path = _fixture(tmp_path)
    before_cache = copy.deepcopy(manager.presets)
    before_disk = path.read_bytes()

    with TestClient(app) as client:
        response = client.post(
            "/api/presets/custom?expected_custom_revision=4",
            json={**_payload("A", "active A"), "template_autosave": {"id": "missing-name"}},
        )

    assert response.status_code == 422
    assert manager.presets == before_cache
    assert path.read_bytes() == before_disk


def test_stale_bundled_save_does_not_write_its_template(tmp_path):
    app, manager, path = _fixture(tmp_path)
    entered = threading.Event()
    release = threading.Event()

    class HoldFirstSave(BaseHTTPMiddleware):
        async def dispatch(self, request, call_next):
            if request.url.path == "/api/presets/custom" and request.headers.get("x-hold-before-handler") == "1":
                entered.set()
                await asyncio.to_thread(release.wait, 10)
            return await call_next(request)

    app.add_middleware(HoldFirstSave)
    client_a = TestClient(app)
    client_b = TestClient(app)

    with ThreadPoolExecutor(max_workers=1) as pool:
        with client_a, client_b:
            old_save = pool.submit(
                client_a.post,
                "/api/presets/custom?expected_custom_revision=4",
                json={
                    **_payload("A", "older A edit"),
                    "template_autosave": _template("template-a", "A", "older A template"),
                },
                headers={"x-hold-before-handler": "1"},
            )
            assert entered.wait(5), "older bundled save did not reach the pre-handler barrier"
            newer = client_b.post(
                "/api/presets/custom?expected_custom_revision=4",
                json={
                    **_payload("B", "accepted B edit"),
                    "template_autosave": _template("template-b", "B", "accepted B template"),
                },
            )
            assert newer.status_code == 200
            release.set()
            stale = old_save.result(timeout=10)

    assert stale.status_code == 409
    assert manager.presets["custom"]["character_name"] == "B"
    assert manager.get_user_templates() == [_template("template-b", "B", "accepted B template")]
    assert json.loads(path.read_text(encoding="utf-8")) == manager.presets


def test_fifo_bundled_saves_keep_different_template_names(tmp_path):
    app, manager, path = _fixture(tmp_path)
    first_template = _template("template-a", "A", "A reusable")
    second_template = _template("template-b", "B", "B reusable")

    with TestClient(app) as client:
        first = client.post(
            "/api/presets/custom?expected_custom_revision=4",
            json={**_payload("A", "active A"), "template_autosave": first_template},
        )
        second = client.post(
            "/api/presets/custom?expected_custom_revision=5",
            json={**_payload("B", "active B"), "template_autosave": second_template},
        )

    assert first.status_code == second.status_code == 200
    assert first.json()["template_save"]["success"] is True
    assert second.json()["template_save"]["success"] is True
    assert manager.get_user_templates() == [first_template, second_template]
    assert manager.presets["custom"]["character_name"] == "B"
    assert json.loads(path.read_text(encoding="utf-8")) == manager.presets


@pytest.mark.parametrize("failure", ["false", "exception"])
def test_template_failure_does_not_turn_accepted_custom_save_into_failure(tmp_path, monkeypatch, failure):
    app, manager, path = _fixture(tmp_path)
    before_templates = copy.deepcopy(manager.get_user_templates())

    def fail_template(_template):
        if failure == "exception":
            raise PermissionError("synthetic template write failure")
        return False

    monkeypatch.setattr(manager, "save_user_template", fail_template)
    with TestClient(app) as client:
        response = client.post(
            "/api/presets/custom?expected_custom_revision=4",
            json={
                **_payload("B", "accepted custom edit"),
                "template_autosave": _template("template-b", "B", "reusable B"),
            },
        )

    assert response.status_code == 200
    body = response.json()
    assert body["success"] is True
    assert body["custom_revision"] == 5
    assert body["template_save"] == {"success": False, "message": "Failed to save reusable template"}
    assert manager.presets["custom"]["system_prompt"] == "accepted custom edit"
    assert manager.get_user_templates() == before_templates
    assert json.loads(path.read_text(encoding="utf-8"))["custom"]["system_prompt"] == "accepted custom edit"


def test_negative_custom_revision_is_rejected_without_mutation(tmp_path):
    app, manager, path = _fixture(tmp_path)
    before_cache = copy.deepcopy(manager.presets)
    before_disk = path.read_bytes()
    with TestClient(app) as client:
        response = client.post("/api/presets/custom?expected_custom_revision=-1", json=_payload("A", "bad"))

    assert response.status_code == 422
    assert manager.presets == before_cache
    assert path.read_bytes() == before_disk


def test_failed_conditional_custom_save_keeps_revision_cache_and_disk(tmp_path, monkeypatch):
    app, manager, path = _fixture(tmp_path)
    before_cache = copy.deepcopy(manager.presets)
    before_disk = path.read_bytes()

    def fail_write(*_args, **_kwargs):
        raise PermissionError("synthetic read-only fixture")

    monkeypatch.setattr(atomic_io, "atomic_write_json", fail_write)
    with TestClient(app) as client:
        response = client.post(
            "/api/presets/custom?expected_custom_revision=4",
            json={
                **_payload("B", "not saved"),
                "template_autosave": _template("template-b", "B", "not saved"),
            },
        )

    assert response.status_code == 200
    assert response.json()["success"] is False
    assert response.json()["message"] == "Failed to save preset"
    assert "template_save" not in response.json()
    assert manager.presets == before_cache
    assert path.read_bytes() == before_disk
    assert manager.get_custom_revision() == 4
