import json

from src.tool_parsing import _TOOL_NAME_MAP
from src.tool_schemas import FUNCTION_TOOL_SCHEMAS, function_call_to_tool_block
from src.tool_security import tool_policy_names


def test_native_preview_is_discoverable_and_uses_bash_policy():
    schema = next(item["function"] for item in FUNCTION_TOOL_SCHEMAS
                  if item["function"]["name"] == "native_preview")
    assert schema["parameters"]["required"] == ["project_path"]
    assert schema["parameters"]["additionalProperties"] is False
    assert "native_preview" not in _TOOL_NAME_MAP
    assert tool_policy_names("native_preview") == frozenset({"native_preview", "bash"})


def test_native_preview_builds_fixed_shell_command_with_bounded_args(monkeypatch):
    monkeypatch.delenv("ODYSSEUS_EXECUTOR_URL", raising=False)
    block = function_call_to_tool_block("native_preview", json.dumps({
        "project_path": "apps/desktop app",
        "test_script": "tests/smoke; harmless.mjs",
        "timeout": 45,
        "no_sandbox": True,
    }))
    assert block is not None and block.tool_type == "bash"
    assert block.content.startswith("node /app/scripts/electron_preview.mjs --workspace-bound ")
    assert "--workspace 'apps/desktop app'" in block.content
    assert "--test-script 'tests/smoke; harmless.mjs'" in block.content
    assert "--timeout 45" in block.content
    assert block.content.endswith("--no-sandbox")


def test_native_preview_rejects_bad_types_paths_and_extra_fields(monkeypatch):
    monkeypatch.delenv("ODYSSEUS_EXECUTOR_URL", raising=False)
    invalid = [
        [],
        {"project_path": ""},
        {"project_path": "/tmp/app"},
        {"project_path": "../app"},
        {"project_path": "app/../other"},
        {"project_path": "app", "test_script": "../../outside.mjs"},
        {"project_path": "app", "timeout": True},
        {"project_path": "app", "timeout": 46},
        {"project_path": "app", "timeout": "20"},
        {"project_path": "app", "no_sandbox": 1},
        {"project_path": "app", "command": "rm -rf /"},
    ]
    for arguments in invalid:
        assert function_call_to_tool_block("native_preview", json.dumps(arguments)) is None


def test_native_preview_fails_closed_when_executor_is_configured(monkeypatch):
    monkeypatch.setenv("ODYSSEUS_EXECUTOR_URL", "http://worker.invalid")
    assert function_call_to_tool_block(
        "native_preview", '{"project_path":"."}'
    ) is None
