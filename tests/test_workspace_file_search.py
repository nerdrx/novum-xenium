import os

import pytest

from routes.workspace_routes import _open_workspace_file, _search_workspace


def test_search_matches_filenames_and_skips_hidden_and_symlink_paths(tmp_path):
    root = tmp_path / "workspace"
    root.mkdir()
    (root / "report-one.txt").write_text("one")
    hidden = root / ".private"
    hidden.mkdir()
    (hidden / "report-secret.txt").write_text("secret")
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "report-outside.txt").write_text("outside")
    try:
        (root / "linked").symlink_to(outside, target_is_directory=True)
    except OSError:
        pytest.skip("symlinks are unavailable")

    results, truncated = _search_workspace(str(root), "REPORT")

    assert [item["path"] for item in results] == ["report-one.txt"]
    assert not truncated


def test_open_rejects_traversal_and_symlink_files(tmp_path):
    root = tmp_path / "workspace"
    root.mkdir()
    outside = tmp_path / "outside.txt"
    outside.write_text("outside")
    (root / "linked.txt").symlink_to(outside)

    if not hasattr(os, "O_NOFOLLOW") or not hasattr(os, "O_DIRECTORY"):
        pytest.skip("safe descriptor-relative opening is unavailable")
    with pytest.raises(ValueError):
        _open_workspace_file(str(root), "../outside.txt")
    with pytest.raises(OSError):
        _open_workspace_file(str(root), "linked.txt")


def test_open_returns_only_a_regular_workspace_file(tmp_path):
    root = tmp_path / "workspace"
    root.mkdir()
    (root / "answer.txt").write_text("workspace result")

    with _open_workspace_file(str(root), "answer.txt") as handle:
        assert handle.read() == b"workspace result"
