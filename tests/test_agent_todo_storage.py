import asyncio
import json

from src.agent_tools import coding_tools


def _write(todos, ctx):
    return asyncio.run(coding_tools.TodoWriteTool().execute(
        json.dumps({"todos": todos}), ctx,
    ))


def test_todos_restore_by_trusted_owner_and_session(monkeypatch, tmp_path):
    monkeypatch.setattr(coding_tools, "_TODO_DIR", str(tmp_path))
    todos = [{"content": "inspect", "status": "in_progress"}]
    assert _write(todos, {"owner": "alice", "session_id": "chat-a"})["exit_code"] == 0

    assert coding_tools.read_todos({"owner": "alice", "session_id": "chat-a"})[0]["content"] == "inspect"
    assert coding_tools.read_todos({"owner": "bob", "session_id": "chat-a"}) == []
    assert coding_tools.read_todos({"owner": "alice", "session_id": "chat-b"}) == []
    assert coding_tools.read_todos({"owner": "alice"}) == []


def test_todo_restore_bounds_and_never_reads_legacy_or_user_identity(monkeypatch, tmp_path):
    monkeypatch.setattr(coding_tools, "_TODO_DIR", str(tmp_path))
    todos = [{"content": "x" * 500} for _ in range(20)]
    assert _write(todos, {"owner": "alice", "session_id": "chat"})["exit_code"] == 0
    restored = coding_tools.read_todos({"owner": "alice", "session_id": "chat"})
    assert len(restored) == 20
    assert all(len(item["content"]) == 500 for item in restored)
    assert _write(todos + [{"content": "extra"}], {"owner": "alice", "session_id": "chat"})["exit_code"] == 1
    assert _write([{"content": "x" * 501}], {"owner": "alice", "session_id": "chat"})["exit_code"] == 1

    path = coding_tools._scoped_todo_path("alice", "chat")
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"todos": [
            {"content": "bad status", "status": "<bad>", "priority": "high"},
            {"content": "bad priority", "status": "pending", "priority": "<bad>"},
            {"content": "valid", "status": "completed", "priority": "low"},
            {"content": "unhashable", "status": [], "priority": {}},
        ]}, f)
    assert coding_tools.read_todos({"owner": "alice", "session_id": "chat"}) == [
        {"content": "valid", "status": "completed", "priority": "low"}
    ]

    with open(path, "wb") as f:
        f.write(b" " * (coding_tools._MAX_TODO_FILE_BYTES + 1))
    assert coding_tools.read_todos({"owner": "alice", "session_id": "chat"}) == []

    _write([{"content": "legacy"}], {"session_id": "legacy"})
    assert coding_tools.read_todos({"owner": "alice", "session_id": "legacy"}) == []
    assert _write([{"content": "forged"}], {
        "owner": "alice", "session_id": "trusted",
    })["exit_code"] == 0
    # A caller-supplied session_id cannot redirect trusted storage.
    asyncio.run(coding_tools.TodoWriteTool().execute(
        json.dumps({"session_id": "forged", "todos": [{"content": "bad"}]}),
        {"owner": "alice", "session_id": "trusted"},
    ))
    assert coding_tools.read_todos({"owner": "alice", "session_id": "forged"}) == []


def test_incognito_todos_are_neither_saved_nor_restored(monkeypatch, tmp_path):
    monkeypatch.setattr(coding_tools, "_TODO_DIR", str(tmp_path))
    ctx = {"owner": "alice", "session_id": "private", "incognito": True}
    result = _write([{"content": "private"}], ctx)
    assert result["exit_code"] == 0
    assert list(tmp_path.iterdir()) == []
    assert coding_tools.read_todos(ctx) == []
