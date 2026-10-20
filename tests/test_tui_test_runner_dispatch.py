"""Exercise TUI fallback runner selection without running project tests."""

import os
from pathlib import Path
import subprocess

from src.agent_loop import (
    _tui_local_fallback_shell_command,
    _tui_local_test_runner_command,
)


def _run_runner(tmp_path: Path, command: str, *, node_has_test: bool = False,
                npm_exit: int = 0, create_tests: bool = True) -> tuple[int, str]:
    if create_tests:
        (tmp_path / "tests").mkdir(exist_ok=True)
        (tmp_path / "tests" / "test_focus.py").write_text("# synthetic focused target\n")
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir(exist_ok=True)
    log = tmp_path / "runner.log"
    stubs = {
        "python": '#!/bin/sh\nprintf "python %s\\n" "$*" >> "$RUNNER_LOG"\nexit "${PYTHON_EXIT:-0}"\n',
        "npm": '#!/bin/sh\nprintf "npm %s\\n" "$*" >> "$RUNNER_LOG"\nexit "${NPM_EXIT:-0}"\n',
        "node": '#!/bin/sh\n[ "${NODE_HAS_TEST:-0}" = 1 ]\n',
        "git": '#!/bin/sh\ncase "$1" in rev-parse) exit 1 ;; diff) printf "tests/test_focus.py\\n" ;; esac\n',
    }
    for name, content in stubs.items():
        path = bin_dir / name
        path.write_text(content)
        path.chmod(0o755)
    env = os.environ.copy()
    env.update({
        "PATH": f"{bin_dir}:{env['PATH']}",
        "RUNNER_LOG": str(log),
        "NODE_HAS_TEST": "1" if node_has_test else "0",
        "NPM_EXIT": str(npm_exit),
        "PYTHON_EXIT": "0",
    })
    result = subprocess.run(["bash", "-c", command], cwd=tmp_path, env=env,
                            text=True, capture_output=True, timeout=10)
    return result.returncode, log.read_text() if log.exists() else ""


def test_js_test_script_wins_over_generic_tests_directory(tmp_path):
    (tmp_path / "package.json").write_text('{"scripts":{"test":"jest"}}')
    (tmp_path / "tests").mkdir()
    code, log = _run_runner(tmp_path, _tui_local_test_runner_command(), node_has_test=True)
    assert code == 0
    assert log == "npm test\n"


def test_python_project_marker_keeps_precedence_over_npm(tmp_path):
    (tmp_path / "pyproject.toml").write_text("[project]\nname='synthetic'\n")
    (tmp_path / "package.json").write_text('{"scripts":{"test":"jest"}}')
    code, log = _run_runner(tmp_path, _tui_local_test_runner_command(), node_has_test=True)
    assert code == 0
    assert "python -m pytest -q tests/test_focus.py" in log
    assert "npm" not in log


def test_js_test_script_without_tests_directory_uses_npm_and_propagates_failure(tmp_path):
    (tmp_path / "package.json").write_text('{"scripts":{"test":"jest"}}')
    code, log = _run_runner(tmp_path, _tui_local_test_runner_command(),
                            node_has_test=True, npm_exit=7, create_tests=False)
    assert code == 7
    assert log == "npm test\n"
    assert not (tmp_path / "tests").exists()


def test_package_without_test_script_keeps_python_tests_fallback(tmp_path):
    (tmp_path / "package.json").write_text('{"scripts":{"build":"build"}}')
    (tmp_path / "tests").mkdir()
    code, log = _run_runner(tmp_path, _tui_local_test_runner_command())
    assert code == 0
    assert "python -m pytest -q tests/test_focus.py" in log


def test_explicit_full_test_fallback_uses_full_suite_command(tmp_path):
    (tmp_path / "pyproject.toml").write_text("[project]\nname='synthetic'\n")
    full_command = _tui_local_fallback_shell_command("Run the full test suite")
    assert full_command == _tui_local_test_runner_command(full=True)
    code, log = _run_runner(tmp_path, full_command)
    assert code == 0
    assert log == "python -m pytest -q\n"

