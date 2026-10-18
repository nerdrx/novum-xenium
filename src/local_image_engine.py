"""Owned, lazy image engine and Cookbook cache registration.

The gateway stays ready without loading weights. Only a generation request
starts an sd.cpp worker; neither startup nor catalogue scans run inference.
"""
from __future__ import annotations

import hashlib
import hmac
import http.client
from functools import lru_cache
import json
import logging
import os
from pathlib import Path, PurePosixPath
import re
import secrets
import shutil
import struct
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
from urllib.parse import urlsplit

from src.constants import DATA_DIR

logger = logging.getLogger(__name__)
ENGINE_ID = "nx-managed-image-engine"
ENGINE_NAME = "Local images"
DEFAULT_PORT = 18124
MODES = frozenset({"auto", "cpu", "vulkan", "zvram"})


def _private_json(path, value):
    """Atomic 0600 publication; gateway readers never see a permissive temp file."""
    fd, temporary = tempfile.mkstemp(prefix=path.name + ".", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump(value, stream)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def _gguf_architecture(path):
    """Read bounded metadata only, never model tensors."""
    with path.open("rb") as stream:
        data = stream.read(1024 * 1024)
    offset = 0
    def take(n):
        nonlocal offset
        if n < 0 or offset + n > len(data):
            raise ValueError("GGUF metadata inspection budget exceeded")
        result = data[offset:offset + n]
        offset += n
        return result
    def number(fmt):
        return struct.unpack("<" + fmt, take(struct.calcsize("<" + fmt)))[0]
    def string():
        return take(number("Q")).decode("utf-8")
    def value(kind, depth=0):
        if depth > 1:
            raise ValueError("Nested GGUF metadata")
        if kind == 8:
            return string()
        if kind == 9:
            element, count = number("I"), number("Q")
            if count > 100000:
                raise ValueError("Oversized GGUF array")
            for _ in range(count):
                value(element, depth + 1)
        else:
            take({0:1, 1:1, 2:2, 3:2, 4:4, 5:4, 6:4, 7:1, 10:8, 11:8, 12:8}[kind])
    if take(4) != b"GGUF" or number("I") not in (2, 3):
        return ""
    number("Q")
    count = number("Q")
    if count > 100000:
        return ""
    for _ in range(count):
        key, kind = string(), number("I")
        result = value(kind)
        if key == "general.architecture":
            return result if kind == 8 else ""
    return ""


def _safetensor_keys(path):
    with path.open("rb") as stream:
        length = struct.unpack("<Q", stream.read(8))[0]
        if not 2 <= length <= 4 * 1024 * 1024:
            return ()
        header = json.loads(stream.read(length))
    return tuple(k for k in header if k != "__metadata__") if isinstance(header, dict) else ()


@lru_cache(maxsize=1024)
def _weight_kind(path_text, modified_ns, size):
    # Cache only the classification, never headers, tensors or model weights.
    path = Path(path_text)
    if path.suffix.lower() == ".gguf":
        return _gguf_architecture(path)
    keys = _safetensor_keys(path)
    return ("checkpoint" if (any(k.startswith(("model.diffusion_model.", "diffusion_model.")) for k in keys)
                            and any(k.startswith("first_stage_model.") for k in keys))
            else "component" if keys else "invalid")


def cached_files(rows):
    """Resolve complete artifacts inside their scanned cache, including HF blobs."""
    result = []
    for row in rows[:4096]:
        if not isinstance(row, dict) or row.get("has_incomplete") is not False:
            continue
        repo = row.get("repo_id", "")
        if not isinstance(repo, str) or not re.fullmatch(r"[\w.-]+(?:/[\w.-]+)?", repo):
            continue
        try:
            cache = Path(row["path"]).expanduser().resolve(strict=True)
            if row.get("is_local_dir"):
                base = cache / repo
            else:
                base = cache / ("models--" + repo.replace("/", "--")) / "snapshots"
            for file in (row.get("gguf_files", []) + row.get("safetensors_files", []))[:4096]:
                if not isinstance(file, dict):
                    continue
                rel = PurePosixPath(file.get("rel_path", ""))
                if rel.is_absolute() or any(p in ("", ".", "..") for p in rel.parts):
                    continue
                path = (base / str(rel)).resolve(strict=True)
                path.relative_to(cache)
                if not path.is_file() or path.stat().st_size < 8 or file.get("split"):
                    continue
                result.append((row, file, path))
        except (KeyError, OSError, TypeError, ValueError):
            continue
    return result


def image_catalog(rows, binary, mode):
    """Use complete SD checkpoints or the supported FLUX.2 Klein component recipe."""
    files = cached_files(rows)
    def component_ok(path):
        try:
            info = path.stat()
            return _weight_kind(str(path), info.st_mtime_ns, info.st_size) == "component"
        except (OSError, ValueError, KeyError, TypeError, struct.error, UnicodeError):
            return False
    component_repos = {"comfy-org/flux2-klein-4b", "comfy-org/vae-text-encorder-for-flux-klein-4b"}
    encoder = next((p for r, f, p in files if r["repo_id"].lower() in component_repos
                    and f.get("name", "").lower() == "qwen_3_4b.safetensors" and component_ok(p)), None)
    vae = next((p for r, f, p in files if r["repo_id"].lower() in component_repos | {"black-forest-labs/flux.2-dev"}
                and re.fullmatch(r"(?:flux2[-_]?vae|(?:flux2[_-]?)?ae)\.safetensors", f.get("name", ""), re.I)
                and component_ok(p)), None)
    models, pending, seen = [], [], set()
    for row, file, path in files:
        if row.get("is_adapter") or row.get("is_video") or file.get("role") == "projector":
            continue
        filename = file.get("name", path.name)
        flux = bool(re.search(r"flux[._-]?2.*klein.*4b", row["repo_id"] + " " + filename, re.I))
        try:
            stat = path.stat()
            kind = _weight_kind(str(path), stat.st_mtime_ns, stat.st_size)
            if path.suffix.lower() == ".gguf":
                checkpoint = kind in {"sd1", "sd2", "sdxl", "stable-diffusion"}
                flux = flux and kind in {"flux", "flux2"}
            else:
                checkpoint = kind == "checkpoint"
                flux = (flux and kind != "invalid"
                        and bool(re.fullmatch(r"flux[-_.]?2[-_]?klein.*4b.*\.safetensors", filename, re.I)))
            if not checkpoint and not flux:
                continue
            if flux and (encoder is None or vae is None):
                pending.append({"name": row["repo_id"], "reason": "Waiting for cached Qwen3 4B encoder and FLUX.2 VAE components."})
                continue
            alias = "sd-cpp-local:" + row["repo_id"].replace("/", "--") + ":" + Path(filename).stem
            alias = re.sub(r"[^A-Za-z0-9._:-]", "-", alias)
            if len(alias) > 128:
                alias = alias[:107] + "-" + hashlib.sha256(alias.encode()).hexdigest()[:20]
            if alias in seen:
                continue
            seen.add(alias)
            command = [binary, "--diffusion-model" if flux else "-m", str(path), "--backend",
                       ("diffusion=vulkan0,te=cpu,vae=cpu" if flux and mode == "zvram"
                        else "diffusion=vulkan0" if mode in {"vulkan", "zvram"} else "cpu")]
            if flux:
                command += ["--llm", str(encoder), "--vae", str(vae), "--steps",
                            "20" if "base" in row["repo_id"].lower() else "4", "--cfg-scale",
                            "4" if "base" in row["repo_id"].lower() else "1"]
                if mode == "zvram":
                    command += ["--params-backend", "diffusion=cpu", "--max-vram", "3"]
            models.append({"id": alias, "name": (row["repo_id"] + " · " + filename)[:256],
                           "size_bytes": path.stat().st_size, "command": command})
        except (OSError, ValueError, KeyError, TypeError, struct.error, UnicodeError):
            continue
    registered = {m["name"].split(" · ", 1)[0] for m in models}
    pending_repos = {p["name"] for p in pending}
    for row in rows[:4096]:
        repo = row.get("repo_id") if isinstance(row, dict) else None
        if (repo and row.get("is_diffusion") and not row.get("is_adapter")
                and repo.lower() not in component_repos and repo not in registered | pending_repos):
            pending.append({"name": repo, "reason": "Download is incomplete or needs a supported standalone checkpoint and components."})
            pending_repos.add(repo)
    ordered = sorted(models, key=lambda m: m["id"])
    if len(ordered) > 256:
        pending.append({"name": "Image catalogue", "reason": "The manager supports 256 image models; remove unused cache entries to register more."})
    return ordered[:256], pending


class LocalImageEngine:
    def __init__(self, data_dir=DATA_DIR, *, scanner=None):
        self.home = Path(data_dir).resolve() / "engine-manager"
        self.home.mkdir(mode=0o700, parents=True, exist_ok=True)
        if self.home.is_symlink() or (hasattr(os, "getuid") and self.home.stat().st_uid != os.getuid()):
            raise ValueError("Unsafe engine manager storage")
        self.home.chmod(0o700)
        self.lock = threading.RLock()
        # A slow first scan must not block controls or duplicate Start scans.
        self.start_lock = threading.Lock()
        # Stop invalidates a Start that was already scanning the cache.
        self.stop_generation = 0
        self.refresh_lock = threading.Lock()
        self.wake = threading.Event()
        self.closed = threading.Event()
        self.process = None
        self.scan_process = None
        self.thread = None
        self.models, self.pending = [], []
        self.error = ""
        self.effective_mode = None
        self.scanner = scanner or self.scan
        self.settings = {"auto_start": True, "mode": "auto", "idle_seconds": 300, "roots": []}
        path = self.home / "settings.json"
        if path.exists():
            if path.is_symlink():
                raise ValueError("Unsafe engine settings")
            self.settings.update(json.loads(path.read_text()))
        self.image_token = self._token("image.token")
        self.native_token = self._token("native.token")
        self.port = DEFAULT_PORT

    def _token(self, name):
        path = self.home / name
        if not path.exists():
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "w") as stream:
                stream.write(secrets.token_urlsafe(32))
        if (path.is_symlink() or (hasattr(os, "getuid") and path.stat().st_uid != os.getuid())
                or path.stat().st_mode & 0o077):
            raise ValueError("Unsafe engine credential storage")
        token = path.read_text().strip()
        if len(token) < 32:
            raise ValueError("Invalid engine credential")
        return token

    def native_authorized(self, value):
        return isinstance(value, str) and hmac.compare_digest(value, self.native_token)

    def _binary(self):
        mode = self.settings["mode"]
        if mode == "auto":
            gpu = any(os.access(p, os.R_OK | os.W_OK) for p in Path("/dev/dri").glob("renderD*"))
            mode = "zvram" if gpu and shutil.which("sd-server-zvram") else "vulkan" if gpu else "cpu"
        binary = shutil.which({"cpu":"sd-server", "vulkan":"sd-server-vulkan", "zvram":"sd-server-zvram"}[mode])
        if not binary:
            raise ValueError("The configured stable-diffusion.cpp engine is not installed.")
        self.effective_mode = mode
        return str(Path(binary).resolve()), mode

    def scan(self):
        from routes.cookbook_helpers import _cached_model_scan_script
        with tempfile.TemporaryFile() as output, tempfile.TemporaryFile() as errors:
            proc = subprocess.Popen([sys.executable, "-I", "-"], stdin=subprocess.PIPE,
                                    stdout=output, stderr=errors)
            self.scan_process = proc
            try:
                proc.communicate(_cached_model_scan_script(self.settings.get("roots", [])).encode(), timeout=30)
                if proc.returncode != 0:
                    raise ValueError("The cached model scan could not complete")
                output.seek(0)
                data = output.read(8 * 1024 * 1024 + 1)
            finally:
                if proc.poll() is None:
                    proc.terminate()
                    try:
                        proc.wait(timeout=2)
                    except subprocess.TimeoutExpired:
                        proc.kill()
                        proc.wait(timeout=2)
                self.scan_process = None
        if len(data) > 8 * 1024 * 1024:
            raise ValueError("Cached model catalogue exceeds the inspection budget")
        rows = json.loads(data)
        if not isinstance(rows, list):
            raise ValueError("Invalid cached model catalogue")
        return rows

    def refresh(self, rows=None):
        # Coalesce refreshes. A cache walk must not hold the control lock and
        # make Configure/Stop wait behind another complete scan.
        if not self.refresh_lock.acquire(blocking=False):
            return False
        try:
            scanned = self.scanner() if rows is None else rows
            with self.lock:
                selected_mode = self.settings["mode"]
                binary, mode = self._binary()
            models, pending = image_catalog(scanned, binary, mode)
            with self.lock:
                if self.settings["mode"] != selected_mode:
                    self.wake.set()
                    raise ValueError("Engine settings changed during refresh; a new scan was scheduled.")
                previous = {}
                path = self.home / "image-models.json"
                if path.exists():
                    if path.is_symlink():
                        raise ValueError("Unsafe image catalogue")
                    previous = json.loads(path.read_text())
                default = previous.get("default_model")
                if default not in {m["id"] for m in models}:
                    default = models[0]["id"] if models else None
                catalog = {"version": 1, "models": models, "default_model": default,
                           "idle_seconds": self.settings["idle_seconds"]}
                if catalog != previous:
                    _private_json(path, catalog)
                self.models, self.pending, self.error = models, pending, ""
                self.register_endpoint()
            return True
        finally:
            self.refresh_lock.release()

    def register_endpoint(self):
        from core.database import SessionLocal, ModelEndpoint
        ids = [m["id"] for m in self.models]
        with SessionLocal() as db:
            endpoint = db.query(ModelEndpoint).filter(ModelEndpoint.id == ENGINE_ID).first()
            base = f"http://127.0.0.1:{self.port}/v1"
            if endpoint is not None and (endpoint.name != ENGINE_NAME or endpoint.base_url != base):
                raise ValueError("The managed image endpoint was changed; refusing to overwrite it")
            if endpoint is None:
                endpoint = ModelEndpoint(id=ENGINE_ID, name=ENGINE_NAME, base_url=base)
                db.add(endpoint)
            endpoint.api_key = self.image_token
            endpoint.model_type = "image"
            endpoint.endpoint_kind = "local"
            endpoint.model_refresh_mode = "manual"
            endpoint.is_enabled = bool(ids and self.process is not None and self.process.poll() is None)
            endpoint.cached_models = json.dumps(ids)
            endpoint.pinned_models = json.dumps(ids)
            db.commit()
            if endpoint.is_enabled:
                self._select_default(db, ids)

    def _select_default(self, db, ids):
        """Fill an unset selection, or recover a stopped Cookbook-owned server.

        Explicit cloud/manual/remote selections and the enable toggle survive.
        Old endpoints are retained rather than adopted, deleted or stopped.
        """
        from core.database import ModelEndpoint
        from src.settings import load_settings, save_settings
        import socket
        settings = load_settings()
        selected = settings.get("image_model", "")
        if selected:
            if not selected.startswith("sd-cpp-local@"):
                return
            old = db.query(ModelEndpoint).filter(ModelEndpoint.name == selected.split("@", 1)[1],
                                                  ModelEndpoint.model_type == "image").first()
            if old is None or not re.fullmatch(r"img-sdcpp-[a-f0-9]{12}", old.id):
                return
            address = urlsplit(old.base_url)
            if address.scheme != "http" or address.hostname not in {"localhost", "127.0.0.1", "::1"}:
                return
            try:
                with socket.create_connection((address.hostname, address.port or 80), timeout=0.2):
                    return  # A running server remains the user's selection.
            except OSError:
                pass
        updated = dict(settings)
        updated["image_model"] = f"{ids[0]}@{ENGINE_NAME}"
        save_settings(updated)

    def health(self):
        from scripts.managed_image_engine import _owned_listener
        proc = self.process
        if proc is None or proc.poll() is not None or not _owned_listener(self.port, proc.pid):
            raise ValueError("The owned image engine does not hold its listener")
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=1)
        try:
            connection.request("GET", "/health", headers={"Authorization":"Bearer " + self.image_token})
            response = connection.getresponse()
            body = response.read(65537)
            if response.status != 200 or len(body) > 65536:
                raise ValueError("The image engine is not ready")
            data = json.loads(body)
        finally:
            connection.close()
        if not isinstance(data, dict) or data.get("engine") != "novum-image-engine":
            raise ValueError("The image engine port belongs to another service")
        return data

    def start(self):
        with self.lock:
            generation = self.stop_generation
        with self.start_lock:
            with self.lock:
                if self.closed.is_set() or generation != self.stop_generation:
                    return
                if self.process is not None and self.process.poll() is None:
                    return
            if not (self.home / "image-models.json").exists():
                if not self.refresh():
                    raise ValueError("The initial model scan is still running. Try again when it finishes.")

            with self.lock:
                if self.closed.is_set() or generation != self.stop_generation:
                    return
                if self.process is not None and self.process.poll() is None:
                    return
                # Never adopt or kill a listener merely because it owns this port.
                import socket
                with socket.socket() as sock:
                    # Match HTTPServer's address reuse after an owned Stop. Without
                    # it, TIME_WAIT sockets can block an immediate Start for a minute.
                    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                    sock.bind(("127.0.0.1", self.port))
                script = Path(__file__).resolve().parents[1] / "scripts/managed_image_engine.py"
                log = (self.home / "image-engine.log").open("ab")
                try:
                    proc = subprocess.Popen([sys.executable, "-I", str(script),
                        "--catalog", str(self.home / "image-models.json"), "--port", str(self.port),
                        "--token-file", str(self.home / "image.token"), "--parent-pid", str(os.getpid())],
                        stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
                        **({"start_new_session": True} if os.name != "nt" else {}))
                    self.process = proc
                finally:
                    log.close()
            for _ in range(25):
                with self.lock:
                    if self.closed.is_set() or generation != self.stop_generation or self.process is not proc:
                        return
                if proc.poll() is not None:
                    with self.lock:
                        if self.process is proc:
                            self.process = None
                    raise ValueError("The image engine stopped before becoming ready. Check its manager log.")
                try:
                    self.health()
                    with self.lock:
                        if self.closed.is_set() or generation != self.stop_generation or self.process is not proc:
                            return
                        self.register_endpoint()
                    return
                except (OSError, ValueError, urllib.error.URLError):
                    time.sleep(0.2)
            with self.lock:
                if self.process is not proc or generation != self.stop_generation:
                    return
                self.process = None
                if proc.poll() is None:
                    proc.terminate()
                    try:
                        proc.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        proc.kill()
                        proc.wait(timeout=2)
            raise ValueError("The image engine did not become ready in time.")

    def stop(self):
        with self.lock:
            self.stop_generation += 1
            proc, self.process = self.process, None
            if proc is not None and proc.poll() is None:
                proc.terminate()
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait(timeout=2)

    def configure(self, values):
        with self.lock:
            unknown = set(values) - {"mode", "auto_start", "idle_seconds"}
            if unknown:
                raise ValueError("Unsupported engine settings")
            mode = values.get("mode", self.settings["mode"])
            auto = values.get("auto_start", self.settings["auto_start"])
            idle = values.get("idle_seconds", self.settings["idle_seconds"])
            if mode not in MODES or type(auto) is not bool or type(idle) is not int or not 30 <= idle <= 3600:
                raise ValueError("Invalid image engine settings")
            # Apply settings to the next model load, never interrupt generation.
            self.settings.update(mode=mode, auto_start=auto, idle_seconds=idle)
            _private_json(self.home / "settings.json", self.settings)
            self.wake.set()

    def add_cache_root(self, directory):
        if not directory:
            self.wake.set()
            return
        root = str(Path(directory).expanduser().resolve())
        with self.lock:
            roots = self.settings.setdefault("roots", [])
            if root not in roots:
                roots.append(root)
                _private_json(self.home / "settings.json", self.settings)
            self.wake.set()

    def status(self):
        running = self.process is not None and self.process.poll() is None
        health = {}
        if running:
            try:
                health = self.health()
            except (OSError, ValueError, urllib.error.URLError):
                pass
        return {"available": self.effective_mode is not None, "running": running, "healthy": bool(health),
                "state": "ready" if health else "starting" if running else "error" if self.error else "stopped",
                "mode": self.settings["mode"], "effective_mode": self.effective_mode,
                "auto_start": self.settings["auto_start"], "idle_seconds": self.settings["idle_seconds"],
                "loaded_model": health.get("loaded_model"), "generation_active": health.get("generation_active", False),
                "models": [{k:m[k] for k in ("id", "name", "size_bytes")} for m in self.models],
                "pending": self.pending, "error": self.error}

    def run(self):
        def work():
            while not self.closed.is_set():
                try:
                    self.refresh()
                    if self.settings["auto_start"] and not self.closed.is_set():
                        self.start()
                except Exception as exc:
                    self.error = str(exc)[:300]
                    logger.warning("Local image engine is pending: %s", type(exc).__name__)
                self.wake.wait(30)
                self.wake.clear()
        self.thread = threading.Thread(target=work, name="novum-image-engine", daemon=True)
        self.thread.start()

    def close(self):
        self.closed.set()
        self.wake.set()
        scanner = self.scan_process
        if scanner is not None and scanner.poll() is None:
            scanner.terminate()
        if self.thread:
            self.thread.join(timeout=5)
        self.stop()
