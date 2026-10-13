from __future__ import annotations

import asyncio
import json

from src.agent_tools import coding_tools
from src.tool_schemas import FUNCTION_TOOL_SCHEMAS


def _run(args, ctx):
    return asyncio.run(coding_tools.TodoWriteTool().execute(json.dumps(args), ctx))


def _packet():
    return {
        "objective": "Fix refresh behavior",
        "files": ["src/auth.py", "tests/test_auth.py"],
        "reproduce_command": "pytest -q tests/test_auth.py::test_refresh",
        "acceptance_command": "pytest -q tests/test_auth.py",
        "acceptance_condition": "All auth tests pass",
    }


def test_dispatcher_passes_selected_workspace_to_packet_validation(monkeypatch, tmp_path):
    from src.agent_tools import ToolBlock
    from src.tool_execution import execute_tool_block, NO_TOOL_SECURITY_CONTEXT

    monkeypatch.setattr(coding_tools, "_TODO_DIR", str(tmp_path / "todos"))
    packet = _packet()
    packet["files"] = [str(tmp_path / "src/auth.py")]
    content = json.dumps({"todos": [{"content": "Fix auth", "status": "in_progress"}],
                          "work_packet": packet})
    _, result = asyncio.run(execute_tool_block(
        ToolBlock("todowrite", content), workspace=str(tmp_path), owner="alice",
        session_id="dispatch", security_context=NO_TOOL_SECURITY_CONTEXT,
    ))
    assert result["exit_code"] == 0, result
    assert result["work_packet"]["files"] == ["src/auth.py"]
    assert packet["files"] == [str(tmp_path / "src/auth.py")]


def test_invalid_work_packet_does_not_persist_todos(monkeypatch, tmp_path):
    monkeypatch.setattr(coding_tools, "_TODO_DIR", str(tmp_path))
    invalid = _packet()
    invalid["files"] = ["../outside.py"]

    result = _run({"todos": [{"content": "edit auth", "status": "pending"}], "work_packet": invalid},
                  {"owner": "alice", "session_id": "chat"})

    assert result["exit_code"] == 1
    assert "work_packet" in result["error"]
    assert list(tmp_path.iterdir()) == []


def test_valid_work_packet_is_returned_but_not_persisted(monkeypatch, tmp_path):
    monkeypatch.setattr(coding_tools, "_TODO_DIR", str(tmp_path))
    packet = _packet()
    result = _run({"todos": [{"content": "edit auth", "status": "pending"}], "work_packet": packet},
                  {"owner": "alice", "session_id": "chat"})

    assert result["exit_code"] == 0
    assert result["work_packet"] == packet
    saved_path = coding_tools._scoped_todo_path("alice", "chat")
    with open(saved_path, encoding="utf-8") as saved:
        persisted = json.load(saved)
    assert "work_packet" not in persisted


def test_omitting_packet_preserves_todo_result_shape(monkeypatch, tmp_path):
    monkeypatch.setattr(coding_tools, "_TODO_DIR", str(tmp_path))
    result = _run({"todos": [{"content": "inspect", "status": "in_progress"}]},
                  {"owner": "alice", "session_id": "chat"})
    assert result["exit_code"] == 0
    assert "work_packet" not in result


def test_todowrite_schema_has_optional_bounded_work_packet():
    schema = next(
        item["function"]["parameters"] for item in FUNCTION_TOOL_SCHEMAS
        if item["function"]["name"] == "todowrite"
    )
    assert "work_packet" not in schema["required"]
    packet = schema["properties"]["work_packet"]
    assert packet["additionalProperties"] is False
    assert packet["properties"]["files"]["maxItems"] == 32



def test_verification_packet_roundtrip_and_unknown_fields_rejected(monkeypatch, tmp_path):
    monkeypatch.setattr(coding_tools, "_TODO_DIR", str(tmp_path))
    packet = dict(_packet(), mode="verify_existing")
    args = {"todos": [{"content": "Verify existing auth", "status": "in_progress"}], "work_packet": packet}
    ctx = {"owner": "alice", "session_id": "verify"}
    result = _run(args, ctx)
    assert result["exit_code"] == 0
    assert result["work_packet"] == packet
    packet["skip_checks"] = True
    assert _run(args, ctx)["exit_code"] == 1


def test_absolute_workspace_paths_return_canonical_packet_without_mutating_input(monkeypatch, tmp_path):
    monkeypatch.setattr(coding_tools, "_TODO_DIR", str(tmp_path / "todos"))
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    packet = _packet()
    packet["files"] = [str(workspace / "src/auth.py"), str(workspace / "tests/test_auth.py")]
    original = json.loads(json.dumps(packet))

    result = _run({"todos": [{"content": "fix auth"}], "work_packet": packet},
                  {"owner": "alice", "session_id": "absolute", "workspace": str(workspace)})

    assert result["exit_code"] == 0
    assert result["work_packet"]["files"] == ["src/auth.py", "tests/test_auth.py"]
    assert packet == original


def test_absolute_outside_workspace_and_symlink_escape_rejected(tmp_path, monkeypatch):
    monkeypatch.setattr(coding_tools, "_TODO_DIR", str(tmp_path / "todos"))
    workspace, outside = tmp_path / "workspace", tmp_path / "outside"
    workspace.mkdir()
    outside.mkdir()
    (workspace / "escape").symlink_to(outside, target_is_directory=True)
    for file_path in (str(outside / "secret.py"), "escape/secret.py", "../outside/secret.py"):
        packet = dict(_packet(), files=[file_path])
        result = _run({"todos": [{"content": "inspect"}], "work_packet": packet},
                      {"owner": "alice", "session_id": file_path, "workspace": str(workspace)})
        assert result["exit_code"] == 1
        assert "work_packet" in result["error"]
