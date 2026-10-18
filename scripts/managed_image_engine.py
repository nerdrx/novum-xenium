#!/usr/bin/env python3
"""Authenticated lazy gateway for the bundled stable-diffusion.cpp server."""

from __future__ import annotations

import argparse
import http.client
import json
import os
import re
import signal
import socket
import subprocess
import sys
import threading
import time
from dataclasses import dataclass
from email.message import Message
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

MAX_CATALOG_BYTES = 1_048_576
MAX_REQUEST_BYTES = 20 * 1024 * 1024
MAX_RESPONSE_BYTES = 128 * 1024 * 1024
MAX_MODELS = 256
MAX_PROMPT_CHARS = 32_000
MAX_TIMEOUT = 600
_RESERVED_FLAGS = ("--host", "--port", "--listen-ip", "--listen-port")
_GEN_FIELDS = {"model", "prompt", "n", "size", "quality", "output_format", "output_compression"}


class GatewayError(ValueError):
    pass


@dataclass(frozen=True)
class Model:
    id: str
    name: str
    command: tuple[str, ...]


@dataclass(frozen=True)
class Catalog:
    models: tuple[Model, ...]
    default_model: str | None
    idle_seconds: int
    startup_timeout: int
    request_timeout: int


def _private_file(path: Path, *, create_token: bool = False) -> bytes:
    if path.is_symlink():
        raise GatewayError(f"private file must not be a symlink: {path}")
    if create_token and not path.exists():
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
        try:
            os.write(fd, os.urandom(32).hex().encode("ascii"))
        finally:
            os.close(fd)
    try:
        st = path.stat(follow_symlinks=False)
    except OSError as exc:
        raise GatewayError(f"cannot read private file: {path}") from exc
    if not path.is_file() or (hasattr(os, "getuid") and st.st_uid != os.getuid()):
        raise GatewayError(f"private file has wrong owner or type: {path}")
    if st.st_mode & 0o077:
        raise GatewayError(f"private file permissions must be 0600: {path}")
    if st.st_size > MAX_CATALOG_BYTES:
        raise GatewayError(f"private file is too large: {path}")
    data = path.read_bytes()
    if not data:
        raise GatewayError(f"private file is empty: {path}")
    return data


def load_token(path: Path) -> bytes:
    token = _private_file(path, create_token=True).strip()
    if len(token) < 32:
        raise GatewayError("bearer token must contain at least 32 bytes")
    return token


def _validate_command(value: object) -> tuple[str, ...]:
    if not isinstance(value, list) or not value or len(value) > 128:
        raise GatewayError("model command must be a non-empty argv array")
    if not all(isinstance(part, str) and part and "\0" not in part and len(part) <= 4096 for part in value):
        raise GatewayError("model command contains an invalid argument")
    executable = Path(value[0])
    if not executable.is_absolute() or executable.name.lower() not in {
        "sd-server", "sd-server-vulkan", "sd-server-zvram",
        "sd-server.exe", "sd-server-vulkan.exe", "sd-server-zvram.exe",
    }:
        raise GatewayError("model command must use an absolute bundled sd-server binary")
    if not executable.is_file() or not os.access(executable, os.X_OK):
        raise GatewayError("configured sd-server binary is unavailable")
    for arg in value[1:]:
        if any(arg == flag or arg.startswith(flag + "=") for flag in _RESERVED_FLAGS):
            raise GatewayError("catalog command may not choose a listen address or port")
    return tuple(value)


def load_catalog(path: Path) -> Catalog:
    raw = _private_file(path)
    try:
        data = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise GatewayError("catalog must be valid UTF-8 JSON") from exc
    if (not isinstance(data, dict) or isinstance(data.get("version"), bool)
            or data.get("version") != 1):
        raise GatewayError("catalog version must be 1")
    rows = data.get("models")
    if not isinstance(rows, list) or len(rows) > MAX_MODELS:
        raise GatewayError(f"catalog must contain at most {MAX_MODELS} models")
    models: list[Model] = []
    seen: set[str] = set()
    for row in rows:
        if not isinstance(row, dict):
            raise GatewayError("catalog model entry must be an object")
        model_id, name = row.get("id"), row.get("name")
        if (not isinstance(model_id, str) or not re.fullmatch(r"[A-Za-z0-9._:-]{1,128}", model_id)
                or model_id in seen or not isinstance(name, str) or not name.strip() or len(name) > 256):
            raise GatewayError("catalog model id or name is invalid")
        seen.add(model_id)
        models.append(Model(model_id, name.strip(), _validate_command(row.get("command"))))
    default = data.get("default_model")
    if default is not None and (not isinstance(default, str) or default not in seen):
        raise GatewayError("catalog default_model must name a configured model")
    idle = _bounded_int(data.get("idle_seconds", 300), 30, 3600, "idle_seconds")
    startup = _bounded_int(data.get("startup_timeout", 180), 1, MAX_TIMEOUT, "startup_timeout")
    request = _bounded_int(data.get("request_timeout", MAX_TIMEOUT), 1, MAX_TIMEOUT, "request_timeout")
    return Catalog(tuple(models), default, idle, startup, request)


def _bounded_int(value: object, low: int, high: int, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
        raise GatewayError(f"{field} must be an integer from {low} to {high}")
    return value


def _loopback_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _owned_listener(port: int, process_group: int) -> bool:
    """Require the child process group itself to own the loopback listener."""
    if os.name == "nt":
        try:
            import ctypes
            from ctypes import wintypes

            class TcpRowOwnerPid(ctypes.Structure):
                _fields_ = [(name, wintypes.DWORD) for name in
                            ("state", "local_addr", "local_port", "remote_addr", "remote_port", "pid")]

            iphlpapi = ctypes.WinDLL("iphlpapi.dll")
            get_table = iphlpapi.GetExtendedTcpTable
            size = wintypes.ULONG(0)
            get_table(None, ctypes.byref(size), False, 2, 3, 0)  # IPv4 listener rows with owning PID.
            buffer = ctypes.create_string_buffer(size.value)
            if get_table(buffer, ctypes.byref(size), False, 2, 3, 0) != 0:
                return False
            count = ctypes.cast(buffer, ctypes.POINTER(wintypes.DWORD)).contents.value
            rows = ctypes.cast(ctypes.addressof(buffer) + ctypes.sizeof(wintypes.DWORD),
                               ctypes.POINTER(TcpRowOwnerPid))
            for index in range(count):
                row = rows[index]
                if (row.state == 2 and row.local_addr == 0x0100007F
                        and socket.ntohs(row.local_port & 0xFFFF) == port
                        and row.pid == process_group):
                    return True
            return False
        except (AttributeError, OSError, ValueError, TypeError):
            return False
    if not Path("/proc").is_dir() or not Path("/proc/net/tcp").is_file():
        return False
    try:
        listeners = set()
        with open("/proc/net/tcp", encoding="ascii") as stream:
            next(stream, None)
            for line in stream:
                fields = line.split()
                if len(fields) > 9 and fields[1] == f"0100007F:{port:04X}" and fields[3] == "0A":
                    listeners.add(fields[9])
        if not listeners:
            return False
        for entry in Path("/proc").iterdir():
            if not entry.name.isdigit():
                continue
            try:
                # pgrp is field 5 in /proc/<pid>/stat; comm is parenthesized.
                stat = (entry / "stat").read_text(encoding="ascii")
                tail = stat[stat.rfind(")") + 2:].split()
                if int(tail[2]) != process_group:
                    continue
                for fd in (entry / "fd").iterdir():
                    try:
                        target = os.readlink(fd)
                    except OSError:
                        continue
                    if target.startswith("socket:[") and target[8:-1] in listeners:
                        return True
            except (OSError, ValueError, IndexError):
                continue
    except OSError:
        return False
    return False


class EngineManager:
    def __init__(self, catalog_path: Path):
        self.catalog_path = catalog_path
        self.lock = threading.Lock()
        self.process: subprocess.Popen[bytes] | None = None
        self.model: Model | None = None
        self.port: int | None = None
        self.last_used = 0.0
        self.stopping = threading.Event()
        self.monitor = threading.Thread(target=self._idle_monitor, daemon=True)
        self.monitor.start()

    def _idle_monitor(self) -> None:
        while not self.stopping.wait(2):
            if not self.lock.acquire(blocking=False):
                continue
            try:
                catalog = load_catalog(self.catalog_path)
                if self.process and self.model:
                    current = next((m for m in catalog.models if m.id == self.model.id), None)
                    removed_or_changed = current is None or current.command != self.model.command
                    expired = time.monotonic() - self.last_used >= catalog.idle_seconds
                    if removed_or_changed or expired:
                        self._stop_locked()
            except GatewayError:
                self._stop_locked()
            finally:
                self.lock.release()

    def status(self) -> dict:
        proc = self.process
        return {
            "status": "ready",
            "loaded_model": self.model.id if proc and proc.poll() is None and self.model else None,
            "models_count": len(load_catalog(self.catalog_path).models),
            "engine": "novum-image-engine",
            "generation_active": bool(self.lock.locked()),
        }

    def run(self, model: Model, catalog: Catalog, path: str, body: bytes, content_type: str) -> tuple[int, str, bytes]:
        if not self.lock.acquire(timeout=0.2):
            raise GatewayError("An image request is already running")
        try:
            self._ensure_locked(model, catalog)
            assert self.port is not None and self.process is not None
            connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=catalog.request_timeout)
            try:
                headers = {"Content-Type": content_type, "Content-Length": str(len(body)), "Connection": "close"}
                connection.request("POST", path, body=body, headers=headers)
                response = connection.getresponse()
                payload = response.read(MAX_RESPONSE_BYTES + 1)
                if len(payload) > MAX_RESPONSE_BYTES:
                    raise GatewayError("image engine response is too large")
                self.last_used = time.monotonic()
                if response.status >= 500:
                    self._stop_locked()
                return response.status, response.getheader("Content-Type", "application/json"), payload
            except (OSError, http.client.HTTPException) as exc:
                self._stop_locked()
                raise GatewayError("image engine request failed; its owned process was stopped") from exc
            finally:
                connection.close()
        finally:
            self.last_used = time.monotonic()
            self.lock.release()

    def _ensure_locked(self, model: Model, catalog: Catalog) -> None:
        if self.process and (self.process.poll() is not None or self.model != model):
            self._stop_locked()
        if self.process is None:
            port = _loopback_port()
            command = [*model.command, "--listen-ip", "127.0.0.1", "--listen-port", str(port)]
            options: dict = {"stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL}
            if os.name == "nt":
                options["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
            else:
                options["start_new_session"] = True
            try:
                proc = subprocess.Popen(command, **options)
            except OSError as exc:
                raise GatewayError("configured image engine could not be started") from exc
            self.process, self.model, self.port = proc, model, port
            self.last_used = time.monotonic()
            deadline = self.last_used + catalog.startup_timeout
            while time.monotonic() < deadline:
                if proc.poll() is not None:
                    self._stop_locked()
                    raise GatewayError("image engine exited while starting")
                try:
                    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=1)
                    conn.request("GET", "/v1/models")
                    response = conn.getresponse()
                    data = json.loads(response.read(64 * 1024))
                    conn.close()
                    ids = {entry.get("id") for entry in data.get("data", []) if isinstance(entry, dict)}
                    if response.status == 200 and "sd-cpp-local" in ids and proc.poll() is None:
                        if not _owned_listener(port, proc.pid if os.name == "nt" else os.getpgid(proc.pid)):
                            self._stop_locked()
                            raise GatewayError("readiness endpoint is not owned by the launched image engine")
                        return
                except (OSError, http.client.HTTPException, ValueError, TypeError, AttributeError):
                    pass
                time.sleep(0.1)
            self._stop_locked()
            raise GatewayError("image engine did not become ready before startup timeout")

    def _stop_locked(self) -> None:
        proc = self.process
        self.process = self.model = self.port = None
        self._terminate_owned(proc)

    @staticmethod
    def _terminate_owned(proc: subprocess.Popen[bytes] | None) -> None:
        if not proc or proc.poll() is not None:
            return
        try:
            if os.name == "nt":
                proc.terminate()
            else:
                os.killpg(proc.pid, signal.SIGTERM)
            proc.wait(timeout=5)
        except (OSError, subprocess.TimeoutExpired):
            try:
                if os.name == "nt":
                    proc.kill()
                else:
                    os.killpg(proc.pid, signal.SIGKILL)
                proc.wait(timeout=2)
            except (OSError, subprocess.TimeoutExpired):
                pass

    def close(self) -> None:
        self.stopping.set()
        # Shutdown may arrive while a request owns the serialization lock.
        # Terminate only the process group we created so the request unblocks.
        self._terminate_owned(self.process)
        self.monitor.join(timeout=2)
        if self.lock.acquire(timeout=5):
            try:
                self._stop_locked()
            finally:
                self.lock.release()


def _select_model(catalog: Catalog, body_model: object) -> Model:
    model_id = body_model if isinstance(body_model, str) else ""
    by_id = {model.id: model for model in catalog.models}
    if model_id in by_id:
        return by_id[model_id]
    if model_id == "sd-cpp-local":
        if catalog.default_model:
            return by_id[catalog.default_model]
        if len(catalog.models) == 1:
            return catalog.models[0]
    raise GatewayError("unknown image model")


def _validate_generation(body: bytes, catalog: Catalog) -> tuple[Model, bytes]:
    try:
        data = json.loads(body)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise GatewayError("request must be valid JSON") from exc
    if not isinstance(data, dict) or data.keys() - _GEN_FIELDS:
        raise GatewayError("request contains unsupported fields")
    model = _select_model(catalog, data.get("model"))
    prompt = data.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > MAX_PROMPT_CHARS:
        raise GatewayError("prompt must contain 1 to 32000 characters")
    n = data.get("n", 1)
    if isinstance(n, bool) or not isinstance(n, int) or not 1 <= n <= 4:
        raise GatewayError("n must be an integer from 1 to 4")
    size = data.get("size", "512x512")
    if not isinstance(size, str) or not re.fullmatch(r"(?:\d{2,4}x\d{2,4}|auto)", size):
        raise GatewayError("size must be WxH or auto")
    if size != "auto":
        width, height = (int(part) for part in size.split("x"))
        if width > 4096 or height > 4096:
            raise GatewayError("requested dimensions exceed 4096 pixels")
    quality = data.get("quality", "medium")
    if not isinstance(quality, str) or quality not in {"low", "medium", "high", "auto"}:
        raise GatewayError("quality must be low, medium, high, or auto")
    out = data.get("output_format", "png")
    if not isinstance(out, str) or out not in {"png", "jpeg", "webp"}:
        raise GatewayError("unsupported output_format")
    compression = data.get("output_compression", 100)
    if isinstance(compression, bool) or not isinstance(compression, int) or not 0 <= compression <= 100:
        raise GatewayError("output_compression must be from 0 to 100")
    data.update(model="sd-cpp-local", size=size, output_format=out, output_compression=compression)
    return model, json.dumps(data, separators=(",", ":")).encode()


def _rewrite_edit_model(body: bytes, content_type: str) -> tuple[bytes, str]:
    header = Message()
    header["Content-Type"] = content_type
    boundary = header.get_param("boundary", header="content-type")
    if not isinstance(boundary, str) or not re.fullmatch(r"[A-Za-z0-9'()+_,./:=?-]{1,70}", boundary):
        raise GatewayError("multipart boundary is invalid")
    marker = b"--" + boundary.encode("ascii", "strict")
    chunks = body.split(marker)
    found = 0
    requested_model = ""
    counts: dict[str, int] = {}
    image_arrays = 0
    rewritten = []
    for chunk in chunks:
        if not chunk.startswith(b"\r\n"):
            rewritten.append(chunk)
            continue
        head, sep, value = chunk[2:].partition(b"\r\n\r\n")
        if not sep:
            raise GatewayError("malformed multipart request")
        dispositions = [line for line in head.split(b"\r\n")
                        if line.lower().startswith(b"content-disposition:")]
        disposition = dispositions[0] if len(dispositions) == 1 else b""
        is_form_data = bool(re.match(rb'(?i)^content-disposition:\s*form-data\s*;', disposition))
        name_match = re.search(rb'(?i)(?:^|;)\s*name="([^"]+)"', disposition) if is_form_data else None
        if not name_match:
            raise GatewayError("multipart fields require a form-data name")
        try:
            name = name_match.group(1).decode("ascii")
            header_text = head.decode("latin1")
        except UnicodeDecodeError as exc:
            raise GatewayError("multipart field name is invalid") from exc
        allowed = {"model", "prompt", "n", "size", "quality", "output_format", "output_compression",
                   "image[]", "image", "mask"}
        if name not in allowed:
            raise GatewayError(f"unsupported edit field: {name[:64]}")
        counts[name] = counts.get(name, 0) + 1
        is_file = bool(re.search(r"(?i);\s*filename=", header_text))
        if name in {"image[]", "image", "mask"}:
            if not is_file or not value.rstrip(b"\r\n"):
                raise GatewayError(f"{name} must be a non-empty image file")
        elif is_file:
            raise GatewayError(f"{name} must be a text field")
        raw_value = value[:-2] if value.endswith(b"\r\n") else value
        if name == "prompt" and (not raw_value.strip() or len(raw_value) > MAX_PROMPT_CHARS):
            raise GatewayError("prompt must contain 1 to 32000 characters")
        if name == "n":
            try:
                count = int(raw_value.decode("ascii"))
            except (UnicodeDecodeError, ValueError) as exc:
                raise GatewayError("n must be an integer from 1 to 4") from exc
            if not 1 <= count <= 4:
                raise GatewayError("n must be an integer from 1 to 4")
        if name == "size":
            try:
                size = raw_value.decode("ascii")
            except UnicodeDecodeError as exc:
                raise GatewayError("size must be WxH") from exc
            if not re.fullmatch(r"\d{2,4}x\d{2,4}", size):
                raise GatewayError("size must be WxH")
            width, height = (int(part) for part in size.split("x"))
            if width > 4096 or height > 4096:
                raise GatewayError("requested dimensions exceed 4096 pixels")
        if name == "quality" and raw_value not in {b"low", b"medium", b"high", b"auto"}:
            raise GatewayError("quality must be low, medium, high, or auto")
        if name == "output_format" and raw_value not in {b"png", b"jpeg", b"webp"}:
            raise GatewayError("unsupported output_format")
        if name == "output_compression":
            try:
                compression = int(raw_value.decode("ascii"))
            except (UnicodeDecodeError, ValueError) as exc:
                raise GatewayError("output_compression must be from 0 to 100") from exc
            if not 0 <= compression <= 100:
                raise GatewayError("output_compression must be from 0 to 100")
        if name == "image[]":
            image_arrays += 1
            if image_arrays > 4:
                raise GatewayError("at most 4 source images are supported")
        elif counts[name] > 1:
            raise GatewayError(f"duplicate edit field: {name}")
        if name == "model":
            if raw_value.count(b"\r\n") or found or len(raw_value) > 256:
                raise GatewayError("multipart model field is malformed")
            found += 1
            try:
                requested_model = raw_value.decode("ascii")
            except UnicodeDecodeError as exc:
                raise GatewayError("multipart model field is invalid") from exc
            value = b"sd-cpp-local" + (b"\r\n" if value.endswith(b"\r\n") else b"")
        rewritten.append(b"\r\n" + head + sep + value)
    if found == 0:
        raise GatewayError("edit request must include a model field")
    if not counts.get("prompt"):
        raise GatewayError("edit request must include a prompt")
    if not image_arrays and not counts.get("image"):
        raise GatewayError("edit request must include image[] or image")
    if image_arrays and counts.get("image"):
        raise GatewayError("use either image[] or image, not both")
    return marker.join(rewritten), requested_model


def create_server(catalog_path: Path, token: bytes, port: int, parent_pid: int | None = None) -> tuple[ThreadingHTTPServer, EngineManager]:
    manager: EngineManager | None = None

    class Handler(BaseHTTPRequestHandler):
        server_version = "NovumImageEngine/1"
        protocol_version = "HTTP/1.1"

        def log_message(self, *_args) -> None:
            return

        def _reply(self, status: int, body: bytes, content_type: str = "application/json") -> None:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            origin = getattr(self, "_origin", None)
            if origin:
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Vary", "Origin")
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(body)

        def _error(self, status: int, message: str) -> None:
            self._reply(status, json.dumps({"error": {"message": message}}).encode())

        def _authorized(self, *, require_bearer: bool = True) -> bool:
            host = self.headers.get("Host", "")
            allowed_hosts = {f"127.0.0.1:{self.server.server_port}", f"localhost:{self.server.server_port}"}
            if host not in allowed_hosts:
                self._error(400, "Host must identify the loopback gateway")
                return False
            origin = self.headers.get("Origin")
            if origin:
                parts = urlsplit(origin)
                if (parts.scheme not in {"http", "https"} or parts.hostname not in {"127.0.0.1", "localhost", "::1"}
                        or parts.username or parts.password or parts.path not in {"", "/"} or parts.query or parts.fragment):
                    self._error(403, "Origin must be loopback")
                    return False
                self._origin = origin
            if require_bearer:
                auth = self.headers.get("Authorization", "")
                supplied = auth[7:].encode() if auth.startswith("Bearer ") else b""
                import hmac
                if not hmac.compare_digest(supplied, token):
                    self._error(401, "Bearer token required")
                    return False
            return True

        def do_OPTIONS(self):
            # Browser preflight cannot carry Authorization. This grants no API
            # access; every actual endpoint still requires the bearer token.
            if not self._authorized(require_bearer=False):
                return
            origin = getattr(self, "_origin", None)
            self.send_response(204)
            if origin:
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
            self.send_header("Content-Length", "0")
            self.end_headers()

        def do_GET(self):
            if not self._authorized():
                return
            try:
                if self.path == "/health":
                    assert manager is not None
                    result = manager.status()
                elif self.path == "/v1/models":
                    catalog = load_catalog(catalog_path)
                    result = {"object": "list", "data": [
                        {"id": m.id, "object": "model", "owned_by": "local", "name": m.name}
                        for m in catalog.models
                    ]}
                else:
                    self._error(404, "Not found")
                    return
                body = json.dumps(result, separators=(",", ":")).encode()
                self._reply(200, body)
            except GatewayError as exc:
                self._error(503, str(exc))

        def do_POST(self):
            if not self._authorized():
                return
            if self.path not in {"/v1/images/generations", "/v1/images/edits"}:
                self._error(404, "Not found")
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if length <= 0 or length > MAX_REQUEST_BYTES:
                    self._error(413, "Request body is empty or too large")
                    return
                body = self.rfile.read(length)
                if len(body) != length:
                    raise GatewayError("incomplete request body")
                catalog = load_catalog(catalog_path)
                if self.path.endswith("generations"):
                    if self.headers.get_content_type() != "application/json":
                        raise GatewayError("generation requests must use application/json")
                    model, forwarded = _validate_generation(body, catalog)
                    content_type = "application/json"
                else:
                    content_type = self.headers.get("Content-Type", "")
                    if not content_type.lower().startswith("multipart/form-data"):
                        raise GatewayError("edit requests must use multipart/form-data")
                    forwarded, requested_model = _rewrite_edit_model(body, content_type)
                    model = _select_model(catalog, requested_model)
                    parsed_type = Message()
                    parsed_type["Content-Type"] = content_type
                    content_type = f"multipart/form-data; boundary={parsed_type.get_param('boundary', header='content-type')}"
                assert manager is not None
                try:
                    status, response_type, response_body = manager.run(
                        model, catalog, self.path, forwarded, content_type,
                    )
                except GatewayError as exc:
                    self._error(503 if "unknown" not in str(exc) else 400, str(exc))
                    return
                self._reply(status, response_body, response_type)
            except (GatewayError, ValueError, UnicodeError) as exc:
                self._error(400, str(exc))

    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    server.daemon_threads = True
    manager = EngineManager(catalog_path)
    server.manager = manager
    if parent_pid is not None:
        def watch_parent() -> None:
            while not manager.stopping.wait(1):
                if os.getppid() != parent_pid:
                    threading.Thread(target=server.shutdown, daemon=True).start()
                    return
        threading.Thread(target=watch_parent, daemon=True).start()
    return server, manager


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--catalog", required=True, type=Path)
    parser.add_argument("--port", required=True, type=int)
    parser.add_argument("--token-file", required=True, type=Path)
    parser.add_argument("--parent-pid", type=int)
    args = parser.parse_args(argv)
    if not 1 <= args.port <= 65535:
        parser.error("--port must be between 1 and 65535")
    try:
        load_catalog(args.catalog)
        token = load_token(args.token_file)
        server, manager = create_server(args.catalog, token, args.port, args.parent_pid)
    except GatewayError as exc:
        print(f"managed image engine: {exc}", file=sys.stderr)
        return 2
    try:
        def request_shutdown(_signum, _frame) -> None:
            threading.Thread(target=server.shutdown, daemon=True).start()

        signal.signal(signal.SIGTERM, request_shutdown)
        signal.signal(signal.SIGINT, request_shutdown)
        server.serve_forever(poll_interval=0.25)
    except KeyboardInterrupt:
        pass
    finally:
        server.shutdown()
        server.server_close()
        manager.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
