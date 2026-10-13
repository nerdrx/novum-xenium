"""Aider CLI adapter for scripts/coding_agent_comparison.py."""
from __future__ import annotations

import argparse
import json
import math
import os
from pathlib import Path
import re
import signal
import shutil
import subprocess
import sys
import tempfile
from urllib.parse import urlsplit


SECRET_KEY = re.compile(
    r"(?i)(?:^|[_-])(?:api[_-]?key|access[_-]?token|token|secret|password|authorization|credential)(?:$|[_-])"
)
ENV_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def parse_settings(raw: str) -> dict:
    settings = json.loads(raw)
    if not isinstance(settings, dict):
        raise ValueError("settings must be a JSON object")

    def check(value):
        if isinstance(value, dict):
            for key, child in value.items():
                if SECRET_KEY.search(str(key)):
                    raise ValueError("settings cannot contain credential-like fields")
                check(child)
        elif isinstance(value, list):
            for child in value:
                check(child)

    check(settings)
    return settings


def validate_endpoint(endpoint: str) -> str:
    parts = urlsplit(endpoint)
    if (parts.scheme not in {"http", "https"} or not parts.hostname
            or parts.username or parts.password or parts.query or parts.fragment):
        raise ValueError("endpoint must be an HTTP(S) URL without credentials, query, or fragment")
    return endpoint.rstrip("/")


def model_identifier(model: str, provider: str) -> str:
    prefix = "ollama_chat" if provider == "ollama" else "openai"
    if model.startswith(prefix + "/"):
        return model
    if "/" in model or not model.strip():
        raise ValueError("model must be a bare model name or use the selected provider prefix")
    return f"{prefix}/{model}"


def write_aider_config(directory: Path, model: str, settings: dict) -> tuple[Path, Path]:
    """Write credential-free JSON documents, which are valid YAML for Aider."""
    model_settings = directory / "model-settings.yml"
    model_settings.write_text(json.dumps([{
        "name": model,
        "use_temperature": "temperature" in settings,
        "extra_params": settings,
    }], indent=2) + "\n", encoding="utf-8")
    config = directory / "aider.conf.yml"
    config.write_text(json.dumps({
        "model": model,
        "model-settings-file": str(model_settings),
    }, indent=2) + "\n", encoding="utf-8")
    return config, model_settings


def build_command(
    aider: str, model: str, task_file: Path, config: Path,
    model_settings: Path, empty_env_file: Path, temp_dir: Path,
) -> list[str]:
    return [
        aider,
        "--config", str(config),
        "--env-file", str(empty_env_file),
        "--model-settings-file", str(model_settings),
        "--model", model,
        "--file", "calc.py",
        "--message-file", str(task_file),
        "--input-history-file", str(temp_dir / "input-history"),
        "--chat-history-file", str(temp_dir / "chat-history"),
        "--no-git",
        "--no-auto-commits",
        "--yes",
        "--no-check-update",
        "--analytics-disable",
        "--no-pretty",
    ]


def child_environment(
    endpoint: str, provider: str, base: dict[str, str] | None = None,
    pass_env: tuple[str, ...] = (),
) -> dict[str, str]:
    source = os.environ if base is None else base
    safe_names = {
        "PATH", "LANG", "LC_ALL", "LC_CTYPE", "SYSTEMROOT", "WINDIR",
        "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE",
    }
    env = {key: source[key] for key in safe_names if key in source}
    api_key = "OLLAMA_API_KEY" if provider == "ollama" else "OPENAI_API_KEY"
    if api_key in source:
        env[api_key] = source[api_key]
    for key in pass_env:
        if not ENV_NAME.fullmatch(key) or key.startswith("AIDER_") or key not in source:
            raise ValueError(f"requested environment variable is invalid or missing: {key}")
        env[key] = source[key]
    if provider == "ollama":
        env["OLLAMA_API_BASE"] = endpoint
    else:
        env["OPENAI_API_BASE"] = endpoint
    return env


def run(args) -> int:
    endpoint = validate_endpoint(args.endpoint)
    settings = parse_settings(args.settings_json)
    model = model_identifier(getattr(args, "endpoint_model", None) or args.model, args.provider)
    workspace = Path.cwd().resolve()
    task_file = Path(args.task_file).resolve()
    try:
        task_file.relative_to(workspace)
    except ValueError as exc:
        raise ValueError("task file must be inside the agent workspace") from exc
    if not task_file.is_file() or not (workspace / "calc.py").is_file():
        raise ValueError("expected TASK.md and calc.py in the agent workspace")
    aider = shutil.which(args.aider_bin)
    if not aider:
        raise ValueError("Aider executable not found; pass --aider-bin with its isolated path")

    with tempfile.TemporaryDirectory(prefix="nx-aider-comparison-") as directory:
        temp_dir = Path(directory)
        (temp_dir / "home").mkdir()
        (temp_dir / "xdg").mkdir()
        (temp_dir / "cache").mkdir()
        empty_env_file = temp_dir / "empty.env"
        empty_env_file.write_text("", encoding="utf-8")
        # Isolate Aider's home and XDG config/cache, while preserving explicit
        # provider keys in the caller's environment.
        env = child_environment(endpoint, args.provider, pass_env=tuple(getattr(args, "pass_env", ())))
        env["HOME"] = str(temp_dir / "home")
        env["XDG_CONFIG_HOME"] = str(temp_dir / "xdg")
        env["XDG_CACHE_HOME"] = str(temp_dir / "cache")
        config, model_settings = write_aider_config(temp_dir, model, settings)
        command = build_command(aider, model, task_file, config, model_settings, empty_env_file, temp_dir)
        process = subprocess.Popen(command, cwd=workspace, env=env, start_new_session=(os.name == "posix"))
        try:
            returncode = process.wait(timeout=args.timeout)
        except subprocess.TimeoutExpired:
            if os.name == "posix":
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            else:
                process.kill()
            process.wait()
            print("Aider exceeded adapter timeout", file=sys.stderr)
            return 124
    return returncode


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--task-file", required=True)
    parser.add_argument("--model", default=os.getenv("CODING_AGENT_COMPARISON_MODEL", ""))
    parser.add_argument("--endpoint-model", help="Model ID advertised by the shared HTTP endpoint")
    parser.add_argument("--endpoint", default=os.getenv("CODING_AGENT_COMPARISON_ENDPOINT", ""))
    parser.add_argument("--settings-json", default=os.getenv("CODING_AGENT_COMPARISON_SETTINGS_JSON", "{}"))
    parser.add_argument("--provider", choices=("ollama", "openai-compatible"), default="ollama")
    parser.add_argument("--aider-bin", default="aider")
    parser.add_argument("--pass-env", action="append", default=[], metavar="NAME",
                        help="Pass one additional caller environment variable by name")
    parser.add_argument("--timeout", type=float, default=600)
    args = parser.parse_args()
    if not args.model:
        parser.error("supply --model or CODING_AGENT_COMPARISON_MODEL")
    if not args.endpoint:
        parser.error("supply --endpoint or CODING_AGENT_COMPARISON_ENDPOINT")
    if not math.isfinite(args.timeout) or args.timeout <= 0:
        parser.error("--timeout must be a positive finite number")
    try:
        return run(args)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        parser.error(str(exc))


if __name__ == "__main__":
    raise SystemExit(main())
