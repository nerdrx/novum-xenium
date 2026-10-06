import io
import json
import stat
import zipfile
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.middleware.base import BaseHTTPMiddleware

import src.constants as constants
import src.full_backup as full_backup
import routes.backup_routes as backup_routes


def _zip_with(entries):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as archive:
        archive.writestr(full_backup.MANIFEST, json.dumps({
            "format": "odysseus-full-backup", "version": 1,
        }))
        for name, content in entries:
            archive.writestr(name, content)
    return buf.getvalue()


def test_backup_contains_chat_workspace_uploads_and_settings(tmp_path):
    data = tmp_path / "data"
    expected = {
        "app.db": b"",  # replaced with a consistent SQLite snapshot below
        "sessions.json": b'{"chat":"saved"}',
        "agent_workspace/project.txt": b"workspace",
        "uploads/photo.png": b"uploaded",
        "generated_images/image.png": b"generated",
        "settings.json": b'{"theme":"dark"}',
        "memory.json": b'{"memories":[]}',
        ".app_key": b"opaque-key-bytes",
    }
    for name, content in expected.items():
        path = data / name
        path.parent.mkdir(parents=True, exist_ok=True)
        if name != "app.db":
            path.write_bytes(content)
    import sqlite3
    conn = sqlite3.connect(data / "app.db")
    conn.execute("CREATE TABLE chats (id TEXT PRIMARY KEY, body TEXT)")
    conn.execute("INSERT INTO chats VALUES ('chat-1', 'hello')")
    conn.commit(); conn.close()
    (data / "tmp").mkdir()
    (data / "tmp" / "active.lock").write_text("skip")
    (data / "app.db-wal").write_text("active SQLite journal")
    (data / "agent_workspace" / "running.lock").write_text("active lock")
    (data / "models").mkdir()
    (data / "models" / "huge.bin").write_bytes(b"skip")
    (data / "chroma").mkdir()
    (data / "chroma" / "live-index.bin").write_bytes(b"external service state")

    archive_path = full_backup.create_backup(data)
    try:
        with zipfile.ZipFile(archive_path) as archive:
            names = set(archive.namelist())
            for name in expected:
                assert f"data/{name}" in names
            assert not any("/tmp/" in name or "/models/" in name for name in names)
            assert not any("/chroma/" in name for name in names)
            assert "data/app.db-wal" not in names
            assert "data/agent_workspace/running.lock" not in names
            restored_db = tmp_path / "snapshot.db"
            restored_db.write_bytes(archive.read("data/app.db"))
            db = sqlite3.connect(restored_db)
            assert db.execute("SELECT body FROM chats").fetchone()[0] == "hello"
            db.close()
    finally:
        archive_path.unlink(missing_ok=True)


@pytest.mark.parametrize("entries", [
    [("../outside", b"bad")],
    [("/absolute", b"bad")],
    [("data\\outside", b"bad")],
])
def test_preview_rejects_traversal_paths(tmp_path, entries):
    path = tmp_path / "bad.zip"
    path.write_bytes(_zip_with(entries))
    with pytest.raises(ValueError, match="Unsafe archive path|outside data"):
        full_backup.inspect_archive(path)


def test_preview_rejects_symlink_and_corrupt_archives(tmp_path):
    link = tmp_path / "link.zip"
    with zipfile.ZipFile(link, "w") as archive:
        archive.writestr(full_backup.MANIFEST, json.dumps({"format": "odysseus-full-backup", "version": 1}))
        info = zipfile.ZipInfo("data/escape")
        info.create_system = 3
        info.external_attr = (stat.S_IFLNK | 0o777) << 16
        archive.writestr(info, "../../outside")
    with pytest.raises(ValueError, match="link or special"):
        full_backup.inspect_archive(link)
    corrupt = tmp_path / "corrupt.zip"
    corrupt.write_bytes(b"not a zip")
    with pytest.raises(ValueError, match="Invalid backup archive"):
        full_backup.inspect_archive(corrupt)


def test_preview_rejects_zip_bomb_ratio(tmp_path):
    path = tmp_path / "bomb.zip"
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(full_backup.MANIFEST, json.dumps({"format": "odysseus-full-backup", "version": 1}))
        archive.writestr("data/bomb.bin", b"a" * (2 * 1024 * 1024))
    with pytest.raises(ValueError, match="compression ratio"):
        full_backup.inspect_archive(path)


def test_stage_is_non_mutating_then_restore_roundtrips(tmp_path):
    data = tmp_path / "data"
    data.mkdir()
    (data / "sessions.json").write_text("old live state")
    archive = tmp_path / "restore.zip"
    archive.write_bytes(_zip_with([("data/sessions.json", b"restored chats"),
                                   ("data/agent_workspace/work.txt", b"workspace")]))

    preview = full_backup.stage_restore(archive, data)
    assert preview["files"] == 2
    assert (data / "sessions.json").read_text() == "old live state"
    assert full_backup.apply_pending_restore(data) is True
    assert (data / "sessions.json").read_text() == "restored chats"
    assert (data / "agent_workspace/work.txt").read_text() == "workspace"
    assert not (data / ".odysseus-restore-pending.json").exists()


def test_startup_recovers_interrupted_swap_before_retrying_restore(tmp_path):
    data = tmp_path / "data"
    data.mkdir()
    (data / "sessions.json").write_text("old chats")
    (data / "keep.json").write_text("old settings")
    archive = tmp_path / "restore.zip"
    archive.write_bytes(_zip_with([("data/sessions.json", b"restored chats"),
                                  ("data/keep.json", b"restored settings")]))
    full_backup.stage_restore(archive, data)

    marker = data / ".odysseus-restore-pending.json"
    state = json.loads(marker.read_text())
    state.update(status="applying", originals=["sessions.json", "keep.json"])
    rollback = data / f".odysseus-restore-rollback-{state['id']}"
    rollback.mkdir()
    (data / "sessions.json").replace(rollback / "sessions.json")
    (data / "sessions.json").write_text("partial new chats")
    (data / "unexpected-new-file").write_text("partial")
    marker.write_text(json.dumps(state))

    assert full_backup.apply_pending_restore(data) is True
    assert (data / "sessions.json").read_text() == "restored chats"
    assert (data / "keep.json").read_text() == "restored settings"
    assert not (data / "unexpected-new-file").exists()


def test_failed_install_restores_live_state_and_keeps_stage_retryable(tmp_path, monkeypatch):
    data = tmp_path / "data"
    data.mkdir()
    (data / "sessions.json").write_text("old chats")
    (data / "models").mkdir()
    (data / "models" / "weights.bin").write_bytes(b"large cache")
    (data / "chroma").mkdir()
    (data / "chroma" / "index.bin").write_bytes(b"service volume")
    archive = tmp_path / "restore.zip"
    archive.write_bytes(_zip_with([
        ("data/sessions.json", b"new chats"),
        ("data/settings.json", b"new settings"),
    ]))
    full_backup.stage_restore(archive, data)

    original_replace = full_backup.os.replace
    failed = False

    def fail_once(source, target):
        nonlocal failed
        if not failed and ".odysseus-restore-stage-" in str(source) and str(source).endswith("/settings.json"):
            failed = True
            raise OSError("simulated install failure")
        return original_replace(source, target)

    monkeypatch.setattr(full_backup.os, "replace", fail_once)
    with pytest.raises(OSError, match="simulated install failure"):
        full_backup.apply_pending_restore(data)

    assert (data / "sessions.json").read_text() == "old chats"
    assert (data / "models" / "weights.bin").read_bytes() == b"large cache"
    assert (data / "chroma" / "index.bin").read_bytes() == b"service volume"
    assert json.loads((data / ".odysseus-restore-pending.json").read_text())["status"] == "pending"

    monkeypatch.setattr(full_backup.os, "replace", original_replace)
    assert full_backup.apply_pending_restore(data) is True
    assert (data / "sessions.json").read_text() == "new chats"
    assert (data / "settings.json").read_text() == "new settings"
    assert (data / "models" / "weights.bin").read_bytes() == b"large cache"
    assert (data / "chroma" / "index.bin").read_bytes() == b"service volume"


class _AuthMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        user = request.headers.get("x-test-user")
        if user:
            request.state.current_user = user
        if request.headers.get("x-test-api-token"):
            request.state.api_token = True
        return await call_next(request)


class _Auth:
    is_configured = True
    def is_admin(self, username):
        return username == "admin"


@pytest.fixture
def backup_client(tmp_path, monkeypatch):
    data = tmp_path / "data"
    data.mkdir()
    (data / "sessions.json").write_text("chat")
    monkeypatch.setattr(constants, "DATA_DIR", str(data))
    monkeypatch.setattr(full_backup, "DATA_DIR", str(data))
    app = FastAPI()
    app.state.auth_manager = _Auth()
    app.add_middleware(_AuthMiddleware)
    app.include_router(backup_routes.setup_backup_routes(None, None, None))
    return TestClient(app), data


def test_full_backup_routes_reject_delegated_and_internal_callers(backup_client):
    client, _ = backup_client
    assert client.get("/api/backup/full", headers={"x-test-user": "admin", "x-test-api-token": "1"}).status_code == 403
    assert client.get("/api/backup/full", headers={backup_routes.INTERNAL_TOOL_HEADER: "anything"}).status_code == 403
    assert client.get("/api/backup/full", headers={"x-test-user": "member"}).status_code == 403


def test_full_backup_preview_and_stage_require_browser_admin(backup_client):
    client, data = backup_client
    headers = {"x-test-user": "admin"}
    backup = client.get("/api/backup/full", headers=headers)
    assert backup.status_code == 200
    upload_headers = {**headers, "Content-Type": "application/zip"}
    preview = client.post("/api/backup/preview", headers=upload_headers, content=backup.content)
    assert preview.status_code == 200, preview.text
    assert preview.json()["sensitive"] is True
    assert (data / "sessions.json").read_text() == "chat"
    staged = client.post("/api/backup/restore", headers=upload_headers, content=backup.content)
    assert staged.status_code == 200, staged.text
    assert staged.json()["restart_required"] is True
    assert (data / "sessions.json").read_text() == "chat"
