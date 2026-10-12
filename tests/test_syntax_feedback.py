"""Source edits receive bounded, non-executing syntax feedback."""

import asyncio
import json
import shutil

from src.agent_tools import syntax_feedback as syntax_module
from src.agent_tools.syntax_feedback import syntax_feedback
from src.tool_execution import _direct_fallback


def test_javascript_colon_typo_reports_line_without_changing_save_status():
    warning = syntax_feedback("app.js", "const view = {};\nview.style.background:\n  'red';\n")
    assert warning is not None
    assert "JavaScript at line 2" in warning
    assert "Unexpected token" in warning
    assert "does not verify functionality" in warning


def test_python_syntax_error_reports_line():
    warning = syntax_feedback("broken.py", "value = 1\ndef broken(:\n    pass\n")
    assert warning is not None
    assert "Python at line 2" in warning


def test_python_compile_rejects_module_scope_return_and_await():
    for source in ("return 1\n", "await task()\n"):
        warning = syntax_feedback("module.py", source)
        assert warning is not None
        assert "Python at line 1" in warning
        assert "outside function" in warning


def test_syntax_checks_never_execute_python_or_javascript(tmp_path):
    marker = tmp_path / "must-not-exist"
    py_source = f"from pathlib import Path\nPath({str(marker)!r}).write_text('ran')\n"
    assert syntax_feedback("safe.py", py_source) is None
    assert not marker.exists()

    if shutil.which("node"):
        js_source = (
            "require('fs').writeFileSync(" + json.dumps(str(marker)) + ", 'ran');\n"
        )
        assert syntax_feedback("safe.cjs", js_source) is None
        assert not marker.exists()


def test_missing_node_and_oversized_source_skip_gracefully(monkeypatch):
    monkeypatch.setattr(syntax_module.shutil, "which", lambda _name: None)
    assert syntax_feedback("source.js", "const value = :;") is None
    assert syntax_feedback("large.py", "#" + "x" * (256 * 1024)) is None


def test_write_edit_and_patch_attach_warnings_but_keep_successful_saves(tmp_path):
    async def exercise():
        js_path = tmp_path / "bad.js"
        written = await _direct_fallback("write_file", json.dumps({
            "path": str(js_path), "content": "const view = {};\nview.style.background:\n  'red';\n",
        }))
        assert written["exit_code"] == 0
        assert "JavaScript at line 2" in written["syntax_warning"]
        assert js_path.read_text() == "const view = {};\nview.style.background:\n  'red';\n"

        py_path = tmp_path / "edit.py"
        py_path.write_text("value = 1\n")
        edited = await _direct_fallback("edit_file", json.dumps({
            "path": str(py_path), "old_string": "value = 1", "new_string": "def bad(:",
        }))
        assert edited["exit_code"] == 0
        assert "Python at line 1" in edited["syntax_warning"]
        assert py_path.read_text() == "def bad(:\n"

        mjs_path = tmp_path / "patch.mjs"
        patch = f"""*** Begin Patch
*** Add File: {mjs_path}
+export const value = :;
*** End Patch"""
        patched = await _direct_fallback("apply_patch", patch)
        assert patched["exit_code"] == 0
        assert "JavaScript at line 1" in patched["syntax_warning"]
        assert mjs_path.read_text() == "export const value = :;\n"

    asyncio.run(exercise())


def test_multi_file_patch_caps_checks_and_notes_skipped_sources(tmp_path, monkeypatch):
    from src.agent_tools import filesystem_tools

    checked = []

    def record_check(path, source):
        checked.append(path)
        return None

    monkeypatch.setattr(filesystem_tools, "syntax_feedback", record_check)
    paths = [tmp_path / f"module_{index}.py" for index in range(5)]
    patch = "*** Begin Patch\n" + "".join(
        f"*** Add File: {path}\n+value = {index}\n"
        for index, path in enumerate(paths)
    ) + "*** End Patch"
    result = asyncio.run(_direct_fallback("apply_patch", patch))

    assert result["exit_code"] == 0
    assert len(checked) == 4
    assert all(path.exists() for path in paths)
    assert "Syntax feedback skipped for 1 additional source files" in result["output"]


def test_patch_checker_exception_does_not_reverse_successful_write(tmp_path, monkeypatch):
    from src.agent_tools import filesystem_tools

    def broken_checker(_path, _source):
        raise RuntimeError("checker failed")

    monkeypatch.setattr(filesystem_tools, "syntax_feedback", broken_checker)
    path = tmp_path / "saved.py"
    patch = f"*** Begin Patch\n*** Add File: {path}\n+value = 1\n*** End Patch"
    result = asyncio.run(_direct_fallback("apply_patch", patch))

    assert result["exit_code"] == 0
    assert path.read_text() == "value = 1\n"
    assert "syntax_warning" not in result


def test_checker_failure_is_not_reported_as_source_syntax_error(monkeypatch):
    from types import SimpleNamespace
    monkeypatch.setattr(syntax_module.shutil, "which", lambda _name: "/usr/bin/node")
    monkeypatch.setattr(syntax_module.subprocess, "run", lambda *args, **kwargs:
                        SimpleNamespace(returncode=1, stderr="node: bad option: --check", stdout=""))
    assert syntax_feedback("source.mjs", "export const value = 1;") is None
