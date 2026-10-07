import os

import pytest

from src import workspace_snapshots as snapshots


@pytest.fixture
def ws(tmp_path, monkeypatch):
    root = tmp_path / "workspace"
    root.mkdir()
    monkeypatch.setattr(snapshots, "_ROOT", tmp_path / "snapshot-data")
    return root


@pytest.mark.parametrize("walker_name", ["walk", "fwalk"])
def test_snapshot_fails_closed_when_tree_walker_reports_error(ws, monkeypatch, walker_name):
    if walker_name == "fwalk" and not snapshots._supports_safe_restore():
        pytest.skip("descriptor-relative traversal is unavailable")
    (ws / "visible.txt").write_text("content")
    original = getattr(snapshots.os, walker_name)

    def fail_walk(*args, **kwargs):
        kwargs["onerror"](PermissionError("injected directory read failure"))
        yield from original(*args, **kwargs)

    monkeypatch.setattr(snapshots.os, walker_name, fail_walk)
    if walker_name == "walk":
        monkeypatch.setattr(snapshots, "_supports_safe_restore", lambda: False)

    with pytest.raises(snapshots.SnapshotError, match="could not be read"):
        snapshots.create_snapshot(str(ws), "alice", "chat-1")
    assert snapshots.list_snapshots(str(ws), "alice", "chat-1") == []


def test_preview_and_restore_add_edit_delete(ws):
    (ws / "edit.txt").write_text("before\n")
    (ws / "gone.txt").write_text("gone")
    saved = snapshots.create_snapshot(str(ws), "alice", "chat-1")
    (ws / "edit.txt").write_text("after\n")
    (ws / "gone.txt").unlink()
    (ws / "new.txt").write_text("new")

    preview = snapshots.preview_snapshot(str(ws), "alice", "chat-1", saved["id"])
    assert {c["status"] for c in preview["changes"]} == {"modified", "deleted", "added"}
    result = snapshots.restore_snapshot(str(ws), "alice", "chat-1", saved["id"], preview["revision"])
    assert (ws / "edit.txt").read_text() == "before\n"
    assert (ws / "gone.txt").read_text() == "gone"
    assert not (ws / "new.txt").exists()
    assert snapshots.list_snapshots(str(ws), "alice", "chat-1")
    assert result["rollback_snapshot_id"] != saved["id"]


def test_snapshot_binding_owner_session_and_path(ws, tmp_path):
    saved = snapshots.create_snapshot(str(ws), "alice", "chat-1")
    for owner, session, path in (
        ("bob", "chat-1", ws), ("alice", "chat-2", ws),
        ("alice", "chat-1", tmp_path / "other"),
    ):
        path.mkdir(exist_ok=True)
        with pytest.raises(snapshots.SnapshotError):
            snapshots.preview_snapshot(str(path), owner, session, saved["id"])


def test_symlink_and_dependency_exclusions(ws, tmp_path):
    outside = tmp_path / "outside.txt"
    outside.write_text("keep")
    (ws / "link.txt").symlink_to(outside)
    (ws / "node_modules").mkdir()
    (ws / "node_modules" / "ignored.js").write_text("dependency")
    (ws / ".env").write_text("SECRET=value")
    (ws / "private.pem").write_text("private key")
    (ws / "visible.txt").write_text("visible")
    saved = snapshots.create_snapshot(str(ws), "alice", "chat-1")
    record = snapshots._read_manifest(snapshots._store(str(ws), "alice", "chat-1"), saved["id"], snapshots._identity(str(ws), "alice", "chat-1")[1])
    assert set(record["files"]) == {"visible.txt"}
    preview = snapshots.preview_snapshot(str(ws), "alice", "chat-1", saved["id"])
    snapshots.restore_snapshot(str(ws), "alice", "chat-1", saved["id"], preview["revision"])
    assert (ws / "link.txt").is_symlink()
    assert outside.read_text() == "keep"


def test_stale_preview_rejected(ws):
    path = ws / "a.txt"
    path.write_text("one")
    saved = snapshots.create_snapshot(str(ws), "alice", "chat-1")
    preview = snapshots.preview_snapshot(str(ws), "alice", "chat-1", saved["id"])
    path.write_text("two")
    with pytest.raises(snapshots.SnapshotError, match="changed after preview"):
        snapshots.restore_snapshot(str(ws), "alice", "chat-1", saved["id"], preview["revision"])
    assert path.read_text() == "two"


def test_missing_directories_are_recreated_on_restore(ws):
    nested = ws / "a" / "a"
    nested.mkdir(parents=True)
    (nested / "file.txt").write_text("saved")
    saved = snapshots.create_snapshot(str(ws), "alice", "chat-1")
    (nested / "file.txt").unlink()
    nested.rmdir(); (ws / "a").rmdir()
    preview = snapshots.preview_snapshot(str(ws), "alice", "chat-1", saved["id"])
    snapshots.restore_snapshot(str(ws), "alice", "chat-1", saved["id"], preview["revision"])
    assert (nested / "file.txt").read_text() == "saved"


def test_size_limit_rejects_large_workspace(ws, monkeypatch):
    monkeypatch.setattr(snapshots, "_MAX_FILE_BYTES", 3)
    (ws / "large.txt").write_text("four")
    with pytest.raises(snapshots.SnapshotError, match="size limit"):
        snapshots.create_snapshot(str(ws), "alice", "chat-1")


def test_repository_assets_above_old_limits_survive_source_restore(ws):
    # A normal web repository can include several bundled assets over 2 MiB
    # and exceed 20 MiB overall without dependencies or Git history.
    for index in range(6):
        (ws / f"asset-{index}.bin").write_bytes(b"x" * (4 * 1024 * 1024))
    source = ws / "source.py"
    source.write_text("before\n")
    saved = snapshots.create_snapshot(str(ws), "alice", "chat-1")
    source.write_text("after\n")
    preview = snapshots.preview_snapshot(str(ws), "alice", "chat-1", saved["id"])
    assert [change["path"] for change in preview["changes"]] == ["source.py"]
    snapshots.restore_snapshot(str(ws), "alice", "chat-1", saved["id"], preview["revision"])
    assert source.read_text() == "before\n"
    assert all((ws / f"asset-{index}.bin").stat().st_size == 4 * 1024 * 1024
               for index in range(6))


def test_total_snapshot_budget_still_rejects_oversized_tree(ws, monkeypatch):
    monkeypatch.setattr(snapshots, "_MAX_TOTAL_BYTES", 5)
    (ws / "a.txt").write_text("four")
    (ws / "b.txt").write_text("four")
    with pytest.raises(snapshots.SnapshotError, match="size limit"):
        snapshots.create_snapshot(str(ws), "alice", "chat-1")


def test_automatic_checkpoint_is_once_per_turn(ws):
    path = ws / "a.txt"
    path.write_text("before")
    first = snapshots.ensure_snapshot(str(ws), "alice", "chat-1", "turn-1")
    path.write_text("after")
    repeated = snapshots.ensure_snapshot(str(ws), "alice", "chat-1", "turn-1")
    assert repeated["id"] == first["id"]
    assert len(snapshots.list_snapshots(str(ws), "alice", "chat-1")) == 1


def test_retention_keeps_the_most_recent_twenty(ws):
    created = []
    for index in range(22):
        (ws / "counter.txt").write_text(str(index))
        created.append(snapshots.create_snapshot(str(ws), "alice", "chat-1", f"snap-{index}"))
    listed = snapshots.list_snapshots(str(ws), "alice", "chat-1")
    retained_ids = {item["id"] for item in listed}
    assert len(listed) == 20
    assert created[0]["id"] not in retained_ids
    assert created[1]["id"] not in retained_ids
    assert created[-1]["id"] in retained_ids


@pytest.mark.skipif(os.name == "nt", reason="POSIX executable bits are unavailable")
def test_executable_mode_round_trips(ws):
    path = ws / "script.sh"
    path.write_text("#!/bin/sh\n")
    path.chmod(0o755)
    saved = snapshots.create_snapshot(str(ws), "alice", "chat-1")
    path.chmod(0o644)
    preview = snapshots.preview_snapshot(str(ws), "alice", "chat-1", saved["id"])
    assert preview["changes"][0]["diff"].startswith("mode ")
    snapshots.restore_snapshot(str(ws), "alice", "chat-1", saved["id"], preview["revision"])
    assert path.stat().st_mode & 0o777 == 0o755


@pytest.mark.skipif(os.name == "nt", reason="POSIX executable bits are unavailable")
def test_preview_shows_mode_change_alongside_content_diff(ws):
    path = ws / "script.sh"
    path.write_text("before\n")
    path.chmod(0o644)
    saved = snapshots.create_snapshot(str(ws), "alice", "chat-1")
    path.write_text("after\n")
    path.chmod(0o755)

    preview = snapshots.preview_snapshot(str(ws), "alice", "chat-1", saved["id"])

    diff = preview["changes"][0]["diff"]
    assert "-after\n+before\n" in diff
    assert "mode 0755 -> 0644" in diff


def test_restore_refuses_hardlink_target(ws, tmp_path):
    path = ws / "script.sh"
    path.write_text("saved")
    saved = snapshots.create_snapshot(str(ws), "alice", "chat-1")
    path.unlink()
    outside = tmp_path / "outside.txt"
    outside.write_text("keep")
    os.link(outside, path)
    preview = snapshots.preview_snapshot(str(ws), "alice", "chat-1", saved["id"])
    with pytest.raises(snapshots.SnapshotError, match="restore path is no longer safe"):
        snapshots.restore_snapshot(str(ws), "alice", "chat-1", saved["id"], preview["revision"])
    assert path.read_text() == "keep"
    assert outside.read_text() == "keep"


def test_restore_parent_swap_does_not_follow_symlink(ws, tmp_path, monkeypatch):
    parent = ws / "nested"
    parent.mkdir()
    target = parent / "file.txt"
    target.write_text("saved")
    saved = snapshots.create_snapshot(str(ws), "alice", "chat-1")
    target.write_text("current")
    outside = tmp_path / "outside"
    outside.mkdir()
    sentinel = outside / "file.txt"
    sentinel.write_text("outside sentinel")
    preview = snapshots.preview_snapshot(str(ws), "alice", "chat-1", saved["id"])

    open_parent = snapshots._open_parent_fd
    calls = 0

    def swap_after_parent_open(root_fd, rel, *, create=False):
        nonlocal calls
        parent_fd, leaf = open_parent(root_fd, rel, create=create)
        if rel == "nested/file.txt":
            calls += 1
            if calls == 2:
                parent.rename(ws / "moved-away")
                parent.symlink_to(outside, target_is_directory=True)
        return parent_fd, leaf

    monkeypatch.setattr(snapshots, "_open_parent_fd", swap_after_parent_open)
    snapshots.restore_snapshot(str(ws), "alice", "chat-1", saved["id"], preview["revision"])

    assert calls == 2
    assert sentinel.read_text() == "outside sentinel"
    assert (ws / "moved-away" / "file.txt").read_text() == "saved"
    assert parent.is_symlink()


def test_restore_rejects_platform_without_safe_dir_fd_support(ws, monkeypatch):
    path = ws / "file.txt"
    path.write_text("saved")
    saved = snapshots.create_snapshot(str(ws), "alice", "chat-1")
    path.write_text("current")
    preview = snapshots.preview_snapshot(str(ws), "alice", "chat-1", saved["id"])
    monkeypatch.setattr(snapshots, "_supports_safe_restore", lambda: False)

    with pytest.raises(snapshots.SnapshotError, match="unavailable on this platform"):
        snapshots.restore_snapshot(str(ws), "alice", "chat-1", saved["id"], preview["revision"])
    assert path.read_text() == "current"
