"""Native preview rejection logs expose categories, never supplied values."""
import json

import pytest

from src.tool_schemas import function_call_to_tool_block


@pytest.mark.parametrize(("arguments", "category", "env"), [
    ('{"project_path":"/private/secret-project"}', "invalid_project_path", {}),
    ('{"project_path":"safe","timeout":999}', "invalid_timeout", {}),
    ('{"project_path":"safe","api_key":"secret-token"}', "unknown_fields", {}),
    ("[\"/private/secret-project\"]", "not_object", {}),
    ("{not-json private secret}", "invalid_json", {}),
    ('{"project_path":"safe"}', "separate_executor_unavailable", {
        "ODYSSEUS_EXECUTOR_URL": "http://worker.invalid",
    }),
])
def test_rejections_log_only_fixed_category(monkeypatch, caplog, arguments, category, env):
    monkeypatch.delenv("ODYSSEUS_EXECUTOR_URL", raising=False)
    for key, value in env.items():
        monkeypatch.setenv(key, value)

    assert function_call_to_tool_block("native_preview", arguments) is None
    assert f"Rejected native_preview arguments ({category})" in caplog.text
    assert "/private/secret-project" not in caplog.text
    assert "secret-token" not in caplog.text
    assert "private secret" not in caplog.text


def test_valid_native_preview_still_converts_without_rejection_log(monkeypatch, caplog):
    monkeypatch.delenv("ODYSSEUS_EXECUTOR_URL", raising=False)
    block = function_call_to_tool_block(
        "native_preview", json.dumps({"project_path": "apps/desktop"}),
    )
    assert block is not None and block.tool_type == "bash"
    assert "Rejected native_preview arguments" not in caplog.text
