"""Persistence and request validation for the custom preset thinking mode."""

import asyncio
import json

import pytest
from pydantic import ValidationError

from routes.preset_routes import UserTemplateRequest, setup_preset_routes
from src.preset_manager import PresetManager
from src.request_models import PresetUpdateRequest


@pytest.mark.parametrize("mode", ["auto", "on", "off"])
def test_custom_preset_reasoning_mode_round_trips(tmp_path, mode):
    manager = PresetManager(str(tmp_path))
    assert manager.presets["custom"]["reasoning_mode"] == "auto"

    assert manager.update_custom(0.6, 1024, "Prompt", reasoning_mode=mode)
    reloaded = PresetManager(str(tmp_path))
    assert reloaded.presets["custom"]["reasoning_mode"] == mode


def test_legacy_custom_config_migrates_mode_without_clobbering_fields(tmp_path):
    original = {
        "name": "My persona",
        "character_name": "My persona",
        "temperature": 0.6,
        "max_tokens": 1024,
        "system_prompt": "Keep this prompt.",
        "enabled": True,
    }
    (tmp_path / "presets.json").write_text(
        json.dumps({"custom": original}), encoding="utf-8"
    )

    manager = PresetManager(str(tmp_path))

    assert manager.presets["custom"] == {**original, "reasoning_mode": "auto"}
    saved = json.loads((tmp_path / "presets.json").read_text(encoding="utf-8"))
    assert saved["custom"]["reasoning_mode"] == "auto"


@pytest.mark.parametrize("malformed_mode", [["on"], {"on": True}])
def test_malformed_stored_reasoning_mode_migrates_without_resetting_presets(
    tmp_path, malformed_mode
):
    custom = {
        "name": "Keep me",
        "system_prompt": "Preserve this custom prompt.",
        "reasoning_mode": malformed_mode,
        "enabled": True,
    }
    saved_builtin = {**PresetManager.DEFAULT_PRESETS["code_analyze"], "temperature": 0.42}
    (tmp_path / "presets.json").write_text(
        json.dumps({"custom": custom, "code_analyze": saved_builtin}), encoding="utf-8"
    )

    manager = PresetManager(str(tmp_path))

    assert manager.presets["custom"] == {**custom, "reasoning_mode": "auto"}
    assert manager.presets["code_analyze"] == saved_builtin
    assert json.loads((tmp_path / "presets.json").read_text(encoding="utf-8"))["custom"]["system_prompt"] == custom["system_prompt"]


def test_custom_update_rejects_non_string_reasoning_mode():
    manager = PresetManager.__new__(PresetManager)
    manager.presets = {}

    def save(presets):
        manager.presets = presets
        return True

    manager.save = save

    assert manager.update_custom(0.6, 1024, "Prompt", reasoning_mode={"on": True})
    assert manager.presets["custom"]["reasoning_mode"] == "auto"


def test_custom_preset_api_defaults_and_validates_reasoning_mode():
    assert PresetUpdateRequest().reasoning_mode == "auto"
    assert PresetUpdateRequest(reasoning_mode="on").reasoning_mode == "on"
    with pytest.raises(ValidationError):
        PresetUpdateRequest(reasoning_mode="sometimes")


def test_custom_preset_route_forwards_reasoning_mode():
    class Manager:
        presets = {"custom": {"reasoning_mode": "auto"}}

        def update_custom(self, *args):
            self.args = args
            return True

        def get_custom_revision(self):
            return 0

    manager = Manager()
    endpoint = next(
        route.endpoint for route in setup_preset_routes(manager).routes
        if route.path == "/api/presets/custom" and "POST" in route.methods
    )

    result = asyncio.run(endpoint(PresetUpdateRequest(reasoning_mode="off")))

    assert result["success"] is True
    # The route forwards reasoning_mode after the legacy seven preset fields,
    # before persona-memory and UI fields added later.
    assert manager.args[7] == "off"


def test_template_request_preserves_mode_and_legacy_defaults_to_auto():
    legacy = UserTemplateRequest(name="Legacy", system_prompt="Prompt")
    updated = UserTemplateRequest(name="Updated", reasoning_mode="on")

    assert legacy.reasoning_mode == "auto"
    assert updated.model_dump()["reasoning_mode"] == "on"
