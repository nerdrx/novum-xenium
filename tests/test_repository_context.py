from __future__ import annotations

from src import repository_context
from src.repository_context import build_repository_context


def test_repository_context_ranks_symbols_and_skips_generated_and_secret_files(tmp_path):
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "auth.py").write_text(
        "class SessionAuth:\n    def validate_token(self):\n        pass\n", encoding="utf-8"
    )
    (tmp_path / "src" / "misc.py").write_text("def unrelated(): pass\n", encoding="utf-8")
    (tmp_path / "README.md").write_text("untrusted text", encoding="utf-8")
    (tmp_path / ".env").write_text("def leaked_secret(): pass", encoding="utf-8")
    (tmp_path / "secrets.py").write_text("def leaked_secret_file(): pass", encoding="utf-8")
    private_data = tmp_path / "data"
    private_data.mkdir()
    (private_data / "auth.py").write_text("def private_state(): pass", encoding="utf-8")
    (private_data / "auth.json").write_text('{"token":"private"}', encoding="utf-8")
    generated = tmp_path / "node_modules"
    generated.mkdir()
    (generated / "dep.py").write_text("def generated(): pass", encoding="utf-8")

    result = build_repository_context(tmp_path, "validate token", max_files=10)

    assert '"src/auth.py" — SessionAuth, validate_token' in result
    assert result.index("src/auth.py") < result.index("src/misc.py")
    assert ".env" not in result
    assert "secrets.py" not in result
    assert "data/" not in result
    assert "node_modules" not in result
    assert "untrusted text" not in result
    assert "untrusted data" in result


def test_repository_context_skips_symlinks_and_rejects_symlink_root(tmp_path):
    root = tmp_path / "repo"
    root.mkdir()
    outside = tmp_path / "outside.py"
    outside.write_text("def must_not_appear(): pass", encoding="utf-8")
    (root / "escape.py").symlink_to(outside)
    (root / "safe.py").write_text("def safe(): pass", encoding="utf-8")

    assert "safe.py" in build_repository_context(root)
    assert "escape.py" not in build_repository_context(root)
    assert "must_not_appear" not in build_repository_context(root)
    (tmp_path / "link").symlink_to(root, target_is_directory=True)
    assert "not a real directory" in build_repository_context(tmp_path / "link")


def test_repository_context_enforces_output_bounds(tmp_path):
    for index in range(5):
        (tmp_path / f"module{index}.py").write_text(f"def item{index}(): pass\n", encoding="utf-8")
    result = build_repository_context(tmp_path, max_files=2, max_symbols=1, max_chars=100)
    assert len(result) <= 100


def test_repository_context_stops_after_scan_budget(tmp_path, monkeypatch):
    for index in range(5):
        (tmp_path / f"module{index}.py").write_text("def item(): pass", encoding="utf-8")
    monkeypatch.setattr(repository_context, "_MAX_FILES_SCANNED", 2)
    result = build_repository_context(tmp_path)
    assert "[scan capped]" in result
