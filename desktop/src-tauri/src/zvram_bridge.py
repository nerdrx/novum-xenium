"""Typed host adapter for the Novum Xenium zVram provider."""

import contextlib
from concurrent.futures import ThreadPoolExecutor
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import re
import socket
import shutil
import sys
import urllib.error
import urllib.request
import uuid


_ALLOWED_KEYS = {
    "action", "profile", "model", "alias", "port", "context", "compressed",
    "resident_mib", "cold_mib", "clean_cache_mib", "headroom_mib", "virtual_gib",
    "ignore_swap_guard",
}
_PROFILE_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,63}\Z")
_ALIAS_RE = re.compile(r"[A-Za-z0-9_.:/-]{1,128}\Z")
_MODEL_LIMIT = 256
_PROFILE_LIMIT = 128
_STATE_NAME = "novum_profiles.json"
_IGNORE_SWAP_GUARD_VERSION = (0, 4, 2)


def _supports_ignore_swap_guard(root):
    try:
        version = (Path(root) / "VERSION").read_text().strip()
        match = re.match(r"^(\d+)\.(\d+)\.(\d+)", version)
        return bool(match and tuple(map(int, match.groups())) >= _IGNORE_SWAP_GUARD_VERSION)
    except OSError:
        return False


def _load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise ValueError("zVram installation is incomplete")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    try:
        spec.loader.exec_module(module)
    except Exception:
        sys.modules.pop(name, None)
        raise
    return module


def _load_runtime(root):
    root = Path(root).expanduser().resolve(strict=True)
    if not root.is_dir():
        raise ValueError("zVram installation is unavailable")
    model_file = root / "zvram_model.py"
    manager_file = root / "zvram_manager.py"
    if not model_file.is_file() or not manager_file.is_file():
        raise ValueError("zVram installation is incomplete")
    # The native picker/discovery validates this trusted local installation.
    # -I excludes the working directory; zVram's own sibling modules still need it.
    sys.path.insert(0, str(root))
    model = _load_module("zvram_model", model_file)
    manager = _load_module("zvram_manager", manager_file)
    if Path(model.ROOT).resolve() != root or Path(manager.ROOT).resolve() != root:
        raise ValueError("zVram installation root does not match its helpers")
    return model, manager


def _manager_home():
    state_root = Path(os.environ.get("XDG_STATE_HOME", Path.home() / ".local/state"))
    return state_root / "novum-xenium" / "zvram"


def _read_state(manager):
    path = manager.home / _STATE_NAME
    try:
        info = path.lstat()
    except FileNotFoundError:
        return {}
    if path.is_symlink() or info.st_uid != os.getuid() or not path.is_file():
        raise ValueError("Unsafe Novum zVram profile state")
    value = json.loads(path.read_text())
    if not isinstance(value, dict):
        raise ValueError("Invalid Novum zVram profile state")
    return value


def _write_state(manager, value):
    path = manager.home / _STATE_NAME
    temp = path.with_name(path.name + "." + uuid.uuid4().hex)
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump(value, stream, separators=(",", ":"))
        os.replace(temp, path)
    finally:
        try:
            temp.unlink()
        except FileNotFoundError:
            pass


@contextlib.contextmanager
def _adapter_lock(manager):
    path = manager.home / "novum.lock"
    fd = os.open(path, os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0), 0o600)
    with os.fdopen(fd, "w") as stream:
        fcntl.flock(stream, fcntl.LOCK_EX)
        yield


def _clean_text(value, limit=240):
    text = str(value or "")
    text = re.sub(r"[\x00-\x1f\x7f]", " ", text)
    text = re.sub(r"(?i)(cookie|token|password|authorization|secret)(\s*[:=]\s*)\S+", r"\1\2[redacted]", text)
    text = re.sub(r"(https?://)[^/@\s:]+:[^/@\s]+@", r"\1[redacted]@", text)
    return re.sub(r"\s+", " ", text).strip()[:limit]


def _request_object(value):
    if not isinstance(value, dict):
        raise ValueError("Request must be a JSON object")
    unknown = set(value) - _ALLOWED_KEYS
    if unknown:
        raise ValueError("Request contains unsupported fields")
    action = value.get("action")
    if action not in {"status", "save", "start", "stop", "register"}:
        raise ValueError("Unsupported zVram action")
    return value


def _integer(request, key, default, minimum=1, maximum=1048576):
    value = request.get(key)
    if value is None:
        value = default
    if type(value) is not int or not minimum <= value <= maximum:
        raise ValueError(f"{key} must be an integer between {minimum} and {maximum}")
    return value


def _model_rows(model_helper, backend_checkout):
    rows = []
    for item in model_helper.discover_models(backend_checkout)[:_MODEL_LIMIT]:
        try:
            path = Path(item["path"]).expanduser().resolve(strict=True)
            size = item["size"]
            name = item["name"]
            if not path.is_file() or type(size) is not int or size < 0 or not isinstance(name, str):
                continue
            rows.append({"name": _clean_text(name, 256), "path": str(path), "size": size})
        except (KeyError, OSError, TypeError, ValueError):
            continue
    return rows


def _profile_name(request, alias, model_name):
    name = request.get("profile")
    if name is None:
        name = re.sub(r"[^A-Za-z0-9_.-]+", "-", alias or model_name).strip("-._")
        name = (name or "model")[:64]
        if not name[0].isalnum():
            name = "p-" + name[:62]
    if not isinstance(name, str) or not _PROFILE_RE.fullmatch(name):
        raise ValueError("profile must use 1-64 letters, numbers, dots, underscores or hyphens")
    return name


def _parameters(request, model_helper, backend_checkout):
    models = _model_rows(model_helper, backend_checkout)
    model_value = request.get("model")
    if not isinstance(model_value, str):
        raise ValueError("model must be a discovered GGUF path")
    try:
        model_path = str(Path(model_value).expanduser().resolve(strict=True))
    except (OSError, ValueError):
        raise ValueError("model must be a discovered GGUF path") from None
    model = next((item for item in models if item["path"] == model_path), None)
    if model is None:
        raise ValueError("model must be a discovered GGUF path")

    alias = request.get("alias")
    if alias is None:
        alias = model["name"]
    if not isinstance(alias, str) or not _ALIAS_RE.fullmatch(alias):
        raise ValueError("alias contains unsupported characters")
    port = _integer(request, "port", 8097, 1, 65535)
    context = _integer(request, "context", 4096)
    compressed = request.get("compressed", False)
    if compressed is None:
        compressed = False
    if type(compressed) is not bool:
        raise ValueError("compressed must be a boolean")
    ignore_swap_guard = request.get("ignore_swap_guard", False)
    if type(ignore_swap_guard) is not bool:
        raise ValueError("ignore_swap_guard must be a boolean")
    values = {
        "resident_mib": _integer(request, "resident_mib", 19456),
        "cold_mib": _integer(request, "cold_mib", 26624),
        "clean_cache_mib": _integer(request, "clean_cache_mib", 1024),
        "headroom_mib": _integer(request, "headroom_mib", 1536),
        "virtual_gib": _integer(request, "virtual_gib", 96),
    }
    if values["clean_cache_mib"] > values["cold_mib"]:
        raise ValueError("clean_cache_mib cannot exceed cold_mib")
    return {
        "model": model["path"], "model_name": model["name"], "alias": alias,
        "port": port, "context": context, "compressed": compressed,
        "ignore_swap_guard": ignore_swap_guard, **values,
    }


def _model_server(model_helper):
    candidates = [getattr(model_helper, "DEFAULT_SERVER", None), shutil.which("llama-server"),
                  Path.home() / ".local/bin/llama-server"]
    for candidate in candidates:
        if candidate:
            path = Path(candidate).expanduser()
            if path.is_file() and os.access(path, os.X_OK):
                return str(path.resolve())
    return None


def _build_manager_profile(model_helper, name, params):
    command, environment = model_helper.build_server_command(
        params["model"], params["alias"], port=params["port"],
        context=params["context"], compressed=params["compressed"],
        resident_mib=params["resident_mib"], cold_mib=params["cold_mib"],
        clean_cache_mib=params["clean_cache_mib"], headroom_mib=params["headroom_mib"],
        virtual_gib=params["virtual_gib"], server=_model_server(model_helper),
    )
    overrides = {key: value for key, value in environment.items()
                 if key.startswith(("ZVRAM_", "GGML_"))}
    return {
        "name": name, "priority": "normal", "mode": "wrapped", "command": command,
        "env": overrides, "resident_mib": params["resident_mib"] if params["compressed"] else None,
        "cold_mib": params["cold_mib"],
        "min_available_mib": 16384 if params["compressed"] else 4096,
        "ignore_swap_guard": params["ignore_swap_guard"],
    }


def _health(model_helper, alias, port):
    try:
        health = _local_json(f"http://127.0.0.1:{port}/health")
        healthy = (
            isinstance(health, dict) and health.get("status") in {"ok", "healthy"}
        ) or (isinstance(health, str) and health.strip().lower() in {"ok", "healthy"})
        if not healthy:
            return False
        response = _local_json(f"http://127.0.0.1:{port}/v1/models")
        return alias in [item.get("id") for item in response.get("data", [])]
    except (OSError, ValueError, KeyError, TypeError, urllib.error.URLError):
        return False


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, newurl):
        return None


def _local_json(url):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())
    try:
        with opener.open(url, timeout=0.4) as response:
            payload = response.read(1024 * 1024 + 1)
        if len(payload) > 1024 * 1024:
            raise ValueError("Local model response is too large")
        try:
            return json.loads(payload)
        except (json.JSONDecodeError, UnicodeDecodeError):
            return payload.decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        raise ValueError(f"Local health request failed (HTTP {exc.code})") from None


def _port_is_free(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        try:
            probe.bind(("127.0.0.1", port))
            return True
        except OSError:
            return False


def _start_manager(manager, name):
    # Manager workers merge os.environ into the child environment. Remove
    # inherited bridge variables while it builds/spawns the child so only the
    # typed, helper-generated profile overrides reach the model process.
    inherited = {key: value for key, value in os.environ.items()
                 if key.startswith("ZVRAM_")}
    try:
        for key in inherited:
            os.environ.pop(key, None)
        return manager.start(name)
    finally:
        os.environ.update(inherited)


def _owned_profile_running(manager_helper, manager, name, params):
    try:
        job = manager_helper.read_json(manager.job_path(name), {})
        if not manager_helper.owned_worker(job):
            return False
        pid = job.get("child_pid")
        if type(pid) is not int or pid <= 0:
            return False
        argv = [part.decode(errors="replace") for part in
                Path(f"/proc/{pid}/cmdline").read_bytes().split(b"\0") if part]
        return (
            _has_pair(argv, "--port", str(params["port"]))
            and _has_pair(argv, "--alias", params["alias"])
            and _has_pair(argv, "--host", "127.0.0.1")
        )
    except (OSError, KeyError, TypeError, ValueError):
        return False


def _has_pair(values, key, value):
    return any(values[index:index + 2] == [key, value] for index in range(len(values) - 1))


def _save_manager_profile(manager_helper, manager, profile, owned_names):
    name = profile["name"]
    manager.validate_name(name)
    command = profile.get("command")
    environment = profile.get("env", {})
    if (not isinstance(command, list) or not command
            or not all(isinstance(item, str) and item and "\0" not in item for item in command)):
        raise ValueError("Invalid generated model command")
    if not isinstance(environment, dict) or not all(
        isinstance(key, str) and isinstance(value, str) and "\0" not in value
        for key, value in environment.items()
    ):
        raise ValueError("Invalid generated model environment")
    allowed = {
        "name", "priority", "mode", "command", "resident_mib", "cold_mib",
        "env", "min_available_mib", "max_swap_growth_mib", "ignore_swap_guard",
    }
    stored = {key: value for key, value in profile.items() if key in allowed and value is not None}
    with manager.lock():
        profiles = manager_helper.read_json(manager.profiles_path, {})
        if not isinstance(profiles, dict):
            raise ValueError("Invalid manager profile state")
        job = manager_helper.read_json(manager.job_path(name), {})
        if manager_helper.owned_worker(job):
            raise ValueError("Stop the running profile before changing it")
        if name in profiles and name not in owned_names:
            raise ValueError("Profile is not owned by the Novum provider")
        profiles[name] = stored
        manager_helper.write_json(manager.profiles_path, profiles)


def _status(model_helper, manager_helper, manager, backend_checkout, params_state, installation):
    models = _model_rows(model_helper, backend_checkout)
    manager_rows = {row.get("name"): row for row in manager.list_profiles() if isinstance(row, dict)}
    profiles = []
    for name, params in sorted(params_state.items())[:_PROFILE_LIMIT]:
        if not isinstance(name, str) or not _PROFILE_RE.fullmatch(name) or not isinstance(params, dict):
            continue
        try:
            alias = params["alias"]
            port = params["port"]
            context = params["context"]
            compressed = params["compressed"]
            if (not isinstance(alias, str) or not _ALIAS_RE.fullmatch(alias)
                    or type(port) is not int or not 1 <= port <= 65535
                    or type(context) is not int or context <= 0
                    or type(compressed) is not bool):
                continue
        except KeyError:
            continue
        row = manager_rows.get(name, {})
        running = _owned_profile_running(manager_helper, manager, name, params)
        state = row.get("state", "stopped")
        if state not in {"starting", "running", "stopped", "exited", "failed"}:
            state = "stopped"
        profiles.append({
            "name": name, "alias": alias, "port": port, "context": context,
            "compressed": compressed, "running": running, "state": state,
            "ignore_swap_guard": params.get("ignore_swap_guard", False) is True,
            "healthy": False,
            "lastlog": _clean_text(row.get("lastlog", "")),
        })

    running_profiles = [profile for profile in profiles if profile["running"]]
    if running_profiles:
        with ThreadPoolExecutor(max_workers=min(8, len(running_profiles))) as pool:
            checks = {
                profile["name"]: pool.submit(_health, model_helper, profile["alias"], profile["port"])
                for profile in running_profiles
            }
            for profile in running_profiles:
                try:
                    profile["healthy"] = checks[profile["name"]].result(timeout=1.5)
                except Exception:
                    profile["healthy"] = False

    memory = manager_helper.memory_status()
    if not isinstance(memory, dict):
        memory = {}
    gpu = manager_helper.gpu_status()
    if not isinstance(gpu, list):
        gpu = []
    return {
        "available": True, "installation": installation,
        "ignore_swap_guard_supported": _supports_ignore_swap_guard(installation),
        "models": models, "profiles": profiles,
        "memory": {key: value for key, value in memory.items()
                   if isinstance(key, str) and type(value) is int},
        "gpu": [
            {key: value for key, value in item.items()
             if key in {"card", "vram_used_mib", "vram_total_mib", "gtt_used_mib"}
             and (key == "card" and isinstance(value, str) or type(value) is int or value is None)}
            for item in gpu if isinstance(item, dict)
        ],
    }


def dispatch(root, backend_checkout, cookie_path, backend_port, request, *, helpers=None, manager=None):
    """Execute one allowlisted action; dependencies can be injected by unit tests."""
    root = Path(root).expanduser().resolve(strict=True)
    backend_checkout = Path(backend_checkout).expanduser().resolve(strict=True)
    if not root.is_dir() or not backend_checkout.is_dir():
        raise ValueError("zVram or Novum checkout is unavailable")
    if helpers is None:
        model_helper, manager_helper = _load_runtime(root)
        helpers = (model_helper, manager_helper)
    else:
        model_helper, manager_helper = helpers
    try:
        backend_port = int(backend_port)
    except (TypeError, ValueError):
        raise ValueError("Novum backend port is invalid") from None
    if not 1 <= backend_port <= 65535:
        raise ValueError("Novum backend port is invalid")
    request = _request_object(request)
    manager = manager or manager_helper.Manager(home=_manager_home())

    with _adapter_lock(manager):
        params_state = _read_state(manager)
        action = request["action"]
        if action == "status":
            return _status(model_helper, manager_helper, manager, backend_checkout, params_state, str(root))

        name = request.get("profile")
        if action == "save":
            params = _parameters(request, model_helper, backend_checkout)
            if params["ignore_swap_guard"] and not _supports_ignore_swap_guard(root):
                raise ValueError("Ignoring the swap-growth guard requires zVram 0.4.2 or newer")
            if params["port"] == backend_port:
                raise ValueError("Profile port must differ from the Novum backend port")
            name = _profile_name(request, params["alias"], params["model_name"])
            rows = {row.get("name"): row for row in manager.list_profiles() if isinstance(row, dict)}
            if name in rows and name not in params_state:
                raise ValueError("Profile is not owned by the Novum provider")
            if name not in params_state and len(params_state) >= _PROFILE_LIMIT:
                raise ValueError("The Novum provider profile limit has been reached")
            if _owned_profile_running(manager_helper, manager, name, params_state.get(name, {})):
                raise ValueError("Stop the running profile before changing it")
            profile = _build_manager_profile(model_helper, name, params)
            _save_manager_profile(manager_helper, manager, profile, params_state)
            params_state[name] = params
            _write_state(manager, params_state)
            status = _status(model_helper, manager_helper, manager, backend_checkout, params_state, str(root))
            status["saved"] = True
            return status

        if not isinstance(name, str) or not _PROFILE_RE.fullmatch(name) or name not in params_state:
            raise ValueError("Select a saved Novum zVram profile")
        params = params_state[name]

        if action == "start":
            current = _parameters({**params, "profile": name}, model_helper, backend_checkout)
            if current["ignore_swap_guard"] and not _supports_ignore_swap_guard(root):
                raise ValueError("Ignoring the swap-growth guard requires zVram 0.4.2 or newer")
            if _owned_profile_running(manager_helper, manager, name, current):
                raise ValueError("Profile is already running")
            if not _port_is_free(current["port"]):
                raise ValueError("Profile port is already in use")
            _save_manager_profile(manager_helper, manager,
                                  _build_manager_profile(model_helper, name, current), params_state)
            _start_manager(manager, name)
            status = _status(model_helper, manager_helper, manager, backend_checkout, params_state, str(root))
            status["started"] = True
            return status
        if action == "stop":
            stopped = bool(manager.stop(name))
            status = _status(model_helper, manager_helper, manager, backend_checkout, params_state, str(root))
            status["stopped"] = stopped
            return status
        if action == "register":
            if not _owned_profile_running(manager_helper, manager, name, params):
                raise ValueError("Start this Novum-owned profile before registering it")
            if not _health(model_helper, params["alias"], params["port"]):
                raise ValueError("The owned model endpoint is not healthy with the requested alias")
            model_helper.register_endpoint(
                params["alias"], params["port"],
                xenium={"checkout": str(backend_checkout), "port": backend_port,
                        "cookie_file": str(cookie_path)},
            )
            status = _status(model_helper, manager_helper, manager, backend_checkout, params_state, str(root))
            status["registered"] = True
            return status
        raise ValueError("Unsupported zVram action")


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if len(argv) != 5:
        print(json.dumps({"error": "Expected ROOT BACKEND_CHECKOUT COOKIE_PATH BACKEND_PORT REQUEST_JSON"}))
        return 1
    root, backend_checkout, cookie_path, backend_port, request_json = argv
    if len(request_json) > 32768:
        print(json.dumps({"error": "Request is too large"}))
        return 1
    try:
        request = json.loads(request_json)
        result = dispatch(root, backend_checkout, cookie_path, backend_port, request)
        print(json.dumps(result, separators=(",", ":")))
        return 0
    except (OSError, ValueError, KeyError, TypeError, ImportError, AttributeError, RuntimeError) as exc:
        message = _clean_text(exc, 400) or "zVram request failed"
        print(json.dumps({"error": message}, separators=(",", ":")))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
