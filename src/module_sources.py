"""Pinned, data-only module catalogs hosted in public GitHub repositories."""

from __future__ import annotations

import hashlib
import io
import json
import re
import threading
import time
import zipfile
from pathlib import Path
from urllib.parse import quote, urlsplit

import httpx

from core.atomic_io import atomic_write_json
from src.module_store import MAX_PACKAGE_BYTES, ModulePackageError, ModuleStore, _safe_relative, _validate_manifest

_LOCK = threading.RLock()
_SOURCE_URL = re.compile(r"^https://github\.com/([A-Za-z0-9-]+)/([A-Za-z0-9_.-]+?)(?:\.git)?/?$")
_MAX_CATALOG = 512 * 1024
_MAX_CATALOG_MODULES = 100
_MAX_FILE_BYTES = 1024 * 1024
_OPERATION_SECONDS = 25


def _check_deadline(deadline):
    if deadline is not None and time.monotonic() >= deadline:
        raise ModulePackageError(504, "GitHub operation exceeded its time limit")


def parse_repo_url(url: str) -> tuple[str, str, str]:
    if not isinstance(url, str) or len(url) > 300:
        raise ModulePackageError(400, "Enter a public GitHub repository URL")
    match = _SOURCE_URL.fullmatch(url.strip())
    if not match or match.group(2) in (".", ".."):
        raise ModulePackageError(400, "Enter a public github.com owner/repository URL")
    owner, repo = match.groups()
    canonical = f"https://github.com/{owner}/{repo}"
    return owner, repo, canonical


class ModuleSources:
    def __init__(self, data_dir, store: ModuleStore):
        self.path = Path(data_dir) / "modules" / "sources.json"
        self.store = store

    def _read(self):
        if not self.path.exists():
            return {"sources": {}}
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            raise RuntimeError("Module source registry is unreadable") from None
        if not isinstance(data, dict) or not isinstance(data.get("sources"), dict):
            raise RuntimeError("Module source registry is invalid")
        return data

    def _save(self, data):
        atomic_write_json(str(self.path), data, indent=2)

    @staticmethod
    def _request(client, url, limit, deadline=None):
        try:
            _check_deadline(deadline)
            with client.stream("GET", url) as response:
                if response.url.host != urlsplit(url).hostname:
                    raise ModulePackageError(502, "GitHub returned an unexpected redirect")
                if response.status_code in (401, 403):
                    raise ModulePackageError(502, "GitHub denied access or rate limited this request")
                if response.status_code == 429:
                    raise ModulePackageError(502, "GitHub rate limited this request")
                if response.status_code == 404:
                    raise ModulePackageError(404, "Repository or module catalog not found; private repositories are unsupported")
                if response.status_code != 200:
                    raise ModulePackageError(502, "GitHub request failed")
                body = bytearray()
                for chunk in response.iter_bytes():
                    _check_deadline(deadline)
                    body.extend(chunk)
                    if len(body) > limit:
                        raise ModulePackageError(413, "GitHub module source exceeds the size limit")
                return bytes(body)
        except httpx.TimeoutException:
            raise ModulePackageError(504, "GitHub request timed out") from None
        except httpx.HTTPError:
            raise ModulePackageError(502, "Could not reach GitHub") from None

    def _catalog(self, owner, repo, deadline=None):
        api = f"https://api.github.com/repos/{owner}/{repo}"
        headers = {"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"}
        remaining = max(0.001, deadline - time.monotonic()) if deadline else 8
        with httpx.Client(timeout=httpx.Timeout(min(8, remaining), connect=min(3, remaining)),
                          follow_redirects=False, trust_env=False, headers=headers) as client:
            metadata = self._request(client, api, 256 * 1024, deadline)
            try:
                branch = json.loads(metadata)["default_branch"]
            except (ValueError, KeyError, TypeError):
                raise ModulePackageError(502, "GitHub repository metadata is invalid") from None
            if not isinstance(branch, str) or not branch or len(branch) > 255:
                raise ModulePackageError(502, "GitHub default branch is invalid")
            branch_url = f"{api}/branches/{quote(branch, safe='')}"
            branch_data = self._request(client, branch_url, 256 * 1024, deadline)
            try:
                commit = json.loads(branch_data)["commit"]["sha"]
            except (ValueError, KeyError, TypeError):
                raise ModulePackageError(502, "GitHub branch response is invalid") from None
            if not isinstance(commit, str) or not re.fullmatch(r"[0-9a-fA-F]{40,64}", commit):
                raise ModulePackageError(502, "GitHub returned an invalid commit")
            raw = f"https://raw.githubusercontent.com/{owner}/{repo}/{commit}/modules/index.json"
            catalog_bytes = self._request(client, raw, _MAX_CATALOG, deadline)
            try:
                catalog = json.loads(catalog_bytes)
            except (UnicodeDecodeError, ValueError):
                raise ModulePackageError(400, "modules/index.json must be valid JSON") from None
            return commit, self._validate_catalog(catalog)

    @staticmethod
    def _validate_catalog(catalog):
        if not isinstance(catalog, dict) or catalog.get("api_version") != 1 or isinstance(catalog.get("api_version"), bool):
            raise ModulePackageError(400, "Unsupported module catalog API version")
        modules = catalog.get("modules")
        if not isinstance(modules, list) or len(modules) > _MAX_CATALOG_MODULES:
            raise ModulePackageError(400, "Catalog must contain at most 100 modules")
        result = []
        ids = set()
        for entry in modules:
            if not isinstance(entry, dict) or set(entry) != {"path", "files"}:
                raise ModulePackageError(400, "Invalid module catalog entry")
            path = _safe_relative(entry["path"])
            files = entry["files"]
            if not isinstance(files, list) or not 1 <= len(files) <= 100:
                raise ModulePackageError(400, "Invalid module catalog path or files")
            clean = []
            for name in files:
                rel = _safe_relative(name)
                if name in clean:
                    raise ModulePackageError(400, "Catalog files must be unique paths within the module")
                clean.append(name)
            if "module.json" not in clean:
                raise ModulePackageError(400, "Catalog module must include module.json")
            result.append({"path": path.as_posix(), "files": clean})
        return result

    @staticmethod
    def _source_id(url):
        return hashlib.sha256(url.lower().encode()).hexdigest()[:16]

    def add(self, url):
        deadline = time.monotonic() + _OPERATION_SECONDS
        owner, repo, canonical = parse_repo_url(url)
        commit, entries = self._catalog(owner, repo, deadline)
        modules = []
        total = 0
        ids = set()
        for entry in entries:
            prefix = f"modules/{entry['path']}/"
            manifest_data = self._fetch_file(owner, repo, commit, prefix + "module.json", deadline)
            total += len(manifest_data)
            if total > MAX_PACKAGE_BYTES:
                raise ModulePackageError(413, "GitHub module catalog exceeds 10 MiB")
            manifest = _validate_manifest(manifest_data)
            if manifest["id"] in ids:
                raise ModulePackageError(400, "Catalog contains duplicate module ids")
            ids.add(manifest["id"])
            modules.append({"id": manifest["id"], "name": manifest.get("name"), "version": manifest.get("version"),
                            "description": manifest.get("description", ""), "permissions": manifest.get("permissions", []),
                            "path": entry["path"], "files": entry["files"]})
        source_id = self._source_id(canonical)
        with _LOCK:
            data = self._read()
            data["sources"][source_id] = {"id": source_id, "url": canonical, "commit": commit, "modules": modules}
            self._save(data)
        return self.public_source(data["sources"][source_id])

    def _fetch_file(self, owner, repo, commit, file_path, deadline=None):
        url = f"https://raw.githubusercontent.com/{owner}/{repo}/{commit}/{quote(file_path, safe='/')}"
        remaining = max(0.001, deadline - time.monotonic()) if deadline else 8
        with httpx.Client(timeout=httpx.Timeout(min(8, remaining), connect=min(3, remaining)),
                          follow_redirects=False, trust_env=False) as client:
            return self._request(client, url, _MAX_FILE_BYTES, deadline)

    def list(self):
        with _LOCK:
            data = self._read()
            return [self.public_source(source) for source in data["sources"].values()]

    def public_source(self, source):
        installed = {m["id"]: m for m in self.store.list()}
        modules = []
        for module in source["modules"]:
            current = installed.get(module["id"])
            conflict = bool(current and (current.get("source") or {}).get("id") != source["id"])
            modules.append({"id": module["id"], "name": module["name"], "version": module["version"],
                            "description": module["description"],
                            "permissions": module.get("permissions", []),
                            "installed_version": current["version"] if current and not conflict else None,
                            "enabled": bool(current and not conflict and current["enabled"]),
                            "conflict": conflict})
        return {"id": source["id"], "url": source["url"], "commit": source["commit"], "modules": modules}

    def delete(self, source_id):
        with _LOCK:
            data = self._read()
            if data["sources"].pop(source_id, None) is None:
                raise ModulePackageError(404, "Module source not found")
            self._save(data)

    def install(self, source_id, module_id):
        with _LOCK:
            source = self._read()["sources"].get(source_id)
            if not source:
                raise ModulePackageError(404, "Module source not found")
            module = next((m for m in source["modules"] if m["id"] == module_id), None)
            if not module:
                raise ModulePackageError(404, "Module not advertised by this source")
            source = json.loads(json.dumps(source))
            module = json.loads(json.dumps(module))
        deadline = time.monotonic() + _OPERATION_SECONDS
        owner, repo, _ = parse_repo_url(source["url"])
        package = io.BytesIO()
        total = 0
        with zipfile.ZipFile(package, "w", zipfile.ZIP_STORED) as archive:
            for filename in sorted(module["files"]):
                content = self._fetch_file(owner, repo, source["commit"], f"modules/{module['path']}/{filename}", deadline)
                total += len(content)
                if total > MAX_PACKAGE_BYTES:
                    raise ModulePackageError(413, "GitHub module package exceeds 10 MiB")
                info = zipfile.ZipInfo(filename, date_time=(1980, 1, 1, 0, 0, 0))
                archive.writestr(info, content, compress_type=zipfile.ZIP_STORED)
        with _LOCK:
            current = self._read()["sources"].get(source_id)
            if not current or current.get("commit") != source["commit"]:
                raise ModulePackageError(409, "Module source changed while the package was downloading; retry")
            item, _ = self.store.install(package.getvalue(), source={"id": source_id, "url": source["url"], "commit": source["commit"]})
            return item
