"""Exercise TUI fallback runner selection without running project tests."""

import ast
import inspect
import json
import os
from pathlib import Path
import subprocess

import src.agent_loop as al

from src.agent_loop import (
    _tui_local_fallback_shell_command,
    _tui_local_test_runner_command,
    _tui_local_test_runner_host_shell_content,
)


def _run_runner(tmp_path: Path, command: str, *, node_has_test: bool = False,
                npm_exit: int = 0, create_tests: bool = True) -> tuple[int, str]:
    if create_tests:
        (tmp_path / "tests").mkdir(exist_ok=True)
        (tmp_path / "tests" / "test_focus.py").write_text("# synthetic focused target\n")
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir(exist_ok=True)
    log = tmp_path / "runner.log"
    log.unlink(missing_ok=True)
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


def test_explicit_pytest_target_survives_fallback_dispatch_and_host_content(tmp_path):
    (tmp_path / "pyproject.toml").write_text("[project]\nname='synthetic'\n")
    prompt = "Run pytest tests/test_specific.py -k selected"
    command = _tui_local_fallback_shell_command(prompt)
    assert command is not None
    assert '"$runner" -m pytest tests/test_specific.py -k selected' in command
    code, log = _run_runner(tmp_path, command)
    assert code == 0
    assert log == "python -m pytest tests/test_specific.py -k selected\n"

    content = _tui_local_test_runner_host_shell_content(prompt)
    assert content is not None
    host_command = json.loads(content)["command"]
    assert host_command == command
    code, log = _run_runner(tmp_path, host_command)
    assert code == 0
    assert log == "python -m pytest tests/test_specific.py -k selected\n"


def test_explicit_selector_and_target_precede_scope_refusal(tmp_path):
    (tmp_path / "pyproject.toml").write_text("[project]\nname='synthetic'\n")
    prompt = "Run pytest -m 'not integration' tests/test_specific.py"
    command = _tui_local_fallback_shell_command(prompt)
    assert command is not None
    assert "pytest -m 'not integration' tests/test_specific.py" in command
    assert command == json.loads(
        _tui_local_test_runner_host_shell_content(prompt)
    )["command"]
    code, log = _run_runner(tmp_path, command)
    assert code == 0
    assert log == "python -m pytest -m not integration tests/test_specific.py\n"


def test_generic_focused_and_full_fallbacks_remain_available(tmp_path):
    (tmp_path / "pyproject.toml").write_text("[project]\nname='synthetic'\n")
    focused = _tui_local_fallback_shell_command("Run tests in this repo")
    code, log = _run_runner(tmp_path, focused)
    assert code == 0
    assert log == "python -m pytest -q tests/test_focus.py\n"

    full = _tui_local_fallback_shell_command("Run the full test suite")
    code, log = _run_runner(tmp_path, full)
    assert code == 0
    assert log == "python -m pytest -q\n"


def test_unrepresentable_test_scope_does_not_synthesize_or_rewrite_broad_run():
    for prompt in ("Run only unit tests", "Run all tests except integration"):
        assert _tui_local_fallback_shell_command(prompt) is None
        assert _tui_local_test_runner_host_shell_content(prompt) is None


def test_unrepresentable_explicit_command_does_not_fall_back_to_generic_runner():
    for prompt in (
        "Run pytest tests/test_specific.py; echo compound",
        "Run pytest tests/test_specific.py\nThen summarize the results",
    ):
        assert _tui_local_fallback_shell_command(prompt) is None
        assert _tui_local_test_runner_host_shell_content(prompt) is None


def test_explicit_pytest_directory_arguments_are_not_stripped():
    for target in (".", ".."):
        command = _tui_local_fallback_shell_command(f"Run pytest {target}")
        assert command == al._tui_normalize_pytest_command(f"pytest {target}")


def test_actual_host_normalization_only_changes_placeholder_test_commands():
    # Execute the actual normalization branch without executing a host command.
    tree = ast.parse(inspect.getsource(al.stream_agent_loop))
    branch = next(node for node in ast.walk(tree) if isinstance(node, ast.If)
                  and ast.unparse(node.test) == "block.tool_type == 'host_shell' and _tui_test_request")
    code = compile(ast.fix_missing_locations(ast.Module(body=[branch], type_ignores=[])),
                   "<actual-host-test-normalization>", "exec")
    cases = (
        ("Run only unit tests", "pytest -m unit tests/test_unit.py",
         al._tui_normalize_pytest_command("pytest -m unit tests/test_unit.py")),
        ("Run pytest tests/test_specific.py", "echo pending",
         _tui_local_fallback_shell_command("Run pytest tests/test_specific.py")),
        ("Run all tests except integration", "echo pending", "echo pending"),
    )
    for prompt, command, expected in cases:
        original = json.dumps({"command": command, "timeout": 120})
        namespace = dict(vars(al), block=al.ToolBlock("host_shell", original),
                         full_command=original, cmd_display=original,
                         _last_user=prompt, _tui_test_request=True)
        exec(code, namespace)
        assert json.loads(namespace["full_command"])["command"] == expected

