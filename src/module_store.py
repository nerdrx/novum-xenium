"""Immutable, data-only workspace module packages."""

from __future__ import annotations

import hashlib
import io
import json
import os
import re
import shutil
import stat
import threading
import zipfile
from pathlib import Path, PurePosixPath
from urllib.parse import urlsplit

from core.atomic_io import atomic_write_json


MAX_PACKAGE_BYTES = 10 * 1024 * 1024
MAX_EXPANDED_BYTES = 20 * 1024 * 1024
MAX_FILES = 100
ID_RE = re.compile(r"^[a-z][a-z0-9-]{0,62}$")
VERSION_RE = re.compile(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$")
ASSET_SUFFIXES = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".woff", ".woff2"}
_LOCK = threading.RLock()


class ModulePackageError(ValueError):
    def __init__(self, status_code: int, detail: str):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


def _safe_relative(raw: str) -> PurePosixPath:
    if not isinstance(raw, str) or not raw or "\\" in raw or "\x00" in raw:
        raise ModulePackageError(400, "Invalid package path")
    if raw.startswith("/") or any(part in ("", ".", "..") for part in raw.split("/")):
        raise ModulePackageError(400, "Invalid package path")
    path = PurePosixPath(raw)
    if path.is_absolute() or any(part in ("", ".", "..") for part in path.parts):
        raise ModulePackageError(400, "Invalid package path")
    if ":" in path.parts[0] or len(raw) > 240:
        raise ModulePackageError(400, "Invalid package path")
    return path


def _validate_manifest(raw: bytes) -> dict:
    if len(raw) > 64 * 1024:
        raise ModulePackageError(413, "module.json exceeds 64 KiB")
    try:
        manifest = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise ModulePackageError(400, "module.json must be valid UTF-8 JSON") from None
    if not isinstance(manifest, dict):
        raise ModulePackageError(400, "module.json must contain an object")
    allowed = {"api_version", "id", "name", "version", "description", "panel", "mcp_server_ids", "mcp", "permissions"}
    if set(manifest) - allowed:
        raise ModulePackageError(400, "module.json contains unsupported fields")
    if isinstance(manifest.get("api_version"), bool) or manifest.get("api_version") != 1:
        raise ModulePackageError(400, "Unsupported module API version")
    module_id = manifest.get("id")
    name = manifest.get("name")
    version = manifest.get("version")
    description = manifest.get("description", "")
    if not isinstance(module_id, str) or not ID_RE.fullmatch(module_id):
        raise ModulePackageError(400, "Module id must be a lowercase slug")
    if not isinstance(name, str) or not name.strip() or len(name) > 100:
        raise ModulePackageError(400, "Module name must be 1-100 characters")
    if not isinstance(version, str) or not VERSION_RE.fullmatch(version):
        raise ModulePackageError(400, "Module version must be semantic major.minor.patch")
    if not isinstance(description, str) or len(description) > 500:
        raise ModulePackageError(400, "Module description must be at most 500 characters")
    panel = manifest.get("panel")
    if panel is not None:
        path = _safe_relative(panel)
        if path.suffix.lower() != ".html":
            raise ModulePackageError(400, "Module panel must be an HTML file")
        manifest["panel"] = path.as_posix()
    refs = manifest.get("mcp_server_ids", [])
    if not isinstance(refs, list) or len(refs) > 20 or any(
        not isinstance(item, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", item) for item in refs
    ):
        raise ModulePackageError(400, "mcp_server_ids must be a list of configured server ids")
    manifest["mcp_server_ids"] = list(dict.fromkeys(refs))
    permissions = manifest.get("permissions", [])
    allowed_permissions = {"downloads", "git", "models", "images", "research", "runs", "subagents"}
    if not isinstance(permissions, list) or len(permissions) > len(allowed_permissions) or any(
        not isinstance(item, str) or item not in allowed_permissions for item in permissions
    ) or len(set(permissions)) != len(permissions):
        raise ModulePackageError(400, "permissions must be a unique list of supported capabilities")
    manifest["permissions"] = permissions
    mcp = manifest.get("mcp")
    if mcp is not None:
        if not isinstance(mcp, dict) or set(mcp) - {"name", "transport", "url"}:
            raise ModulePackageError(400, "mcp must include only name, transport, and url")
        mcp_name, transport, url = mcp.get("name"), mcp.get("transport"), mcp.get("url")
        if not isinstance(mcp_name, str) or not mcp_name.strip() or len(mcp_name) > 100:
            raise ModulePackageError(400, "MCP server name must be 1-100 characters")
        if transport not in ("http", "sse") or not isinstance(url, str) or len(url) > 2048:
            raise ModulePackageError(400, "MCP server needs an HTTP or SSE URL")
        if any(ord(char) <= 0x20 or ord(char) == 0x7F for char in url) or "\\" in url:
            raise ModulePackageError(400, "MCP URL contains invalid whitespace or characters")
        try:
            parsed = urlsplit(url)
            hostname = parsed.hostname
            port = parsed.port
        except ValueError:
            raise ModulePackageError(400, "MCP URL is malformed") from None
        if (parsed.scheme not in ("http", "https") or not hostname or parsed.username or parsed.password
                or parsed.query or parsed.fragment or (port is not None and not 1 <= port <= 65535)):
            raise ModulePackageError(400, "MCP URL must be HTTP(S), without credentials or query parameters")
        manifest["mcp"] = {"name": mcp_name.strip(), "transport": transport, "url": url}
    if panel is None and not manifest["mcp_server_ids"] and mcp is None:
        raise ModulePackageError(400, "Module must declare a panel or an MCP tool connection")
    return manifest


def _read_package(package: bytes) -> tuple[dict, dict[str, bytes], str]:
    if not isinstance(package, bytes) or not package or len(package) > MAX_PACKAGE_BYTES:
        raise ModulePackageError(413, "Package must be between 1 byte and 10 MiB")
    digest = hashlib.sha256(package).hexdigest()
    try:
        archive = zipfile.ZipFile(io.BytesIO(package))
    except (zipfile.BadZipFile, OSError):
        raise ModulePackageError(400, "Upload must be a valid ZIP package") from None
    with archive:
        infos = archive.infolist()
        if not infos or len(infos) > MAX_FILES:
            raise ModulePackageError(400, "Package must contain 1-100 entries")
        contents: dict[str, bytes] = {}
        folded: set[str] = set()
        expanded = 0
        for info in infos:
            path = _safe_relative(info.filename.rstrip("/") if info.is_dir() else info.filename)
            key = path.as_posix()
            if key.casefold() in folded:
                raise ModulePackageError(400, "Package contains duplicate paths")
            folded.add(key.casefold())
            mode = info.external_attr >> 16
            file_type = stat.S_IFMT(mode)
            if info.flag_bits & 1 or file_type == stat.S_IFLNK or (file_type and file_type not in (stat.S_IFREG, stat.S_IFDIR)):
                raise ModulePackageError(400, "Encrypted and non-regular package entries are not allowed")
            if info.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
                raise ModulePackageError(400, "Unsupported package compression")
            if info.is_dir():
                continue
            expanded += info.file_size
            if expanded > MAX_EXPANDED_BYTES:
                raise ModulePackageError(413, "Expanded package exceeds 20 MiB")
            try:
                data = archive.read(info)
            except (RuntimeError, zipfile.BadZipFile, OSError):
                raise ModulePackageError(400, "Package contains an unreadable entry") from None
            if len(data) != info.file_size:
                raise ModulePackageError(400, "Package contains a truncated entry")
            contents[key] = data
    if "module.json" not in contents:
        raise ModulePackageError(400, "Package must include module.json")
    manifest = _validate_manifest(contents["module.json"])
    panel_path = manifest.get("panel")
    if panel_path and panel_path not in contents:
        raise ModulePackageError(400, "Declared panel file is missing")
    allowed_files = {"module.json"}
    if panel_path:
        allowed_files.add(panel_path)
        panel = contents[panel_path]
        if len(panel) > 1024 * 1024:
            raise ModulePackageError(413, "Panel HTML exceeds 1 MiB")
        try:
            markup = panel.decode("utf-8")
        except UnicodeDecodeError:
            raise ModulePackageError(400, "Panel HTML must be UTF-8") from None
        if re.search(r"<script\b[^>]*\bsrc\s*=|<meta\b[^>]*http-equiv\s*=\s*[\"']?refresh", markup, re.I):
            raise ModulePackageError(400, "Panels cannot load remote scripts or use refresh redirects")
    for key in contents:
        if key in allowed_files:
            continue
        item = _safe_relative(key)
        if len(item.parts) < 2 or item.parts[0] != "assets" or item.suffix.lower() not in ASSET_SUFFIXES:
            raise ModulePackageError(400, "Only inert image and font files are allowed under assets/")
    return manifest, contents, digest


class ModuleStore:
    def __init__(self, data_dir: str | os.PathLike):
        self.root = Path(data_dir) / "modules"
        self.packages = self.root / "packages"
        self.state_path = self.root / "state.json"

    def _state(self) -> dict:
        if not self.state_path.exists():
            return {"modules": {}}
        try:
            value = json.loads(self.state_path.read_text(encoding="utf-8"))
        except (OSError, ValueError, TypeError):
            raise RuntimeError("Module registry is unreadable; refusing to overwrite installed module state") from None
        if not isinstance(value, dict) or not isinstance(value.get("modules"), dict):
            raise RuntimeError("Module registry is invalid; refusing to overwrite installed module state")
        return value

    def _save(self, state: dict) -> None:
        atomic_write_json(str(self.state_path), state, indent=2)

    @staticmethod
    def _package_key(module_id: str, version: str, digest: str) -> str:
        return f"{module_id}/{version}/{digest}"

    def list(self) -> list[dict]:
        with _LOCK:
            return [dict(item) for item in self._state()["modules"].values()]

    def get(self, module_id: str) -> dict | None:
        if not ID_RE.fullmatch(module_id or ""):
            return None
        with _LOCK:
            item = self._state()["modules"].get(module_id)
            return dict(item) if item else None

    def install(self, package: bytes, source: dict | None = None) -> tuple[dict, bool]:
        manifest, contents, digest = _read_package(package)
        module_id, version = manifest["id"], manifest["version"]
        package_key = self._package_key(module_id, version, digest)
        destination = self.packages / module_id / version / digest
        with _LOCK:
            state = self._state()
            current = state["modules"].get(module_id)
            if current and current.get("source") != source:
                raise ModulePackageError(409, "Module id is already installed from another source")
            if current and current["version"] == version:
                if current["digest"] != digest:
                    raise ModulePackageError(409, "This module version is immutable and already installed")
                return dict(current), False
            if current and current["digest"] == digest:
                raise ModulePackageError(409, "This package digest is already the active version")
            if not destination.exists():
                staging = destination.with_name(f".{digest}.tmp")
                if staging.exists():
                    shutil.rmtree(staging)
                staging.mkdir(parents=True, exist_ok=True)
                try:
                    for name, content in contents.items():
                        output = staging.joinpath(*PurePosixPath(name).parts)
                        output.parent.mkdir(parents=True, exist_ok=True)
                        output.write_bytes(content)
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    os.replace(staging, destination)
                finally:
                    if staging.exists():
                        shutil.rmtree(staging, ignore_errors=True)
            item = {
                "id": module_id, "name": manifest["name"].strip(), "version": version,
                "description": manifest.get("description", "").strip(), "panel": manifest.get("panel"),
                "mcp": manifest.get("mcp"), "mcp_server_ids": manifest["mcp_server_ids"],
                "permissions": manifest["permissions"],
                "digest": digest, "package_key": package_key, "enabled": False,
            }
            if source:
                item["source"] = dict(source)
            if current:
                item["previous"] = {key: current.get(key) for key in ("version", "digest", "package_key", "enabled", "name", "description", "panel", "mcp", "mcp_server_ids", "permissions", "source")}
            state["modules"][module_id] = item
            self._save(state)
            return dict(item), True

    def set_enabled(self, module_id: str, enabled: bool) -> dict:
        if not isinstance(enabled, bool):
            raise ModulePackageError(400, "enabled must be a boolean")
        with _LOCK:
            state = self._state()
            item = state["modules"].get(module_id)
            if not item:
                raise ModulePackageError(404, "Module not found")
            item["enabled"] = enabled
            self._save(state)
            return dict(item)

    def rollback(self, module_id: str) -> dict:
        with _LOCK:
            state = self._state()
            item = state["modules"].get(module_id)
            if not item:
                raise ModulePackageError(404, "Module not found")
            previous = item.pop("previous", None)
            if not previous:
                raise ModulePackageError(409, "No earlier version is available")
            restored = dict(previous)
            restored["id"] = module_id
            restored["enabled"] = False
            restored["previous"] = {key: item.get(key) for key in ("version", "digest", "package_key", "enabled", "name", "description", "panel", "mcp", "mcp_server_ids", "permissions", "source")}
            state["modules"][module_id] = restored
            self._save(state)
            return dict(restored)

    def delete(self, module_id: str) -> None:
        with _LOCK:
            state = self._state()
            if state["modules"].pop(module_id, None) is None:
                raise ModulePackageError(404, "Module not found")
            self._save(state)

    def read_panel(self, module_id: str) -> bytes:
        item = self.get(module_id)
        if not item:
            raise ModulePackageError(404, "Module not found")
        if not item.get("enabled"):
            raise ModulePackageError(404, "Module is disabled")
        if not item.get("panel"):
            raise ModulePackageError(404, "Module has no panel")
        path = self.packages / item["package_key"] / item["panel"]
        try:
            return path.read_bytes()
        except OSError:
            raise ModulePackageError(404, "Module panel not found") from None

    def read_asset(self, module_id: str, asset_path: str) -> tuple[bytes, str]:
        item = self.get(module_id)
        if not item or not item.get("enabled"):
            raise ModulePackageError(404, "Module not found")
        relative = _safe_relative(asset_path)
        if len(relative.parts) < 2 or relative.parts[0] != "assets" or relative.suffix.lower() not in ASSET_SUFFIXES:
            raise ModulePackageError(404, "Asset not found")
        path = self.packages / item["package_key"] / relative
        try:
            data = path.read_bytes()
        except OSError:
            raise ModulePackageError(404, "Asset not found") from None
        mime = {".png":"image/png", ".jpg":"image/jpeg", ".jpeg":"image/jpeg", ".gif":"image/gif",
                ".webp":"image/webp", ".ico":"image/x-icon", ".woff":"font/woff", ".woff2":"font/woff2"}[relative.suffix.lower()]
        return data, mime
