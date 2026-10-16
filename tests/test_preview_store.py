import base64
import sqlite3
import threading

from src import preview_store


PNG = b"\x89PNG\r\n\x1a\n" + b"fixture"


def test_preview_store_is_private_scoped_bounded_and_expires(monkeypatch, tmp_path):
    monkeypatch.setattr(preview_store, "_DB", tmp_path / "history.sqlite3")
    encoded = base64.b64encode(PNG).decode()
    item = preview_store.add("alice", "chat-1", "browser", "Page", "image/png", encoded, now=100)
    assert item["expires_at"] == 100 + 7 * 86400
    assert preview_store.get("bob", "chat-1", item["id"], now=101) is None
    assert preview_store.get("alice", "chat-2", item["id"], now=101) is None
    assert preview_store.get("alice", "chat-1", item["id"], now=101) == (PNG, "image/png")
    assert len(preview_store.list_for("alice", "chat-1", now=101)[0]) == 1
    duplicate = preview_store.add("alice", "chat-1", "browser", "Page", "image/png", encoded, now=200)
    assert duplicate["id"] == item["id"]
    assert len(preview_store.list_for("alice", "chat-1", now=201)[0]) == 1
    assert preview_store.get("alice", "chat-1", item["id"], now=200 + 7 * 86400) is None
    assert preview_store.add("alice", "chat-1", "browser", "Page", "image/jpeg", encoded, now=300) is None
    assert preview_store.add("alice", "chat-1", "browser", "Page", "image/png", "a" * 4_200_000) is None
    db = sqlite3.connect(preview_store._DB)
    try:
        assert db.execute("PRAGMA secure_delete").fetchone()[0] == 1
    finally:
        db.close()


def test_delete_session_removes_its_previews(monkeypatch, tmp_path):
    monkeypatch.setattr(preview_store, "_DB", tmp_path / "history.sqlite3")
    encoded = base64.b64encode(PNG).decode()
    item = preview_store.add("alice", "chat-1", "desktop", "Desktop", "image/png", encoded)
    preview_store.add("alice", "chat-2", "desktop", "Desktop", "image/png", base64.b64encode(PNG + b"other").decode())
    assert preview_store.delete_session("chat-1") == 1
    assert preview_store.get("alice", "chat-1", item["id"]) is None
    assert len(preview_store.list_for("alice", "chat-2")[0]) == 1


def test_preview_pages_are_bounded_and_ordered(monkeypatch, tmp_path):
    monkeypatch.setattr(preview_store, "_DB", tmp_path / "history.sqlite3")
    for index in range(3):
        encoded = base64.b64encode(PNG + bytes([index])).decode()
        preview_store.add("alice", "chat-1", "browser", str(index), "image/png", encoded, now=100 + index)
    first, more = preview_store.list_for("alice", "chat-1", limit=2, offset=0, now=200)
    second, more_after = preview_store.list_for("alice", "chat-1", limit=2, offset=2, now=200)
    assert [item["title"] for item in first] == ["2", "1"]
    assert more and not more_after and [item["title"] for item in second] == ["0"]


def test_delete_fence_wins_over_inflight_preview_capture(monkeypatch, tmp_path):
    monkeypatch.setattr(preview_store, "_DB", tmp_path / "history.sqlite3")
    entered, release = threading.Event(), threading.Event()
    deleting = {"value": False}
    def pending(_session_id):
        entered.set()
        assert release.wait(2)
        return deleting["value"]
    monkeypatch.setattr("src.agent_runs._session_deletion_pending", pending)
    encoded = base64.b64encode(PNG).decode()
    event = 'data: {"type":"tool_output","browser_preview":{"state":"updated","screenshot":"data:image/png;base64,' + encoded + '"}}\n\n'
    result = []
    worker = threading.Thread(target=lambda: result.append(
        preview_store.record_sse_preview("alice", "chat-1", event)
    ))
    worker.start()
    assert entered.wait(2)
    deleting["value"] = True
    release.set()
    worker.join(2)
    assert not worker.is_alive()
    assert result == [None]
    assert preview_store.delete_session("chat-1") == 0
    assert preview_store.list_for("alice", "chat-1")[0] == []


def test_record_sse_preview_accepts_only_successful_preview_events(monkeypatch, tmp_path):
    monkeypatch.setattr(preview_store, "_DB", tmp_path / "history.sqlite3")
    encoded = base64.b64encode(PNG).decode()
    event = 'data: {"type":"tool_output","browser_preview":{"state":"updated","title":"Page","screenshot":"data:image/png;base64,' + encoded + '"}}\n\n'
    item = preview_store.record_sse_preview("alice", "chat-1", event)
    assert item and item["kind"] == "browser"
    assert preview_store.record_sse_preview("alice", "chat-1", "data: {bad}\n\n") is None
    failed = 'data: {"type":"tool_output","tool":"native_preview","exit_code":1,"screenshot":"data:image/png;base64,' + encoded + '"}\n\n'
    assert preview_store.record_sse_preview("alice", "chat-1", failed) is None
