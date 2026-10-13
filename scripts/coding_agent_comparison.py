"""Run two coding-agent commands against identical, isolated task copies.

Commands are argv templates (no shell); see docs/coding-agent-comparison.md.
The runner records metadata and test results, never model output or credentials.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shlex
import signal
import subprocess
import sys
import time
from datetime import datetime, timezone
from urllib.parse import urlsplit


FIXTURE = {
    "calc.py": "def add(a, b):\n    return a - b\n",
    "TASK.md": "Fix the `add` function in `calc.py` so it returns the sum for positive, negative, and zero values. Keep the change minimal.\n",
}
ACCEPTANCE = (
    "from calc import add; "
    "assert add(2, 3) == 5; "
    "assert add(-2, 3) == 1; "
    "assert add(0, 0) == 0; "
    "assert add(-4, -6) == -10"
)
MULTIFILE_FIXTURE = {
    "core.py": "def total(values):\n    return len(values)\n",
    "report.py": "from core import total\ndef summary(values):\n    return {'total': total(values), 'count': total(values)}\n",
    "TASK.md": (
        "Repair this project: `core.total` must sum numeric values; "
        "`report.summary` must return a dictionary with exactly the keys `total` (the sum) and `count` (number of values), including empty input. "
        "Change `core.py` and `report.py`, then verify the result.\n"
    ),
}
MULTIFILE_ACCEPTANCE = (
    "from report import summary; "
    "assert summary([2, 3]) == {'total': 5, 'count': 2}; "
    "assert summary([]) == {'total': 0, 'count': 0}; "
    "assert summary([-1, 4]) == {'total': 3, 'count': 2}"
)
CASES = {
    "wiring": (FIXTURE, ACCEPTANCE),
    "multifile": (MULTIFILE_FIXTURE, MULTIFILE_ACCEPTANCE),
}
AGENTS = ("novum", "aider")
ACCEPTANCE_TIMEOUT = 15
SECRET_ARG = re.compile(
    r"(?i)(?:--(?:api[-_]?key|access[-_]?token|token|password|secret|authorization|credential)(?:=|$)"
    r"|(?:api[-_]?key|access[-_]?token|password|secret|authorization|credential)\s*[=:])"
)
SECRET_FIELD = re.compile(r"(?i)(?:^|[_-])(?:api[_-]?key|token|secret|password|authorization|credential)(?:$|[_-])")


def command_argv(template: str, values: dict[str, str]) -> list[str]:
    """Expand known placeholders without invoking a shell."""
    argv = shlex.split(template)
    if not argv:
        raise ValueError("command template is empty")
    if any(SECRET_ARG.search(part) for part in argv):
        raise ValueError("put credentials in the process environment or config file, not command arguments")
    try:
        return [part.format_map(values) for part in argv]
    except KeyError as exc:
        raise ValueError(f"unknown command placeholder: {{{exc.args[0]}}}") from exc


def validate_endpoint(endpoint: str) -> str:
    parts = urlsplit(endpoint)
    if parts.scheme not in {"http", "https"} or not parts.hostname or parts.username or parts.password or parts.query or parts.fragment:
        raise ValueError("endpoint must be an http(s) URL without credentials, query, or fragment")
    return endpoint.rstrip("/")


def parse_settings(value: str) -> dict:
    settings = json.loads(value)
    if not isinstance(settings, dict):
        raise ValueError("settings must be a JSON object")

    def inspect(item, path="settings"):
        if isinstance(item, dict):
            for key, child in item.items():
                if SECRET_FIELD.search(str(key)):
                    raise ValueError(f"{path} contains a credential-like field")
                inspect(child, f"{path}.{key}")
        elif isinstance(item, list):
            for index, child in enumerate(item):
                inspect(child, f"{path}[{index}]")
        elif isinstance(item, str) and SECRET_ARG.search(item):
            raise ValueError(f"{path} looks like it contains credential material")

    inspect(settings)
    return settings


def fixture_hash(fixture: dict[str, str] = FIXTURE) -> str:
    digest = hashlib.sha256()
    for name, content in sorted(fixture.items()):
        digest.update(name.encode() + b"\0" + content.encode() + b"\0")
    return digest.hexdigest()


def run_agent(name: str, template: str, run_dir: Path, model: str, endpoint: str, settings: dict, timeout: float,
              fixture: dict[str, str] = FIXTURE, acceptance: str = ACCEPTANCE) -> dict:
    workspace = run_dir / name
    workspace.mkdir()
    for filename, content in fixture.items():
        (workspace / filename).write_text(content, encoding="utf-8")
    values = {
        "workspace": str(workspace),
        "task_file": str(workspace / "TASK.md"),
        "prompt": fixture["TASK.md"].strip(),
        "source_files_json": json.dumps(sorted(set(fixture) - {"TASK.md"})),
        "model": model,
        "endpoint": endpoint,
        "settings_json": json.dumps(settings, sort_keys=True),
    }
    env = os.environ.copy()
    env.update({
        "CODING_AGENT_COMPARISON_MODEL": model,
        "CODING_AGENT_COMPARISON_ENDPOINT": endpoint,
        "CODING_AGENT_COMPARISON_SETTINGS_JSON": values["settings_json"],
    })
    started = time.monotonic()
    argv_display = None
    command_error = None
    timed_out = False
    try:
        argv = command_argv(template, values)
        # Record only the supplied, credential-checked template for reruns.
        argv_display = shlex.split(template)
        process = subprocess.Popen(argv, cwd=workspace, env=env, start_new_session=(os.name == "posix"))
        try:
            command_returncode = process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            timed_out = True
            if os.name == "posix":
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            else:
                process.kill()
            process.wait()
            raise
    except (OSError, ValueError, subprocess.TimeoutExpired) as exc:
        command_error = type(exc).__name__
        command_returncode = None
    seconds = round(time.monotonic() - started, 3)
    acceptance_timed_out = False
    try:
        check = subprocess.run(
            [sys.executable, "-c", acceptance], cwd=workspace,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False,
            env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
            timeout=ACCEPTANCE_TIMEOUT,
        )
        acceptance_returncode = check.returncode
    except subprocess.TimeoutExpired:
        acceptance_timed_out = True
        acceptance_returncode = None
    return {
        "command_template": argv_display,
        "command_returncode": command_returncode,
        "command_error": command_error,
        "timed_out": timed_out,
        "seconds": seconds,
        "acceptance_command": [sys.executable, "-c", acceptance],
        "acceptance_returncode": acceptance_returncode,
        "acceptance_timed_out": acceptance_timed_out,
        "passed": acceptance_returncode == 0,
        "manual_interventions": {"count": None, "notes": [], "operator_recorded": False},
        "workspace": str(workspace),
    }


def run_comparison(args) -> int:
    if not args.model.strip():
        raise ValueError("model must not be empty")
    if not math.isfinite(args.timeout) or args.timeout <= 0:
        raise ValueError("timeout must be a positive finite number")
    endpoint = validate_endpoint(args.endpoint)
    settings = parse_settings(args.settings_json)
    case_name = getattr(args, "case", "wiring")
    if case_name not in CASES:
        raise ValueError("case must be wiring or multifile")
    fixture, acceptance = CASES[case_name]
    commands = {"novum": args.novum_command, "aider": args.aider_command}
    # Validate both templates before creating any run artifacts.
    for command in commands.values():
        command_argv(command, {key: "placeholder" for key in ("workspace", "task_file", "prompt", "model", "endpoint", "settings_json", "source_files_json")})
    run_dir = Path(args.output_dir).resolve()
    run_dir.mkdir(parents=True, exist_ok=False)
    started_at = datetime.now(timezone.utc).isoformat()
    results = {}
    order = getattr(args, "order", "novum-first")
    if order not in {"novum-first", "aider-first"}:
        raise ValueError("order must be novum-first or aider-first")
    run_order = AGENTS if order == "novum-first" else tuple(reversed(AGENTS))
    for name in run_order:
        results[name] = run_agent(name, commands[name], run_dir, args.model, endpoint, settings, args.timeout,
                                  fixture, acceptance)
        report = {
            "schema_version": 1,
            "started_at": started_at,
            "model": args.model,
            "endpoint": endpoint,
            "settings": settings,
            "case": case_name,
            "run_order": list(run_order),
            "fixture_sha256": fixture_hash(fixture),
            "source_files": sorted(set(fixture) - {"TASK.md"}),
            "task": fixture["TASK.md"],
            "results": results,
            "model_output_saved": False,
            "credentials_saved": False,
        }
        (run_dir / "report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    return 0 if all(result["passed"] for result in results.values()) else 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", required=True)
    parser.add_argument("--endpoint", required=True, help="Shared non-secret model endpoint URL")
    parser.add_argument("--settings-json", required=True, help="Shared non-secret generation settings as JSON object")
    parser.add_argument("--order", choices=("novum-first", "aider-first"), default="novum-first",
                        help="Which agent runs first (default: novum-first)")
    parser.add_argument("--case", choices=tuple(CASES), default="wiring",
                        help="Fixture to compare (default: wiring)")
    parser.add_argument("--novum-command", required=True, help="Quoted argv template; supports {workspace}, {task_file}, {prompt}, {model}, {endpoint}, {settings_json}, {source_files_json}")
    parser.add_argument("--aider-command", required=True, help="Quoted argv template; same placeholders as --novum-command")
    parser.add_argument("--output-dir", required=True, help="New directory for isolated workspaces and report")
    parser.add_argument("--timeout", type=float, default=600, help="Maximum seconds per agent command (default: 600)")
    args = parser.parse_args()
    try:
        return run_comparison(args)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        parser.error(str(exc))


if __name__ == "__main__":
    raise SystemExit(main())
