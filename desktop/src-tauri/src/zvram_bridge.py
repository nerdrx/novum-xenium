"""Typed host adapter for the Novum Xenium zVram provider."""

import contextlib
from concurrent.futures import ThreadPoolExecutor
import fcntl
import importlib.util
import inspect
import json
import os
from pathlib import Path
from pathlib import PurePosixPath
import re
import socket
import struct
import shutil
import stat
import subprocess
import sys
import time
import urllib.parse
import urllib.error
import urllib.request
import uuid


_ALLOWED_KEYS = {
    "action", "profile", "model", "alias", "port", "context", "compressed",
    "resident_mib", "cold_mib", "clean_cache_mib", "headroom_mib", "virtual_gib",
    "ignore_swap_guard", "min_available_mib",
    "live_control",
    "mode", "auto_start",
}
_PROFILE_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,63}\Z")
_ALIAS_RE = re.compile(r"[A-Za-z0-9_.:/-]{1,128}\Z")
_MODEL_LIMIT = 256
_PROFILE_LIMIT = 128
_STATE_NAME = "novum_profiles.json"
_IGNORE_SWAP_GUARD_VERSION = (0, 4, 2)
_ROUTER_NAME = "nx-zvram-router"
_ROUTER_MODES = {"regular", "zvram"}
_ROUTER_STOP_TIMEOUT = 10
_HF_CONTAINER_ROOT = PurePosixPath('/app/.cache/huggingface')


def _supports_ignore_swap_guard(root):
    try:
        version = (Path(root) / "VERSION").read_text().strip()
        match = re.match(r"^(\d+)\.(\d+)\.(\d+)", version)
        return bool(match and tuple(map(int, match.groups())) >= _IGNORE_SWAP_GUARD_VERSION)
    except OSError:
        return False


def _supports_live_control(model_helper):
    try:
        return "live_control" in inspect.signature(model_helper.build_server_command).parameters
    except (TypeError, ValueError, AttributeError):
        return False


def _supports_model_name(model_helper):
    try:
        parameters = inspect.signature(model_helper.build_server_command).parameters
        return "model_name" in parameters or any(
            item.kind is inspect.Parameter.VAR_KEYWORD for item in parameters.values()
        )
    except (TypeError, ValueError, AttributeError):
        return False


def _supports_native_mode(model_helper):
    try:
        parameters = inspect.signature(model_helper.build_server_command).parameters
        return "mode" in parameters or any(
            item.kind is inspect.Parameter.VAR_KEYWORD for item in parameters.values()
        )
    except (TypeError, ValueError, AttributeError):
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


def _read_installation_config(path):
    """Read the native app's user-owned install pointer without following links."""
    config = Path(path)
    if not config.is_absolute():
        raise ValueError("The zVram installation config path must be absolute")
    try:
        fd = os.open(config, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0))
    except OSError:
        raise ValueError("The saved zVram installation config is unavailable") from None
    try:
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                or info.st_mode & 0o022 or info.st_size > 4096):
            raise ValueError("The saved zVram installation config is unsafe")
        with os.fdopen(fd, "rb", closefd=False) as stream:
            raw = stream.read(4097)
        if len(raw) > 4096:
            raise ValueError("The saved zVram installation config is too large")
    finally:
        os.close(fd)
    try:
        value = json.loads(raw)
    except (json.JSONDecodeError, UnicodeDecodeError):
        raise ValueError("The saved zVram installation config is invalid") from None
    if not isinstance(value, dict) or set(value) != {"checkout"}:
        raise ValueError("The saved zVram installation config is invalid")
    checkout = value.get("checkout")
    if not isinstance(checkout, str) or not checkout or not Path(checkout).is_absolute():
        raise ValueError("The saved zVram installation path is invalid")
    try:
        root = Path(checkout).resolve(strict=True)
    except OSError:
        raise ValueError("The configured zVram installation is unavailable") from None
    if not root.is_dir():
        raise ValueError("The configured zVram installation is unavailable")
    return root


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
    if action not in {"status", "save", "start", "stop", "register", "router_start", "router_stop", "router_register", "router_configure", "router_sync"}:
        raise ValueError("Unsupported zVram action")
    return {key: item for key, item in value.items() if item is not None}


def _integer(request, key, default, minimum=1, maximum=1048576):
    value = request.get(key)
    if value is None:
        value = default
    if type(value) is not int or not minimum <= value <= maximum:
        raise ValueError(f"{key} must be an integer between {minimum} and {maximum}")
    return value


def _model_rows(model_helper, backend_checkout, cached_models=()):
    rows = []
    for item in model_helper.discover_models(backend_checkout)[:_MODEL_LIMIT]:
        try:
            path = Path(item["path"]).expanduser().resolve(strict=True)
            size = item["size"]
            name = item["name"]
            if not path.is_file() or type(size) is not int or size < 0 or not isinstance(name, str):
                continue
            row = {"name": _clean_text(name, 256), "path": str(path), "size": size}
            projector_value = item.get("mmproj_path")
            if isinstance(projector_value, str):
                projector = _verified_projector_path(projector_value, backend_checkout)
                if projector is not None:
                    row["mmproj_path"] = str(projector)
            rows.append(row)
        except (KeyError, OSError, TypeError, ValueError):
            continue
    # Explicit user-owned GGUF directories let the router serve local libraries
    # such as Hugging Face snapshots without importing them into Ollama.
    config_path = Path.home() / ".config/dev.novum.xenium/config.json"
    try:
        config = json.loads(config_path.read_text())
        configured_checkout = Path(config["checkout"]).expanduser().resolve()
        roots = config.get("model_roots", []) if configured_checkout == Path(backend_checkout).resolve() else []
    except (OSError, ValueError, KeyError, TypeError):
        roots = []
    if not isinstance(roots, list):
        roots = []
    seen = {row["name"] for row in rows}
    for value in roots:
        if not isinstance(value, str):
            continue
        try:
            root = Path(value).expanduser().resolve(strict=True)
            if not root.is_dir():
                continue
            for candidate in sorted(root.rglob("*.gguf")):
                split = re.fullmatch(r'(.+)-(\d+)-of-(\d+)\.gguf', candidate.name, re.IGNORECASE)
                if split and int(split.group(2)) != 1:
                    continue
                path = candidate.resolve(strict=True)
                if not path.is_file() or not _text_gguf_architecture(path):
                    continue
                if split:
                    parts = int(split.group(3))
                    if parts < 2 or parts > 10000:
                        continue
                    complete = True
                    for part_number in range(2, parts + 1):
                        sibling = candidate.with_name(
                            f'{split.group(1)}-{part_number:0{len(split.group(2))}d}'
                            f'-of-{parts:0{len(split.group(3))}d}.gguf'
                        )
                        try:
                            part_path = sibling.resolve(strict=True)
                            if not part_path.is_file():
                                complete = False
                                break
                            with part_path.open('rb') as stream:
                                if stream.read(4) != b'GGUF':
                                    complete = False
                                    break
                        except OSError:
                            complete = False
                            break
                    if not complete:
                        continue
                repository = next((part.removeprefix("models--").replace("--", "/")
                                   for part in candidate.parts if part.startswith("models--")), None)
                stem = split.group(1) if split else candidate.stem
                name = f"{repository}:{stem}" if repository else f"{root.name}:{stem}"
                if name in seen or not _ALIAS_RE.fullmatch(name):
                    continue
                rows.append({"name": name, "path": str(path), "size": path.stat().st_size})
                seen.add(name)
        except (OSError, ValueError):
            continue
    for item in cached_models:
        try:
            name = item['name']
            path = Path(item['path']).expanduser().resolve(strict=True)
            if (name in seen or not isinstance(name, str) or not _ALIAS_RE.fullmatch(name)
                    or not path.is_file() or not _text_gguf_architecture(path)):
                continue
            rows.append({'name': name, 'path': str(path), 'size': path.stat().st_size})
            seen.add(name)
        except (KeyError, OSError, TypeError, ValueError):
            continue
    return rows


def _verified_projector_path(value, backend_checkout):
    """Accept only a direct GGUF Ollama projector blob from local storage."""
    if not re.fullmatch(r"sha256-[0-9a-f]{64}", Path(value).name):
        return None
    try:
        blobs = (Path(backend_checkout) / "data/ollama/models/blobs").resolve(strict=True)
        raw = Path(value).expanduser()
        if raw.is_symlink():
            return None
        path = raw.resolve(strict=True)
        if path.parent != blobs or not path.is_file():
            return None
        with path.open("rb") as stream:
            if stream.read(4) != b"GGUF":
                return None
        return path
    except (OSError, ValueError):
        return None


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


def _parameters(request, model_helper, backend_checkout, ignore_swap_guard_default=False,
                cached_models=()):
    models = _model_rows(model_helper, backend_checkout, cached_models)
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
    context = _integer(request, "context", 32768)
    compressed = request.get("compressed", False)
    if compressed is None:
        compressed = False
    if type(compressed) is not bool:
        raise ValueError("compressed must be a boolean")
    mode = request.get("mode", "zvram")
    if not isinstance(mode, str) or mode not in _ROUTER_MODES:
        raise ValueError("mode must be regular or zvram")
    if mode == "regular":
        compressed = False
    ignore_swap_guard = request.get("ignore_swap_guard", ignore_swap_guard_default)
    if ignore_swap_guard is None:
        ignore_swap_guard = False
    if type(ignore_swap_guard) is not bool:
        raise ValueError("ignore_swap_guard must be a boolean")
    live_control_supported = _supports_live_control(model_helper)
    live_control = request.get("live_control", live_control_supported if mode == "zvram" else False)
    if live_control is None:
        live_control = live_control_supported
    if type(live_control) is not bool:
        raise ValueError("live_control must be a boolean")
    if compressed:
        live_control = True
    elif mode == "zvram" and live_control and not live_control_supported:
        raise ValueError("Live VRAM management requires a newer zVram installation")
    if mode == "regular":
        live_control = False
        ignore_swap_guard = False
    values = {
        "resident_mib": _integer(request, "resident_mib", 19456),
        "cold_mib": _integer(request, "cold_mib", 26624),
        "clean_cache_mib": _integer(request, "clean_cache_mib", 1024),
        "headroom_mib": _integer(request, "headroom_mib", 1536),
        "virtual_gib": _integer(request, "virtual_gib", 96),
        "min_available_mib": _integer(request, "min_available_mib", 16384 if compressed else 4096, 0),
    }
    if values["clean_cache_mib"] > values["cold_mib"]:
        raise ValueError("clean_cache_mib cannot exceed cold_mib")
    return {
        "model": model["path"], "model_name": model["name"], "alias": alias,
        "port": port, "context": context, "compressed": compressed,
        "ignore_swap_guard": ignore_swap_guard, **values,
        "live_control": live_control,
        "mode": mode,
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


def _validate_ram_guard(manager_helper, params):
    if params.get("min_available_mib") == 0 and getattr(manager_helper, "RAM_GUARD_CAN_DISABLE", False) is not True:
        raise ValueError("Keeping the provider running under low RAM requires a newer zVram manager")


def _build_manager_profile(model_helper, name, params):
    options = dict(
        port=params["port"],
        context=params["context"], compressed=params["compressed"],
        resident_mib=params["resident_mib"], cold_mib=params["cold_mib"],
        clean_cache_mib=params["clean_cache_mib"], headroom_mib=params["headroom_mib"],
        virtual_gib=params["virtual_gib"], server=_model_server(model_helper),
    )
    if _supports_live_control(model_helper):
        options["live_control"] = params["live_control"]
    if _supports_model_name(model_helper) and isinstance(params.get("model_name"), str):
        options["model_name"] = params["model_name"]
    mode = params.get("mode", "zvram")
    if mode not in _ROUTER_MODES:
        raise ValueError("mode must be regular or zvram")
    if mode == "regular":
        options.update(mode="native", compressed=False)
    command, environment = model_helper.build_server_command(params["model"], params["alias"], **options)
    if mode == "regular" and not _supports_native_mode(model_helper):
        try:
            command = command[command.index("--") + 1:]
        except ValueError:
            raise ValueError("Installed model helper cannot build a native llama-server command") from None
    overrides = ({key: value for key, value in environment.items()
                  if key.startswith(("ZVRAM_", "GGML_"))} if mode == "zvram" else {})
    return {
        "name": name, "priority": "normal", "mode": "native" if mode == "regular" else "wrapped", "command": command,
        "env": overrides, "resident_mib": params["resident_mib"] if params["compressed"] else None,
        "cold_mib": params["cold_mib"],
        "min_available_mib": params.get("min_available_mib", 16384 if params["compressed"] else 4096),
        "ignore_swap_guard": params["ignore_swap_guard"] if mode == "zvram" else False,
        "live_control": params["live_control"],
    }


def _router_supported(model_helper):
    binary = _model_server(model_helper)
    if not binary:
        return False
    try:
        result = subprocess.run([binary, '--help'], capture_output=True, timeout=5)
        return result.returncode == 0 and all(flag in result.stdout + result.stderr for flag in
            (b'--models-preset', b'--models-max', b'--models-autoload'))
    except (OSError, subprocess.TimeoutExpired):
        return False


def _router_preset_path(manager):
    return manager.home / 'router-models.ini'


def _router_cache_path(manager):
    cache = manager.home / 'router-cache'
    cache.mkdir(mode=0o700, exist_ok=True)
    if cache.is_symlink() or cache.stat().st_uid != os.getuid():
        raise ValueError('Unsafe router cache directory')
    return cache


def _build_router_profile(model_helper, manager, params, models, backend_checkout):
    # Reuse the installed helper's paging options; only replace the single-model
    # server arguments. Router children inherit its arguments and environment.
    profile = _build_manager_profile(model_helper, _ROUTER_NAME, params)
    command = profile['command']
    start = 0 if params.get("mode", "zvram") == "regular" else command.index('--') + 1
    for flag in ('--model', '--alias'):
        index = command.index(flag, start)
        del command[index:index + 2]
    # The router command has no single model. Projectors belong in each model's
    # preset entry; never let a picked model's projector become router-global.
    if '--mmproj' in command[start:]:
        index = command.index('--mmproj', start)
        del command[index:index + 2]
    command += ['--models-preset', str(_router_preset_path(manager)), '--models-max', '1', '--models-autoload']
    _write_router_preset(manager, models, backend_checkout)
    profile['env']['LLAMA_CACHE'] = str(_router_cache_path(manager))
    return profile


def _write_router_preset(manager, models, backend_checkout):
    lines = ['version = 1', '']
    seen = set()
    for index, model in enumerate(models):
        name, path = model['name'], model['path']
        projector = model.get('mmproj_path')
        if not _ALIAS_RE.fullmatch(name) or name in seen or any(c in path for c in '\r\n\0;#') or path != path.strip():
            raise ValueError('A discovered model name or path cannot be represented safely in the router preset')
        seen.add(name)
        # llama.cpp normalizes preset section names; explicit aliases preserve chat IDs.
        lines += [f'[nx-model-{index}]', f'alias = {name}', f'model = {path}']
        if projector is not None:
            verified = _verified_projector_path(projector, backend_checkout)
            verified_text = str(verified) if verified is not None else ""
            if (verified is None or any(c in verified_text for c in '\r\n\0;#')
                    or verified_text != verified_text.strip()):
                raise ValueError('A discovered projector path cannot be represented safely in the router preset')
            lines.append(f'mmproj = {verified_text}')
        lines += ['load-on-startup = false', '']
    path = _router_preset_path(manager)
    temporary = path.with_name(path.name + '.' + uuid.uuid4().hex)
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    try:
        with os.fdopen(fd, 'w') as stream:
            stream.write('\n'.join(lines))
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _text_gguf_architecture(path):
    """Inspect bounded GGUF metadata, never infer text compatibility from magic alone."""
    try:
        with Path(path).open('rb') as stream:
            data = stream.read(1024 * 1024)
        offset = 0
        def take(size):
            nonlocal offset
            if size < 0 or offset + size > len(data):
                raise ValueError('GGUF metadata exceeds the inspection budget')
            value = data[offset:offset + size]
            offset += size
            return value
        def number(fmt):
            return struct.unpack('<' + fmt, take(struct.calcsize('<' + fmt)))[0]
        def string():
            return take(number('Q')).decode('utf-8')
        def value(kind, depth=0):
            if depth > 1:
                raise ValueError('Unsupported GGUF metadata nesting')
            if kind == 8:
                return string()
            if kind == 9:
                element, count = number('I'), number('Q')
                if count > 100000:
                    raise ValueError('GGUF metadata array exceeds the inspection budget')
                for _ in range(count):
                    value(element, depth + 1)
                return None
            sizes = {0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8}
            take(sizes[kind])
            return None
        if take(4) != b'GGUF' or number('I') not in (2, 3):
            return False
        number('Q')  # tensor count
        count = number('Q')
        if not 1 <= count <= 100000:
            return False
        for _ in range(count):
            key, kind = string(), number('I')
            item = value(kind)
            if key == 'general.architecture':
                return (kind == 8 and isinstance(item, str)
                        and bool(re.fullmatch(r'[a-z0-9_-]+', item))
                        and item not in {'clip', 'whisper', 't5', 't5encoder', 'flux', 'flux2',
                                         'sd1', 'sd2', 'sdxl', 'stable-diffusion'})
    except (OSError, ValueError, KeyError, struct.error, UnicodeError):
        pass
    return False


def _ready_cached_gguf_rows(model_helper, cookie_path, backend_port, cache_root):
    """Return only complete model GGUF files mapped from the container HF cache."""
    host_root = Path(cache_root).expanduser().resolve(strict=True)
    if not host_root.is_dir():
        raise ValueError('The configured model cache is unavailable')
    cookie = model_helper.session_cookie(cookie_path)
    data = model_helper._request(
        f'http://127.0.0.1:{backend_port}/api/model/cached', cookie,
    )
    if not isinstance(data, dict) or not isinstance(data.get('models'), list):
        raise ValueError('The cached model scan returned an invalid response')
    if data.get('error'):
        raise ValueError('The authenticated cached model scan is pending')

    ready = []
    for row in data['models']:
        if not isinstance(row, dict):
            continue
        if (row.get('has_incomplete') is not False or row.get('is_gguf') is not True
                or row.get('is_diffusion') is True or row.get('is_video') is True
                or row.get('is_adapter') is True):
            continue
        repo = row.get('repo_id')
        container_repo = row.get('path')
        if (not isinstance(repo, str)
                or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9][A-Za-z0-9_.-]*', repo)):
            continue
        try:
            repo_rel = PurePosixPath(container_repo).relative_to(_HF_CONTAINER_ROOT)
        except (TypeError, ValueError):
            continue
        if repo_rel.is_absolute() or any(part in ('', '.', '..') for part in repo_rel.parts):
            continue
        mapped_repo = host_root.joinpath(*repo_rel.parts, 'models--' + repo.replace('/', '--'))
        try:
            mapped_repo = mapped_repo.resolve(strict=True)
            mapped_repo.relative_to(host_root)
        except (OSError, ValueError):
            continue
        if not mapped_repo.is_dir():
            continue
        files = row.get('gguf_files')
        if not isinstance(files, list):
            continue
        for item in files:
            if not isinstance(item, dict) or item.get('role') not in ('model', 'main'):
                continue
            rel = item.get('rel_path')
            filename = item.get('name')
            if not isinstance(rel, str) or not isinstance(filename, str):
                continue
            rel_path = PurePosixPath(rel)
            if (rel_path.is_absolute() or any(part in ('', '.', '..') for part in rel_path.parts)
                    or rel_path.name != filename or not filename.lower().endswith('.gguf')):
                continue
            snapshot_file = mapped_repo / 'snapshots'
            snapshot_file = snapshot_file.joinpath(*rel_path.parts)
            try:
                file_path = snapshot_file.resolve(strict=True)
                file_path.relative_to(host_root)
                if not file_path.is_file():
                    continue
                if not _text_gguf_architecture(file_path):
                    continue
            except (OSError, ValueError):
                continue
            parts = item.get('parts', 1)
            if type(parts) is not int or not 1 <= parts <= 10000:
                continue
            split_match = None
            if item.get('split') is True:
                split_match = re.fullmatch(r'(.+)-(\d+)-of-(\d+)\.gguf', filename, re.IGNORECASE)
                if (not split_match or int(split_match.group(2)) != 1
                        or int(split_match.group(3)) != parts):
                    continue
                complete = True
                for number in range(2, parts + 1):
                    part_path = snapshot_file.with_name(
                        f'{split_match.group(1)}-{number:0{len(split_match.group(2))}d}'
                        f'-of-{parts:0{len(split_match.group(3))}d}.gguf'
                    )
                    try:
                        resolved = part_path.resolve(strict=True)
                        resolved.relative_to(host_root)
                        if not resolved.is_file():
                            complete = False
                            break
                        with resolved.open('rb') as stream:
                            if stream.read(4) != b'GGUF':
                                complete = False
                                break
                    except (OSError, ValueError):
                        complete = False
                        break
                if not complete:
                    continue
            stem = split_match.group(1) if split_match else Path(filename).stem
            stem = re.sub(r'[^A-Za-z0-9_.-]+', '-', stem).strip('-.')
            if not stem:
                continue
            alias = f'{repo}:{stem}'
            if len(alias) > 128 or not _ALIAS_RE.fullmatch(alias):
                continue
            # llama-server locates split siblings by their snapshot filenames.
            model_file = snapshot_file if split_match else file_path
            ready.append({'name': alias, 'path': str(model_file), 'size': file_path.stat().st_size})
    return ready


def _router_preset_entries(path):
    """Read aliases and paths without rewriting or normalizing existing bytes."""
    try:
        info = path.lstat()
    except FileNotFoundError:
        raise ValueError('The configured router preset is unavailable') from None
    if path.is_symlink() or not path.is_file() or info.st_uid != os.getuid():
        raise ValueError('Unsafe model router preset')
    content = path.read_bytes()
    try:
        text = content.decode('utf-8')
    except UnicodeDecodeError:
        raise ValueError('The model router preset is invalid') from None
    entries = {}
    section = None
    alias = None
    model_path = None
    section_ids = set()
    max_section = -1
    def save():
        if section is not None and alias is not None:
            if not model_path or alias in entries:
                raise ValueError('The model router preset has conflicting or incomplete aliases')
            entries[alias] = (section, model_path)
    for line in text.splitlines():
        header = re.fullmatch(r'\s*\[([^\]]+)\]\s*', line)
        if header:
            save()
            match = re.fullmatch(r'nx-model-(\d+)', header.group(1))
            section = int(match.group(1)) if match else None
            if section is not None:
                if section in section_ids:
                    raise ValueError('The model router preset has duplicate internal model IDs')
                section_ids.add(section)
                max_section = max(max_section, section)
            alias, model_path = None, None
        elif section is not None:
            match = re.fullmatch(r'\s*alias\s*=\s*(.*?)\s*', line)
            if match:
                alias = match.group(1)
            match = re.fullmatch(r'\s*model\s*=\s*(.*?)\s*', line)
            if match:
                model_path = match.group(1)
    save()
    return content, entries, max_section


def _append_router_preset(manager, models, backend_checkout):
    """Append only new model sections, preserving every current preset byte."""
    path = _router_preset_path(manager)
    content, entries, max_section = _router_preset_entries(path)
    seen = dict(entries)
    next_index = max_section + 1
    additions = []
    for model in models:
        name, raw_path = model['name'], model['path']
        model_path = Path(raw_path).expanduser().absolute()
        model_path.resolve(strict=True)
        if (not _ALIAS_RE.fullmatch(name) or any(c in str(model_path) for c in '\r\n\0;#')
                or str(model_path) != str(model_path).strip()):
            raise ValueError('A discovered model name or path cannot be represented safely in the router preset')
        previous = seen.get(name)
        if previous is not None:
            if previous[1] != str(model_path):
                continue  # Never replace an existing public alias with another file.
            continue
        seen[name] = (next_index, str(model_path))
        additions.extend([f'[nx-model-{next_index}]', f'alias = {name}', f'model = {model_path}', 'load-on-startup = false', ''])
        next_index += 1
    if not additions:
        return len(entries), 0
    suffix = ('\n' if content and not content.endswith(b'\n') else '') + ('\n' if content else '')
    updated = content + suffix.encode() + ('\n'.join(additions)).encode('utf-8')
    temporary = path.with_name(path.name + '.' + uuid.uuid4().hex)
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(updated)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)
    return len(seen), len(additions) // 5


def _sync_router_models(model_helper, manager_helper, manager, params, params_state,
                        backend_checkout, cookie_path, backend_port, cache_root):
    if params.get('router') is not True or not _owned_profile_running(manager_helper, manager, _ROUTER_NAME, params):
        raise ValueError('Start the owned model router before syncing cached models')
    if not _router_supported(model_helper):
        raise ValueError('The installed llama-server does not support live model reload')
    if not _router_status(model_helper, manager_helper, manager, params_state).get('healthy'):
        raise ValueError('The owned model router is not healthy')

    candidates = _ready_cached_gguf_rows(model_helper, cookie_path, backend_port, cache_root)
    _, added = _append_router_preset(manager, candidates, backend_checkout)
    _, preset_entries, _ = _router_preset_entries(_router_preset_path(manager))
    expected = list(dict.fromkeys([*params.get('model_ids', []), *[
        row['name'] for row in candidates
        if row['name'] in preset_entries and Path(preset_entries[row['name']][1]).resolve() == Path(row['path']).resolve()
    ]]))
    # Idempotent retry: a preset write can succeed while reload/registration fails.
    _local_json(f'http://127.0.0.1:{params["port"]}/models?reload=1', timeout=10)
    updated = {**params, 'model_ids': expected}
    _router_inventory(updated)
    params.update(model_ids=expected)
    params_state[_ROUTER_NAME] = params
    _write_state(manager, params_state)
    _register_router(model_helper, params, backend_checkout, cookie_path, backend_port)
    return {'added': added, 'models': len(expected)}


def _router_inventory(params):
    health = _local_json(f'http://127.0.0.1:{params["port"]}/health')
    if not isinstance(health, dict) or health.get('status') not in ('ok', 'healthy'):
        raise ValueError('The model router is not ready')
    inventory = _local_json(f'http://127.0.0.1:{params["port"]}/v1/models')
    if not isinstance(inventory, dict):
        raise ValueError('The model router returned an invalid inventory')
    rows = inventory.get('data', [])
    expected = params['model_ids']
    if not isinstance(rows, list):
        raise ValueError('The model router returned an invalid inventory')
    inventory = []
    for name in expected:
        row = next((row for row in rows if isinstance(row, dict) and
                    (row.get('id') == name or name in (row.get('aliases') or []))), None)
        if row is None:
            raise ValueError('The model router does not advertise the discovered models')
        status = row.get('status', {})
        inventory.append({'id': name, 'status': _clean_text(status.get('value', 'available'))
                          if isinstance(status, dict) else 'available'})
    return inventory


def _router_status(model_helper, manager_helper, manager, params_state):
    params = params_state.get(_ROUTER_NAME, {})
    result = {'name': _ROUTER_NAME, 'running': False, 'healthy': False, 'state': 'stopped',
              'port': params.get('port', 8097), 'context': params.get('context', 32768), 'models': []}
    if params.get('router') is not True:
        result.update(mode='regular', auto_start=True)
        return result
    row = next((row for row in manager.list_profiles() if row.get('name') == _ROUTER_NAME), {})
    result.update(state=row.get('state', 'stopped'), lastlog=_clean_text(row.get('lastlog', '')),
                  compressed=params.get('compressed', False), ignore_swap_guard=params.get('ignore_swap_guard', False),
                  min_available_mib=params.get('min_available_mib', 16384 if params.get('compressed') else 4096),
                  live_control=params.get('live_control', False) is True or params.get('compressed', False) is True)
    result.update(mode=params.get('mode', 'zvram'), auto_start=params.get('auto_start', True) is True)
    result['running'] = _owned_profile_running(manager_helper, manager, _ROUTER_NAME, params)
    if not result['running'] and result['state'] in ('starting', 'running'):
        worker_alive = manager_helper.owned_worker(manager_helper.read_json(manager.job_path(_ROUTER_NAME), {}))
        result['state'] = 'starting' if worker_alive else 'stopped'
    if result['state'] == 'stopped' and 'live_control' not in params:
        result['live_control'] = params.get('compressed', False) is True or _supports_live_control(model_helper)
    if result['running']:
        try:
            result['models'] = _router_inventory(params)
            result['healthy'] = True
        except (OSError, ValueError, TypeError, KeyError, urllib.error.URLError):
            pass
    return result


def _register_router(model_helper, params, backend_checkout, cookie_path, backend_port):
    models = _router_inventory(params)
    ids = [model['id'] for model in models]
    base = f'http://127.0.0.1:{params["port"]}/v1'
    cookie = model_helper.session_cookie(cookie_path)
    api = f'http://127.0.0.1:{backend_port}/api/model-endpoints'
    endpoints = model_helper._request(api, cookie)
    existing = next((ep for ep in endpoints if ep.get('base_url', '').rstrip('/') == base), None)
    name = 'Local models' if params.get('mode') == 'regular' else 'zVram · Local models'
    if existing:
        if existing.get('name') not in ('Local models', 'zVram · Local models'):
            raise ValueError('This port belongs to another provider')
        endpoint = model_helper._request(api + '/' + urllib.parse.quote(str(existing['id']), safe=''), cookie,
                                        'PATCH', {'name': name, 'is_enabled': True, 'pinned_models': ids})
    else:
        endpoint = model_helper._request(api, cookie, 'POST', {'name': name, 'base_url': base,
            'endpoint_kind': 'local', 'model_type': 'llm', 'skip_probe': 'false',
            'pinned_models': json.dumps(ids), 'shared': 'false'}, form=True)
    # Keep internal preset IDs out of the chat picker; requests use the public aliases.
    rows = _local_json(base + '/models').get('data', [])
    hidden = [row['id'] for row in rows if isinstance(row, dict) and
              isinstance(row.get('id'), str) and row['id'] not in ids]
    model_helper._request(api + '/' + urllib.parse.quote(str(endpoint['id']), safe='') + '/models',
                          cookie, 'PATCH', {'hidden': hidden, 'pinned_models': ids})
    return endpoint


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


def _local_json(url, timeout=0.4):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())
    try:
        with opener.open(url, timeout=timeout) as response:
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
        # Match llama-server: expired connections must not block a restart.
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
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
        child_identity = job.get("child_identity")
        if not isinstance(child_identity, dict) or manager_helper.identity(pid) != child_identity:
            return False
        stat_tail = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
        if int(stat_tail[1]) != job["identity"]["pid"]:
            return False
        argv = [part.decode(errors="replace") for part in
                Path(f"/proc/{pid}/cmdline").read_bytes().split(b"\0") if part]
        return (
            _has_pair(argv, "--port", str(params["port"]))
            and (_has_pair(argv, '--models-preset', str(_router_preset_path(manager))) if params.get('router')
                 else _has_pair(argv, "--alias", params["alias"]))
            and _has_pair(argv, "--host", "127.0.0.1")
            and manager_helper.identity(pid) == child_identity
        )
    except (OSError, KeyError, IndexError, TypeError, ValueError):
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
        "env", "min_available_mib", "max_swap_growth_mib", "ignore_swap_guard", "live_control",
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


def _wait_for_owned_worker_exit(manager_helper, manager, name):
    deadline = time.monotonic() + _ROUTER_STOP_TIMEOUT
    while time.monotonic() < deadline:
        job = manager_helper.read_json(manager.job_path(name), {})
        if not manager_helper.owned_worker(job):
            return
        time.sleep(0.1)
    raise ValueError("The owned model router did not stop in time")


def _status(model_helper, manager_helper, manager, backend_checkout, params_state, installation):
    models = _model_rows(model_helper, backend_checkout)
    manager_rows = {row.get("name"): row for row in manager.list_profiles() if isinstance(row, dict)}
    profiles = []
    for name, params in sorted(params_state.items())[:_PROFILE_LIMIT]:
        if not isinstance(name, str) or not _PROFILE_RE.fullmatch(name) or not isinstance(params, dict):
            continue
        if params.get('router') is True:
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
            "min_available_mib": params.get("min_available_mib", 16384 if compressed else 4096),
            "live_control": params.get("live_control", False) is True or compressed,
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
        "ram_guard_opt_out_supported": getattr(manager_helper, "RAM_GUARD_CAN_DISABLE", False) is True,
        "models": [{key: value for key, value in model.items() if key != "mmproj_path"}
                   for model in models], "profiles": profiles,
        "router": _router_status(model_helper, manager_helper, manager, params_state),
        "router_supported": _router_supported(model_helper),
        "live_control_supported": _supports_live_control(model_helper),
        "memory": {key: value for key, value in memory.items()
                   if isinstance(key, str) and type(value) is int},
        "gpu": [
            {key: value for key, value in item.items()
             if key in {"card", "vram_used_mib", "vram_total_mib", "gtt_used_mib"}
             and (key == "card" and isinstance(value, str) or type(value) is int or value is None)}
            for item in gpu if isinstance(item, dict)
        ],
    }


def dispatch(root, backend_checkout, cookie_path, backend_port, request, *, helpers=None, manager=None,
             cache_root=None):
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

        if action == 'router_sync':
            if cache_root is None:
                raise ValueError('The shared model cache is not configured')
            params = params_state.get(_ROUTER_NAME, {})
            result = _sync_router_models(
                model_helper, manager_helper, manager, params, params_state,
                backend_checkout, cookie_path, backend_port, cache_root,
            )
            status = _status(model_helper, manager_helper, manager, backend_checkout, params_state, str(root))
            status['router_sync'] = result
            return status

        if action.startswith('router_'):
            if action in ('router_start', 'router_configure'):
                if not _router_supported(model_helper):
                    raise ValueError('Install a llama-server build with model router support')
                previous = params_state.get(_ROUTER_NAME, {})
                running = _owned_profile_running(manager_helper, manager, _ROUTER_NAME, previous)
                if action == 'router_start' and manager_helper.owned_worker(manager_helper.read_json(manager.job_path(_ROUTER_NAME), {})):
                    raise ValueError('The model router is already running')
                cached_models = []
                if cache_root is not None:
                    cached_models = _ready_cached_gguf_rows(
                        model_helper, cookie_path, backend_port, cache_root,
                    )
                models = _model_rows(model_helper, backend_checkout, cached_models)
                if not models:
                    raise ValueError('No local GGUF models were discovered')
                merged = {**previous, **request}
                if 'mode' not in request:
                    merged['mode'] = previous.get('mode', 'zvram' if previous.get('router') else 'regular')
                merged.update(action='router_start', model=models[0]['path'], alias='local-router')
                params = _parameters(
                    merged, model_helper, backend_checkout,
                    ignore_swap_guard_default=_supports_ignore_swap_guard(root),
                    cached_models=cached_models,
                )
                _validate_ram_guard(manager_helper, params)
                params.update(router=True, model_ids=[model['name'] for model in models],
                              auto_start=(request.get('auto_start', True) if action == 'router_start'
                                          else request.get('auto_start', previous.get('auto_start', True))))
                if type(params['auto_start']) is not bool:
                    raise ValueError('auto_start must be a boolean')
                if params['port'] == backend_port or not _port_is_free(params['port']):
                    if not (action == 'router_configure' and running and params['port'] == previous.get('port')):
                        raise ValueError('Router port is already in use or belongs to Novum')
                if params['mode'] == 'zvram' and params['ignore_swap_guard'] and not _supports_ignore_swap_guard(root):
                    raise ValueError('Ignoring the swap-growth guard requires zVram 0.4.2 or newer')
                if _ROUTER_NAME in params_state and previous.get('router') is not True:
                    raise ValueError('The router profile name is already used by a legacy profile')
                profile = _build_router_profile(model_helper, manager, params, models, backend_checkout)
                if action == 'router_configure' and running:
                    if not manager.stop(_ROUTER_NAME):
                        raise ValueError('The owned model router stopped before settings could be applied')
                    _wait_for_owned_worker_exit(manager_helper, manager, _ROUTER_NAME)
                _save_manager_profile(manager_helper, manager, profile, params_state)
                params_state[_ROUTER_NAME] = params
                _write_state(manager, params_state)
                if action == 'router_start' or running:
                    _start_manager(manager, _ROUTER_NAME)
            else:
                params = params_state.get(_ROUTER_NAME, {})
                if params.get('router') is not True:
                    raise ValueError('Start the model router first')
                if action == 'router_stop':
                    stopped = bool(manager.stop(_ROUTER_NAME))
                    params['auto_start'] = False
                    _write_state(manager, params_state)
                else:
                    if not _owned_profile_running(manager_helper, manager, _ROUTER_NAME, params):
                        raise ValueError('Start the owned model router before connecting it')
                    _register_router(model_helper, params, backend_checkout, cookie_path, backend_port)
            status = _status(model_helper, manager_helper, manager, backend_checkout, params_state, str(root))
            if action in ('router_start', 'router_configure'):
                status['started' if action == 'router_start' else 'configured'] = True
            elif action == 'router_stop':
                status['stopped'] = stopped
            elif action == 'router_register':
                status['registered'] = True
            return status

        name = request.get("profile")
        if action == "save":
            params = _parameters(request, model_helper, backend_checkout,
                                 ignore_swap_guard_default=_supports_ignore_swap_guard(root))
            _validate_ram_guard(manager_helper, params)
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
            saved_request = {**params, "profile": name}
            saved_request.setdefault("live_control", params.get("compressed", False) is True)
            current = _parameters(saved_request, model_helper, backend_checkout,
                                  ignore_swap_guard_default=_supports_ignore_swap_guard(root))
            _validate_ram_guard(manager_helper, current)
            if current["ignore_swap_guard"] and not _supports_ignore_swap_guard(root):
                raise ValueError("Ignoring the swap-growth guard requires zVram 0.4.2 or newer")
            if _owned_profile_running(manager_helper, manager, name, current):
                raise ValueError("Profile is already running")
            if not _port_is_free(current["port"]):
                raise ValueError("Profile port is already in use")
            _save_manager_profile(manager_helper, manager,
                                  _build_manager_profile(model_helper, name, current), params_state)
            params_state[name] = current
            _write_state(manager, params_state)
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
    if argv and argv[0] == 'watch':
        if len(argv) not in (6, 7, 8):
            print(json.dumps({'error': 'Expected watch ROOT BACKEND_CHECKOUT COOKIE_PATH BACKEND_PORT CACHE_ROOT [INTERVAL [INSTALLATION_CONFIG_PATH]]'}))
            return 1
        _, root, backend_checkout, cookie_path, backend_port, cache_root, *watch_options = argv
        try:
            interval = int(watch_options[0]) if watch_options else 30
            if not 10 <= interval <= 300:
                raise ValueError('Watch interval must be between 10 and 300 seconds')
            install_config = Path(watch_options[1]) if len(watch_options) > 1 else None
            if install_config is not None and not install_config.is_absolute():
                raise ValueError('The zVram installation config path must be absolute')
            helpers = None if install_config is not None else _load_runtime(root)
            active_root = None
            while True:
                if install_config is not None:
                    try:
                        configured_root = _read_installation_config(install_config)
                        if configured_root != active_root:
                            configured_helpers = _load_runtime(configured_root)
                            # Commit the root and both modules together only after
                            # the new install has loaded and passed its root checks.
                            active_root, helpers = configured_root, configured_helpers
                        watch_root = active_root
                    except (OSError, ValueError, KeyError, TypeError, ImportError, AttributeError, RuntimeError) as exc:
                        print(json.dumps({'sync': 'pending', 'error': _clean_text(exc, 180)}, separators=(',', ':')), flush=True)
                        time.sleep(interval)
                        continue
                else:
                    watch_root = root
                try:
                    result = dispatch(
                        watch_root, backend_checkout, cookie_path, backend_port,
                        {'action': 'router_sync'}, cache_root=cache_root, helpers=helpers,
                    )
                    summary = result.get('router_sync', {})
                    print(json.dumps({'sync': 'ok', **summary}, separators=(',', ':')), flush=True)
                except (OSError, ValueError, KeyError, TypeError, ImportError, AttributeError, RuntimeError) as exc:
                    print(json.dumps({'sync': 'pending', 'error': _clean_text(exc, 180)}, separators=(',', ':')), flush=True)
                time.sleep(interval)
        except KeyboardInterrupt:
            return 0
        except (OSError, ValueError, TypeError, ImportError, AttributeError, RuntimeError) as exc:
            print(json.dumps({'error': _clean_text(exc, 180)}, separators=(',', ':')))
            return 1
    if len(argv) not in (5, 6):
        print(json.dumps({"error": "Expected ROOT BACKEND_CHECKOUT COOKIE_PATH BACKEND_PORT REQUEST_JSON [CACHE_ROOT]"}))
        return 1
    root, backend_checkout, cookie_path, backend_port, request_json = argv[:5]
    cache_root = argv[5] if len(argv) == 6 else None
    if len(request_json) > 32768:
        print(json.dumps({"error": "Request is too large"}))
        return 1
    try:
        request = json.loads(request_json)
        result = dispatch(root, backend_checkout, cookie_path, backend_port, request,
                          cache_root=cache_root)
        print(json.dumps(result, separators=(",", ":")))
        return 0
    except (OSError, ValueError, KeyError, TypeError, ImportError, AttributeError, RuntimeError) as exc:
        message = _clean_text(exc, 400) or "zVram request failed"
        print(json.dumps({"error": message}, separators=(",", ":")))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
