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


def _actual_test_request_flag(prompt: str) -> bool:
    tree = ast.parse(inspect.getsource(al.stream_agent_loop))
    assignment = next(
        node for node in ast.walk(tree)
        if isinstance(node, ast.Assign)
        and any(isinstance(target, ast.Name) and target.id == "_tui_test_request"
                for target in node.targets)
    )
    code = compile(ast.fix_missing_locations(ast.Module(body=[assignment], type_ignores=[])),
                   "<actual-test-intent-init>", "exec")
    runtime = {
        "surface": "odysseus-tui",
        "host_shell_bridge": {"url": "http://host.docker.internal:17654/run"},
        "runtime_execution_contract": {"local_workspace_tasks": "use_host_shell_bridge"},
    }
    local_turn = al._tui_local_tool_constrained_turn(
        prompt, workspace="/synthetic", client_runtime_context=runtime
    )
    namespace = dict(vars(al), _last_user=prompt, _tui_local_execution_turn=local_turn)
    exec(code, namespace)
    return namespace["_tui_test_request"]


def _run_actual_no_tool_test_fallback(prompt: str, test_request: bool, tool_blocks=None):
    tree = ast.parse(inspect.getsource(al.stream_agent_loop))
    branch = next(
        node for node in ast.walk(tree)
        if isinstance(node, ast.If)
        and "_tui_test_completed" in ast.unparse(node.test)
        and "not tool_blocks" in ast.unparse(node.test)
    )
    code = compile(ast.fix_missing_locations(ast.Module(body=[branch], type_ignores=[])),
                   "<actual-no-tool-test-fallback>", "exec")
    blocks = [] if tool_blocks is None else tool_blocks
    namespace = dict(
        vars(al), _tui_test_request=test_request, _tui_test_completed=False,
        tool_blocks=blocks, native_tool_calls=[], _force_answer=False,
        exact_approval=None, _last_user=prompt, round_response="model prose",
        converted_calls=["discarded"], used_native=True,
    )
    namespace["logger"] = type("Logger", (), {"warning": lambda *args: None})()
    exec(code, namespace)
    return namespace, blocks


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


def test_every_test_request_uses_full_suite_command(tmp_path):
    (tmp_path / "pyproject.toml").write_text("[project]\nname='synthetic'\n")
    prompt = "Run every test"
    command = _tui_local_fallback_shell_command(prompt)
    assert command == _tui_local_test_runner_command(full=True)
    code, log = _run_runner(tmp_path, command)
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
    for prompt in (
        "Run only unit tests",
        "Run all tests except integration",
        "Run tests, but not all of them",
        "Run tests, but not all tests",
        "Run tests, but not every test",
        "Run tests, but not the full suite",
    ):
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


def test_actual_host_normalization_preserves_supplied_runners():
    # Execute the actual normalization branch without executing a host command.
    tree = ast.parse(inspect.getsource(al.stream_agent_loop))
    branch = next(node for node in ast.walk(tree) if isinstance(node, ast.If)
                  and ast.unparse(node.test) == "block.tool_type == 'host_shell' and _tui_test_request")
    code = compile(ast.fix_missing_locations(ast.Module(body=[branch], type_ignores=[])),
                   "<actual-host-test-normalization>", "exec")
    cases = (
        ("Run tests in this repo", "node --test tests/unit.test.mjs", "node --test tests/unit.test.mjs"),
        ("Run tests in this repo", "python -m unittest tests.test_unit", "python -m unittest tests.test_unit"),
        ("Run tests in this repo", "yarn test unit", "yarn test unit"),
        ("Run only unit tests", "pytest -m unit tests/test_unit.py",
         al._tui_normalize_pytest_command("pytest -m unit tests/test_unit.py")),
        ("Run pytest tests/test_specific.py", "echo pending", "echo pending"),
        ("Run all tests except integration", "node --test tests/unit.test.mjs",
         "node --test tests/unit.test.mjs"),
    )
    for prompt, command, expected in cases:
        original = json.dumps({"command": command, "timeout": 120})
        namespace = dict(vars(al), block=al.ToolBlock("host_shell", original),
                         full_command=original, cmd_display=original,
                         _last_user=prompt, _tui_test_request=True)
        exec(code, namespace)
        assert json.loads(namespace["full_command"])["command"] == expected


def test_node_test_is_shared_verifier_evidence_not_shell_echo_or_help():
    from src.agent_evidence import command_is_test
    from src.agent_runtime.identity import is_test_command

    assert is_test_command("node --test tests/unit.test.mjs")
    assert command_is_test(json.dumps({"command": "node --test tests/unit.test.mjs"}))
    for command in ("npm run test", "pnpm run test", "yarn run test"):
        assert is_test_command(command), command
    for command in (
        "node --help", "node --test --help", "echo node --test", "node script.js --test",
        "echo pytest", "pytest --collect-only", "node --test || true",
        "pnpm run build", "yarn run lint", "make run test", "npm run test -- --help",
    ):
        assert not is_test_command(command), command


def test_actual_no_tool_fallback_uses_runner_content_and_counts_attempt():
    prompt = "Run tests in this repo"
    assert _actual_test_request_flag(prompt) is True
    namespace, _ = _run_actual_no_tool_test_fallback(
        prompt, _actual_test_request_flag(prompt)
    )
    assert namespace["tool_blocks"]
    payload = json.loads(namespace["tool_blocks"][0].content)
    assert payload["command"] == _tui_local_fallback_shell_command(prompt)
    assert payload["timeout"] == 120
    assert namespace["round_response"] == ""


def test_negated_test_actions_do_not_trigger_automatic_runner():
    for prompt in (
        "Do not run tests; just read main.py", "Never execute tests",
        "Never test now", "Don't test now", "Do not execute main.test.js",
    ):
        test_request = _actual_test_request_flag(prompt)
        assert test_request is False
        namespace, _ = _run_actual_no_tool_test_fallback(prompt, test_request)
        assert namespace["tool_blocks"] == []

    assert _actual_test_request_flag("Do not edit main.py; run tests") is True


def test_pytest_interpreter_normalization_preserves_call_options():
    tree = ast.parse(inspect.getsource(al.stream_agent_loop))
    branch = next(node for node in ast.walk(tree) if isinstance(node, ast.If)
                  and ast.unparse(node.test) == "block.tool_type == 'host_shell' and _tui_test_request")
    code = compile(ast.fix_missing_locations(ast.Module(body=[branch], type_ignores=[])),
                   "<actual-host-test-options>", "exec")
    original = {"command": "pytest tests/test_unit.py", "timeout": 7, "detach": True}
    encoded = json.dumps(original)
    namespace = dict(vars(al), block=al.ToolBlock("host_shell", encoded),
                     full_command=encoded, cmd_display=encoded,
                     _last_user="Run tests in this repo", _tui_test_request=True)
    exec(code, namespace)
    assert json.loads(namespace["full_command"]) == dict(
        original, command=al._tui_normalize_pytest_command(original["command"])
    )


def test_no_tool_fallback_leaves_a_provided_model_tool_call_untouched():
    prompt = "Run tests in this repo"
    call = al.ToolBlock("read_file", "main.py")
    namespace, provided = _run_actual_no_tool_test_fallback(
        prompt, _actual_test_request_flag(prompt), [call]
    )
    assert namespace["tool_blocks"] is provided
    assert namespace["tool_blocks"] == [call]


def test_project_discovery_keeps_explicit_host_search_and_fallback_inventory():
    prompt = "Find my local projects using find . -maxdepth 2 -name package.json"
    runtime = {
        "surface": "odysseus-tui",
        "host_shell_bridge": {"url": "http://host.docker.internal:17654/run"},
        "runtime_execution_contract": {"local_workspace_tasks": "use_host_shell_bridge"},
    }
    local_turn = al._tui_local_tool_constrained_turn(
        prompt, workspace="/synthetic", client_runtime_context=runtime
    )
    tree = ast.parse(inspect.getsource(al.stream_agent_loop))
    discovery_init = next(
        node for node in ast.walk(tree)
        if isinstance(node, ast.Assign)
        and any(isinstance(target, ast.Name)
                and target.id == "_tui_project_discovery_request"
                for target in node.targets)
    )
    code = compile(ast.fix_missing_locations(ast.Module(body=[discovery_init], type_ignores=[])),
                   "<actual-project-discovery-init>", "exec")
    namespace = dict(vars(al), _last_user=prompt, _tui_local_execution_turn=local_turn)
    exec(code, namespace)
    assert local_turn is True
    assert namespace["_tui_project_discovery_request"] is True

    original = {
        "command": "find . -maxdepth 2 -name package.json",
        "timeout": 7,
        "env": {"SYNTHETIC": "1"},
    }
    encoded = json.dumps(original)
    block = al.ToolBlock("host_shell", encoded)
    normalizers = [
        node for node in ast.walk(tree)
        if isinstance(node, ast.If)
        and any(isinstance(name, ast.Name) and name.id in {
            "_tui_test_request", "_tui_project_discovery_request"
        } for name in ast.walk(node.test))
        and any(isinstance(assignment, ast.Assign)
                and any(isinstance(target, ast.Name) and target.id == "full_command"
                        for target in assignment.targets)
                for assignment in ast.walk(node))
    ]
    namespace.update(
        block=block, full_command=encoded, cmd_display=encoded,
        _tui_test_request=False,
        logger=type("Logger", (), {"info": lambda *args: None})(),
    )
    code = compile(ast.fix_missing_locations(ast.Module(
        body=sorted(normalizers, key=lambda node: node.lineno), type_ignores=[]
    )), "<actual-host-command-normalizers>", "exec")
    exec(code, namespace)
    assert namespace["full_command"] == encoded
    assert namespace["block"].content == encoded
    assert al._tui_host_command_text(block.content) == original["command"]
    assert al._tui_normalize_workspace_host_command(block.content, "/synthetic") is None
    assert json.loads(block.content) == original

    fallback = _tui_local_fallback_shell_command(
        "Search my computer for the local project I was working on"
    )
    assert fallback and "git_roots:" in fallback and "project_manifests:" in fallback
    assert al._tui_project_discovery_summary(
        "git_roots:\n./synthetic-project\nproject_manifests:\n"
        "./synthetic-project/package.json\n"
    ) == (
        "Projects found in the active workspace:\n"
        "- ./synthetic-project\n"
        "Select a project path and I can inspect its files or run its tests."
    )


def test_actual_completion_accepts_test_runner_or_exact_server_fallback_attempt():
    tree = ast.parse(inspect.getsource(al.stream_agent_loop))
    branch = next(
        node for node in ast.walk(tree)
        if isinstance(node, ast.If)
        and "_server_test_fallback" in ast.unparse(node.test)
    )
    code = compile(ast.fix_missing_locations(ast.Module(body=[branch], type_ignores=[])),
                   "<actual-test-completion>", "exec")
    prompt = "Run tests in this repo"
    generic = _tui_local_fallback_shell_command(prompt)
    assert generic and not al.command_is_test(generic)
    cases = (
        ("pytest -q", True),
        ("node --test tests/unit.test.mjs", True),
        (generic, True),  # recorded as an attempt, not canonical test evidence
        ("echo pytest", False),
        ("pytest --help", False),
        ("pytest --collect-only", False),
        ("node --test || true", False),
    )
    for command, expected in cases:
        encoded = json.dumps({"command": command})
        namespace = dict(
            vars(al), block=al.ToolBlock("host_shell", encoded),
            full_command=encoded, result={"output": "synthetic result"},
            _tui_test_request=True, _last_user=prompt,
            _tui_test_completed=False, _tui_test_summary_text="",
        )
        exec(code, namespace)
        assert namespace["_tui_test_completed"] is expected, command
        if expected:
            assert namespace["_tui_test_summary_text"] == "synthetic result"

    non_test_prompt = "Run a bash block"
    probe = _tui_local_fallback_shell_command(non_test_prompt)
    assert probe and not al.command_is_test(probe)
    encoded = json.dumps({"command": probe})
    namespace.update(block=al.ToolBlock("host_shell", encoded), full_command=encoded,
                     _last_user=non_test_prompt, _tui_test_request=False,
                     _tui_test_completed=False, _tui_test_summary_text="")
    exec(code, namespace)
    assert namespace["_tui_test_completed"] is False



def test_full_scope_does_not_confuse_exclusion_or_every_time():
    for prompt in ("Run tests, but not all tests", "Run tests, but not every test"):
        assert al._tui_explicit_full_test_request(prompt) is False
    assert al._tui_explicit_full_test_request("Run tests every time I edit") is False
    assert al._tui_explicit_full_test_request("Run every test") is True


def test_no_tool_recovery_preserves_supported_exact_runner_commands():
    for command in (
        "node --test tests/specific.mjs",
        "python -m unittest tests.test_unit",
        "yarn test selected",
        "npm run test -- --runInBand",
        "pnpm run test selected",
        "make test", "cargo test selected", "go test ./specific/...",
        "/usr/bin/node --test tests/specific.mjs",
        "cd ./sub && node --test tests/specific.mjs",
    ):
        prompt = "Run " + command
        assert _tui_local_fallback_shell_command(prompt) == command
        namespace, _ = _run_actual_no_tool_test_fallback(prompt, True)
        assert json.loads(namespace["tool_blocks"][0].content)["command"] == command
    legacy = "Run py -m pytest tests/test_specific.py"
    assert _tui_local_fallback_shell_command(legacy) == al._tui_normalize_pytest_command(
        "py -m pytest tests/test_specific.py"
    )


def test_unsupported_exact_runner_request_never_becomes_generic_suite():
    for prompt in (
        "Run node --test tests/specific.mjs; echo done",
        "Run python -m unittest tests.test_unit\nThen summarize",
        "Run yarn test selected || true",
        "Run node --test --help",
        "Run pytest --collect-only", "Run pytest --help",
        "Run pytest tests/test_specific.py -k 'unterminated",
        "Run node --test tests/$(whoami).mjs",
        "Run npm test > /tmp/synthetic-report",
        "Run cd ./sub && node --test tests/specific.mjs || true",
        "Run /usr/bin/node --test tests/specific.mjs; echo done",
        "Run /usr/bin/node --test tests/specific.mjs\nThen summarize",
        "Run tests; then summarize",
        "Run (node --test tests/specific.mjs)",
        "Run uv run pytest tests/test_specific.py",
        "Run uv run python -m unittest package.verifier",
    ):
        assert _tui_local_fallback_shell_command(prompt) is None
        assert _tui_local_test_runner_host_shell_content(prompt) is None
        namespace, _ = _run_actual_no_tool_test_fallback(prompt, True)
        assert namespace["tool_blocks"] == []


def test_exact_runner_request_precedes_bounded_intent_and_incidental_probe_words():
    commands = (
        "python -m unittest package.verifier",
        "cd ./" + "deep/" * 12 + " && npm test",
    )
    for command in commands:
        prompt = "Run " + command
        assert _actual_test_request_flag(prompt) is True
        assert _tui_local_fallback_shell_command(prompt) == command
        namespace, _ = _run_actual_no_tool_test_fallback(prompt, _actual_test_request_flag(prompt))
        assert json.loads(namespace["tool_blocks"][0].content)["command"] == command
    command = "pytest 'tests/bash block/test_case.py'"
    assert _tui_local_fallback_shell_command("Run " + command) == al._tui_normalize_pytest_command(command)
