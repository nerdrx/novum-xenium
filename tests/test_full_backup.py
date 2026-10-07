import io
import json
import os
import shutil
import sqlite3
import stat
import subprocess
import threading
import time
import zipfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.middleware.base import BaseHTTPMiddleware

import src.constants as constants
import src.full_backup as full_backup
import routes.backup_routes as backup_routes


_SQLITE_OPEN_SWAP_C = r"""
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdarg.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

int open64(const char *path, int flags, ...) {
    static int (*real_open64)(const char *, int, ...);
    if (!real_open64) real_open64 = dlsym(RTLD_NEXT, "open64");
    mode_t mode = 0;
    if (flags & O_CREAT) {
        va_list args;
        va_start(args, flags);
        mode = va_arg(args, int);
        va_end(args);
    }
    static int swapped = 0;
    const char *kind = getenv("NX_SWAP_KIND");
    const char *trigger = getenv("NX_SWAP_TRIGGER");
    const char *held = getenv("NX_SWAP_HELD");
    const char *outside = getenv("NX_SWAP_OUTSIDE");
    const char *parent = getenv("NX_SWAP_PARENT");
    const char *held_dir = getenv("NX_SWAP_HELD_DIR");
    if (!swapped && kind && trigger && held && outside && strcmp(path, trigger) == 0) {
        swapped = 1;
        if (strcmp(kind, "parent") == 0 && parent && held_dir) {
            if (rename(parent, held_dir) == 0) symlink(outside, parent);
        } else if (strcmp(kind, "wal") == 0) {
            if (rename(trigger, held) == 0) link(outside, trigger);
        } else if (strcmp(kind, "wal-alias") == 0) {
            if (rename(trigger, held) == 0 || errno == ENOENT) symlink(outside, trigger);
        } else if (strcmp(kind, "leaf") == 0) {
            if (rename(trigger, held) == 0) symlink(outside, trigger);
        }
    }
    return (flags & O_CREAT) ? real_open64(path, flags, mode) : real_open64(path, flags);
}
"""


@pytest.fixture(scope="session")
def sqlite_open_swap_shim(tmp_path_factory):
    compiler = shutil.which("cc")
    if os.name != "posix" or not Path("/proc/self/fd").is_dir() or not compiler:
        pytest.skip("SQLite path-swap regression requires POSIX cc")
    build = tmp_path_factory.mktemp("sqlite-open-swap")
    source = build / "open_swap.c"
    library = build / "open_swap.so"
    source.write_text(_SQLITE_OPEN_SWAP_C, encoding="utf-8")
    result = subprocess.run(
        [compiler, "-shared", "-fPIC", "-o", str(library), str(source), "-ldl"],
        capture_output=True, text=True, timeout=15,
    )
    assert result.returncode == 0, result.stderr
    return library


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
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA wal_autocheckpoint=0")
    conn.execute("CREATE TABLE chats (id TEXT PRIMARY KEY, body TEXT)")
    conn.execute("INSERT INTO chats VALUES ('chat-1', 'hello')")
    conn.commit()
    (data / "tmp").mkdir()
    (data / "tmp" / "active.lock").write_text("skip")
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
        conn.close()


def test_backup_prunes_excluded_models_before_scanning(tmp_path, monkeypatch):
    data = tmp_path / "data"
    excluded = data / "models"
    excluded_nested = excluded / "large-tree"
    excluded_nested.mkdir(parents=True)
    (excluded_nested / "weights.bin").write_bytes(b"excluded")
    (data / "settings.json").write_text("{}")
    scandir = os.scandir
    visited = []

    def reject_excluded(path):
        if isinstance(path, int):
            return scandir(path)
        candidate = Path(path)
        if candidate == excluded or excluded in candidate.parents:
            visited.append(candidate)
            raise AssertionError("backup descended into excluded model data")
        return scandir(path)

    monkeypatch.setattr(os, "scandir", reject_excluded)
    archive_path = full_backup.create_backup(data)
    try:
        with zipfile.ZipFile(archive_path) as archive:
            assert "data/settings.json" in archive.namelist()
            assert not any("models" in Path(name).parts for name in archive.namelist())
        assert visited == []
    finally:
        archive_path.unlink(missing_ok=True)


def test_backup_inventory_fails_closed_on_scandir_error(tmp_path, monkeypatch):
    data = tmp_path / "data"
    blocked = data / "blocked"
    blocked.mkdir(parents=True)
    (blocked / "state.json").write_text("{}")
    scandir = os.scandir

    def fail_blocked(path):
        if isinstance(path, int):
            return scandir(path)
        if Path(path) == blocked:
            raise PermissionError("simulated scan failure")
        return scandir(path)

    monkeypatch.setattr(os, "scandir", fail_blocked)
    with pytest.raises(PermissionError, match="simulated scan failure"):
        full_backup.create_backup(data)


def test_backup_skips_sqlite_created_after_snapshot_inventory(tmp_path, monkeypatch):
    data = tmp_path / "data"
    data.mkdir()
    first = data / "first.db"
    conn = sqlite3.connect(first)
    conn.execute("CREATE TABLE entries (value TEXT)")
    conn.execute("INSERT INTO entries VALUES (?)", ("staged value",))
    conn.commit(); conn.close()

    snapshot_sqlite = full_backup._snapshot_sqlite
    created = False
    live_connections = []

    def create_late_database(source, destination, source_fd=None, wal_fd=None, shm_fd=None, parent_fd=None):
        nonlocal created
        snapshot_sqlite(source, destination, source_fd, wal_fd, shm_fd, parent_fd)
        if not created:
            created = True
            late = sqlite3.connect(data / "late.db")
            late.execute("PRAGMA journal_mode=WAL")
            late.execute("CREATE TABLE entries (value TEXT)")
            late.execute("INSERT INTO entries VALUES (?)", ("committed in WAL",))
            late.commit()
            live_connections.append(late)

    monkeypatch.setattr(full_backup, "_snapshot_sqlite", create_late_database)
    archive_path = full_backup.create_backup(data)
    try:
        with zipfile.ZipFile(archive_path) as archive:
            assert "data/late.db" not in archive.namelist()
            restored = tmp_path / "restored-first.db"
            restored.write_bytes(archive.read("data/first.db"))
        restored_db = sqlite3.connect(restored)
        try:
            assert restored_db.execute("SELECT value FROM entries").fetchone() == ("staged value",)
        finally:
            restored_db.close()
    finally:
        for connection in live_connections:
            connection.close()
        archive_path.unlink(missing_ok=True)


def test_backup_rechecks_sqlite_symlink_before_snapshot(tmp_path, monkeypatch):
    data = tmp_path / "data"
    data.mkdir()
    database = data / "state.db"
    conn = sqlite3.connect(database)
    conn.execute("CREATE TABLE entries (value TEXT)")
    conn.commit(); conn.close()
    (data / "settings.json").write_text("{}")
    outside = tmp_path / "outside.db"
    conn = sqlite3.connect(outside)
    conn.execute("CREATE TABLE entries (value TEXT)")
    conn.execute("INSERT INTO entries VALUES (?)", ("outside",))
    conn.commit(); conn.close()

    is_file = Path.is_file
    swapped = False

    def swap_to_symlink(path):
        nonlocal swapped
        result = is_file(path)
        if path == database and not swapped:
            swapped = True
            database.unlink()
            database.symlink_to(outside)
        return result

    snapshots = []
    snapshot_sqlite = full_backup._snapshot_sqlite

    def record_snapshot(source, destination, source_fd=None, wal_fd=None, shm_fd=None, parent_fd=None):
        snapshots.append(source)
        snapshot_sqlite(source, destination, source_fd, wal_fd, shm_fd, parent_fd)

    monkeypatch.setattr(Path, "is_file", swap_to_symlink)
    monkeypatch.setattr(full_backup, "_snapshot_sqlite", record_snapshot)
    with pytest.raises(OSError):
        full_backup.create_backup(data)
    assert snapshots == []


def test_backup_reads_pinned_file_if_leaf_becomes_symlink(tmp_path, monkeypatch):
    data = tmp_path / "data"
    data.mkdir()
    target = data / "public.txt"
    target.write_text("in-workspace")
    target.chmod(0o640)
    os.utime(target, (1_700_000_000, 1_700_000_000))
    outside = tmp_path / "outside.txt"
    outside.write_text("outside-secret")
    original_open = zipfile.ZipFile.open
    swapped = False

    def swap_before_member_open(self, name, mode="r", *args, **kwargs):
        nonlocal swapped
        member_name = name.filename if isinstance(name, zipfile.ZipInfo) else name
        if mode == "w" and member_name == "data/public.txt" and not swapped:
            target.unlink()
            target.symlink_to(outside)
            swapped = True
        return original_open(self, name, mode, *args, **kwargs)

    monkeypatch.setattr(zipfile.ZipFile, "open", swap_before_member_open)
    archive_path = full_backup.create_backup(data)
    try:
        with zipfile.ZipFile(archive_path) as archive:
            assert swapped
            assert archive.read("data/public.txt") == b"in-workspace"
            member = archive.getinfo("data/public.txt")
            assert stat.S_IMODE(member.external_attr >> 16) == 0o640
            assert member.date_time == time.localtime(1_700_000_000)[:6]
    finally:
        archive_path.unlink(missing_ok=True)


def test_backup_stream_stops_at_existing_unpacked_limit(tmp_path, monkeypatch):
    data = tmp_path / "data"
    data.mkdir()
    (data / "large.txt").write_text("x" * 256)
    monkeypatch.setattr(full_backup, "MAX_UNPACKED_BYTES", 200)
    with pytest.raises(ValueError, match="40 GiB restore limit"):
        full_backup.create_backup(data)


def test_backup_file_count_limit_runs_before_sqlite_snapshot(tmp_path, monkeypatch):
    data = tmp_path / "data"
    data.mkdir()
    conn = sqlite3.connect(data / "state.db")
    conn.execute("CREATE TABLE entries (value TEXT)")
    conn.commit()
    conn.close()
    monkeypatch.setattr(full_backup, "MAX_FILES", 1)
    monkeypatch.setattr(
        full_backup, "_snapshot_sqlite",
        lambda *args: pytest.fail("SQLite staging started before the inventory limit"),
    )
    with pytest.raises(ValueError, match="too many entries"):
        full_backup.create_backup(data)


def test_backup_file_count_limit_stops_inventory_early(tmp_path, monkeypatch):
    data = tmp_path / "data"
    data.mkdir()
    for name in ("one.txt", "two.txt", "three.txt"):
        (data / name).write_text(name)
    original_is_file = Path.is_file
    visited = []

    def count_inventory(path):
        visited.append(path)
        return original_is_file(path)

    monkeypatch.setattr(Path, "is_file", count_inventory)
    monkeypatch.setattr(full_backup, "MAX_FILES", 1)
    with pytest.raises(ValueError, match="too many entries"):
        full_backup.create_backup(data)
    assert len(visited) == 1


def test_backup_rejects_file_replaced_with_fifo_without_blocking(tmp_path, monkeypatch):
    if not hasattr(os, "mkfifo"):
        pytest.skip("FIFO paths are POSIX-only")
    data = tmp_path / "data"
    data.mkdir()
    target = data / "candidate.txt"
    target.write_text("regular at inventory")
    original_open = full_backup._open_backup_file
    swapped = False

    def replace_with_fifo(root_fd, relative):
        nonlocal swapped
        if not swapped and relative == Path("candidate.txt"):
            target.unlink()
            os.mkfifo(target)
            swapped = True
        return original_open(root_fd, relative)

    monkeypatch.setattr(full_backup, "_open_backup_file", replace_with_fifo)
    with pytest.raises(ValueError, match="not a regular file"):
        full_backup.create_backup(data)
    assert swapped


def _sqlite_with_wal(path, *values):
    connection = sqlite3.connect(path)
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute("PRAGMA wal_autocheckpoint=0")
    connection.execute("CREATE TABLE entries (value TEXT)")
    connection.commit()
    connection.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    connection.executemany("INSERT INTO entries VALUES (?)", [(v,) for v in values])
    connection.commit()
    return connection


def _enable_sqlite_open_swap(monkeypatch, shim, kind, trigger, held, outside,
                             parent=None, held_dir=None):
    monkeypatch.setenv("LD_PRELOAD", str(shim))
    monkeypatch.setenv("NX_SWAP_KIND", kind)
    monkeypatch.setenv("NX_SWAP_TRIGGER", str(trigger))
    monkeypatch.setenv("NX_SWAP_HELD", str(held))
    monkeypatch.setenv("NX_SWAP_OUTSIDE", str(outside))
    if parent is not None:
        monkeypatch.setenv("NX_SWAP_PARENT", str(parent))
    if held_dir is not None:
        monkeypatch.setenv("NX_SWAP_HELD_DIR", str(held_dir))


def test_sqlite_snapshot_fd_reads_committed_wal_rows(tmp_path):
    source = tmp_path / "source.db"
    writer = _sqlite_with_wal(source, "visible-in-wal")
    root_fd = full_backup._open_backup_root(tmp_path)
    source_fd = full_backup._open_backup_file(root_fd, Path("source.db"))
    parent_fd = full_backup._open_backup_directory(root_fd, Path("."))
    wal_fd = full_backup._open_backup_file(root_fd, Path("source.db-wal"))
    shm_fd = full_backup._open_optional_backup_file(root_fd, Path("source.db-shm"))
    snapshot = tmp_path / "snapshot.db"
    try:
        assert Path(f"{source}-wal").stat().st_size > 0
        full_backup._snapshot_sqlite(source, snapshot, source_fd, wal_fd, shm_fd, parent_fd)
        with sqlite3.connect(snapshot) as copy:
            assert copy.execute("SELECT value FROM entries").fetchall() == [("visible-in-wal",)]
    finally:
        if shm_fd is not None:
            os.close(shm_fd)
        os.close(wal_fd)
        os.close(source_fd)
        os.close(parent_fd)
        os.close(root_fd)
        writer.close()


def test_sqlite_snapshot_handles_checkpointed_wal_database_without_sidecars(tmp_path):
    data = tmp_path / "data"
    data.mkdir()
    source = data / "idle.db"
    writer = _sqlite_with_wal(source, "checkpointed-row")
    writer.close()
    assert not Path(f"{source}-wal").exists()
    assert not Path(f"{source}-shm").exists()

    archive_path = full_backup.create_backup(data)
    try:
        with zipfile.ZipFile(archive_path) as archive:
            snapshot = tmp_path / "snapshot.db"
            snapshot.write_bytes(archive.read("data/idle.db"))
        with sqlite3.connect(snapshot) as db:
            assert db.execute("SELECT value FROM entries").fetchall() == [("checkpointed-row",)]
    finally:
        archive_path.unlink(missing_ok=True)


def test_sqlite_fd_snapshot_rejects_parent_symlink_swap(
    tmp_path, monkeypatch, sqlite_open_swap_shim,
):
    data = tmp_path / "data"
    source_dir = data / "workspace"
    source_dir.mkdir(parents=True)
    source = source_dir / "state.db"
    with sqlite3.connect(source) as db:
        db.execute("CREATE TABLE entries (value TEXT)")
        db.execute("INSERT INTO entries VALUES (?)", ("original-row",))
    outside = tmp_path / "outside"
    outside.mkdir()
    outside_db = outside / "state.db"
    with sqlite3.connect(outside_db) as db:
        db.execute("CREATE TABLE entries (value TEXT)")
        db.execute("INSERT INTO entries VALUES (?)", ("outside-secret",))
    moved_dir = data / "workspace-moved"
    _enable_sqlite_open_swap(
        monkeypatch, sqlite_open_swap_shim, "parent", source, moved_dir,
        outside, parent=source_dir, held_dir=moved_dir,
    )
    with pytest.raises(sqlite3.DatabaseError, match="identity verification"):
        full_backup.create_backup(data)
    assert source_dir.is_symlink()
    assert (moved_dir / "state.db").is_file()
    with sqlite3.connect(outside_db) as db:
        assert db.execute("SELECT value FROM entries").fetchall() == [("outside-secret",)]


def test_sqlite_fd_snapshot_rejects_leaf_symlink_swap(
    tmp_path, monkeypatch, sqlite_open_swap_shim,
):
    data = tmp_path / "data"
    data.mkdir()
    source = data / "state.db"
    with sqlite3.connect(source) as db:
        db.execute("CREATE TABLE entries (value TEXT)")
        db.execute("INSERT INTO entries VALUES (?)", ("original-row",))
    outside = tmp_path / "outside.db"
    with sqlite3.connect(outside) as db:
        db.execute("CREATE TABLE entries (value TEXT)")
        db.execute("INSERT INTO entries VALUES (?)", ("outside-secret",))
    moved = data / "held.db"
    _enable_sqlite_open_swap(
        monkeypatch, sqlite_open_swap_shim, "leaf", source, moved, outside,
    )
    with pytest.raises(sqlite3.DatabaseError):
        full_backup.create_backup(data)
    assert source.is_symlink()
    assert moved.is_file()
    with sqlite3.connect(outside) as db:
        assert db.execute("SELECT value FROM entries").fetchall() == [("outside-secret",)]


def test_sqlite_fd_snapshot_rejects_wal_hardlink_swap(
    tmp_path, monkeypatch, sqlite_open_swap_shim,
):
    data = tmp_path / "data"
    data.mkdir()
    source = data / "state.db"
    writer = _sqlite_with_wal(source, "original-wal-row")
    outside = tmp_path / "outside.db"
    outsider = _sqlite_with_wal(outside, "outside-secret")
    wal = Path(f"{source}-wal")
    moved_wal = data / "held-wal"
    outside_wal = Path(f"{outside}-wal")
    _enable_sqlite_open_swap(
        monkeypatch, sqlite_open_swap_shim, "wal", wal, moved_wal, outside_wal,
    )
    try:
        with pytest.raises(sqlite3.DatabaseError, match="identity verification"):
            full_backup.create_backup(data)
        assert wal.samefile(outside_wal)
        with sqlite3.connect(outside) as db:
            assert db.execute("SELECT value FROM entries").fetchall() == [("outside-secret",)]
    finally:
        if wal.exists():
            wal.unlink()
        if moved_wal.exists():
            moved_wal.replace(wal)
        writer.close()
        outsider.close()


def test_sqlite_fd_snapshot_rejects_unclassified_wal_alias(
    tmp_path, monkeypatch, sqlite_open_swap_shim,
):
    data = tmp_path / "data"
    data.mkdir()
    source = data / "state.db"
    source_writer = _sqlite_with_wal(source, "base-row")
    source_writer.close()
    assert not Path(f"{source}-wal").exists()

    outside = tmp_path / "outside.db"
    shutil.copyfile(source, outside)
    outsider = sqlite3.connect(outside)
    outsider.execute("PRAGMA journal_mode=WAL")
    outsider.execute("PRAGMA wal_autocheckpoint=0")
    outsider.execute("INSERT INTO entries VALUES (?)", ("outside-secret",))
    outsider.commit()
    alias = tmp_path / "outside.bin"
    Path(f"{outside}-wal").rename(alias)
    alias_before = alias.read_bytes()
    source_wal = Path(f"{source}-wal")
    held = data / "held-wal"
    _enable_sqlite_open_swap(
        monkeypatch, sqlite_open_swap_shim, "wal-alias", source_wal, held, alias,
    )
    try:
        with pytest.raises(sqlite3.DatabaseError, match="identity verification"):
            full_backup.create_backup(data)
        assert source_wal.is_symlink()
        assert source_wal.resolve() == alias
        assert alias.read_bytes() == alias_before
    finally:
        source_wal.unlink(missing_ok=True)
        held.unlink(missing_ok=True)
        outsider.close()


def test_backup_reads_pinned_file_if_parent_becomes_symlink(tmp_path, monkeypatch):
    data = tmp_path / "data"
    source_dir = data / "workspace"
    source_dir.mkdir(parents=True)
    (source_dir / "project.txt").write_text("in-workspace")
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "project.txt").write_text("outside-secret")
    moved_dir = data / "workspace-moved"
    original_open = zipfile.ZipFile.open
    swapped = False

    def swap_before_member_open(self, name, mode="r", *args, **kwargs):
        nonlocal swapped
        member_name = name.filename if isinstance(name, zipfile.ZipInfo) else name
        if mode == "w" and member_name == "data/workspace/project.txt" and not swapped:
            source_dir.rename(moved_dir)
            source_dir.symlink_to(outside, target_is_directory=True)
            swapped = True
        return original_open(self, name, mode, *args, **kwargs)

    monkeypatch.setattr(zipfile.ZipFile, "open", swap_before_member_open)
    archive_path = full_backup.create_backup(data)
    try:
        with zipfile.ZipFile(archive_path) as archive:
            assert swapped
            assert archive.read("data/workspace/project.txt") == b"in-workspace"
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


def test_concurrent_restore_staging_arms_one_existing_stage(tmp_path, monkeypatch):
    data = tmp_path / "data"
    data.mkdir()
    archives = []
    for value in ("first", "second"):
        archive = tmp_path / f"{value}.zip"
        archive.write_bytes(_zip_with([("data/value.txt", value.encode())]))
        archives.append(archive)

    original_extract = full_backup.extract_archive
    first_extract_started = threading.Event()
    release_first_extract = threading.Event()
    calls_lock = threading.Lock()
    calls = 0

    def pause_first_extract(archive, destination):
        nonlocal calls
        with calls_lock:
            calls += 1
            first = calls == 1
        if first:
            first_extract_started.set()
            assert release_first_extract.wait(timeout=2)
        return original_extract(archive, destination)

    monkeypatch.setattr(full_backup, "extract_archive", pause_first_extract)
    start = threading.Barrier(2)

    def stage(archive):
        start.wait(timeout=2)
        try:
            return full_backup.stage_restore(archive, data)
        except Exception as exc:
            return exc

    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(stage, archive) for archive in archives]
        assert first_extract_started.wait(timeout=2)
        try:
            # Give the competing request time to reach the pending-marker check.
            time.sleep(0.05)
        finally:
            release_first_extract.set()
        results = [future.result(timeout=3) for future in futures]

    successes = [result for result in results if isinstance(result, dict)]
    failures = [result for result in results if isinstance(result, ValueError)]
    assert len(successes) == len(failures) == 1
    assert calls == 1

    marker = json.loads((data / ".odysseus-restore-pending.json").read_text())
    stages = list(data.glob(".odysseus-restore-stage-*"))
    active_stage = data / f".odysseus-restore-stage-{marker['id']}"
    assert stages == [active_stage]
    assert (active_stage / "data" / "value.txt").read_text() in {"first", "second"}


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
