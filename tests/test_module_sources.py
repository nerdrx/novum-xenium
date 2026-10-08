import json
import io
import zipfile

import httpx
import pytest

from src.module_sources import ModuleSources, parse_repo_url
from src.module_store import ModulePackageError, ModuleStore
from src import module_sources


COMMIT = "a" * 40
MANIFEST = {"api_version": 1, "id": "focus-timer", "name": "Focus Timer", "version": "1.2.0",
            "description": "Timer panel", "panel": "panel.html", "mcp_server_ids": []}
FILES = {
    f"https://api.github.com/repos/acme/tools": {"default_branch": "main"},
    f"https://api.github.com/repos/acme/tools/branches/main": {"commit": {"sha": COMMIT}},
    f"https://raw.githubusercontent.com/acme/tools/{COMMIT}/modules/index.json": {
        "api_version": 1, "modules": [{"path": "focus-timer", "files": ["module.json", "panel.html"]}]},
    f"https://raw.githubusercontent.com/acme/tools/{COMMIT}/modules/focus-timer/module.json": MANIFEST,
    f"https://raw.githubusercontent.com/acme/tools/{COMMIT}/modules/focus-timer/panel.html": "<h1>Timer</h1>",
}
REQUESTED = []


class FakeStream:
    def __init__(self, url):
        self.url = httpx.URL(url)
        self.status_code = 200
        value = FILES.get(url)
        self.body = json.dumps(value).encode() if isinstance(value, dict) else value.encode() if isinstance(value, str) else b""

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def iter_bytes(self):
        yield self.body


class FakeClient:
    def __init__(self, *args, **kwargs):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def stream(self, method, url):
        REQUESTED.append(str(url))
        return FakeStream(str(url))


def test_public_repo_url_validation():
    assert parse_repo_url("https://github.com/acme/tools.git/") == (
        "acme", "tools", "https://github.com/acme/tools")
    for url in ("https://github.com.evil/acme/tools", "https://user@github.com/acme/tools",
                "http://github.com/acme/tools", "https://github.com/acme/tools/tree/main"):
        with pytest.raises(ModulePackageError):
            parse_repo_url(url)


def test_add_refresh_install_disabled_and_provenance(tmp_path, monkeypatch):
    monkeypatch.setattr("src.module_sources.httpx.Client", FakeClient)
    store = ModuleStore(tmp_path)
    sources = ModuleSources(tmp_path, store)
    source = sources.add("https://github.com/acme/tools")
    assert source["commit"] == COMMIT
    assert source["modules"][0]["installed_version"] is None
    refreshed = sources.add("https://github.com/acme/tools/")
    assert refreshed["id"] == source["id"]
    installed = sources.install(source["id"], "focus-timer")
    assert installed["enabled"] is False
    assert installed["source"] == {"id": source["id"], "url": source["url"], "commit": COMMIT}
    repeated = sources.install(source["id"], "focus-timer")
    assert repeated["digest"] == installed["digest"]
    assert repeated["package_key"] == installed["package_key"]
    assert sources.list()[0]["modules"][0]["installed_version"] == "1.2.0"
    archive = io.BytesIO()
    with zipfile.ZipFile(archive, "w") as package:
        package.writestr("module.json", json.dumps(MANIFEST))
        package.writestr("panel.html", "<h1>Other</h1>")
    with pytest.raises(ModulePackageError) as conflict:
        store.install(archive.getvalue())
    assert conflict.value.status_code == 409
    sources.delete(source["id"])
    assert store.get("focus-timer") is not None


def test_catalog_rejects_invalid_manifest_permissions_and_duplicate_module_ids(tmp_path, monkeypatch):
    monkeypatch.setattr("src.module_sources.httpx.Client", FakeClient)
    sources = ModuleSources(tmp_path, ModuleStore(tmp_path))
    manifest_url = f"https://raw.githubusercontent.com/acme/tools/{COMMIT}/modules/focus-timer/module.json"
    invalid = dict(MANIFEST, permissions=["shell"])
    monkeypatch.setitem(FILES, manifest_url, invalid)
    with pytest.raises(ModulePackageError, match="permissions"):
        sources.add("https://github.com/acme/tools")

    monkeypatch.setitem(FILES, manifest_url, MANIFEST)
    index_url = f"https://raw.githubusercontent.com/acme/tools/{COMMIT}/modules/index.json"
    monkeypatch.setitem(FILES, index_url, {"api_version": 1, "modules": [
        {"path": "focus-timer", "files": ["module.json", "panel.html"]},
        {"path": "second-copy", "files": ["module.json", "panel.html"]},
    ]})
    monkeypatch.setitem(FILES, f"https://raw.githubusercontent.com/acme/tools/{COMMIT}/modules/second-copy/module.json", MANIFEST)
    with pytest.raises(ModulePackageError, match="duplicate module ids"):
        sources.add("https://github.com/acme/tools")


def test_foreign_install_is_reported_as_conflict(tmp_path, monkeypatch):
    monkeypatch.setattr("src.module_sources.httpx.Client", FakeClient)
    store = ModuleStore(tmp_path)
    package = io.BytesIO()
    with zipfile.ZipFile(package, "w") as archive:
        archive.writestr("module.json", json.dumps(MANIFEST))
        archive.writestr("panel.html", "<h1>Other</h1>")
    store.install(package.getvalue())
    sources = ModuleSources(tmp_path, store)
    source = sources.add("https://github.com/acme/tools")
    advertised = source["modules"][0]
    assert advertised["conflict"] is True
    assert advertised["installed_version"] is None
    assert advertised["enabled"] is False


def test_raw_file_path_is_quoted_and_expired_deadline_fails_closed(tmp_path, monkeypatch):
    monkeypatch.setattr("src.module_sources.httpx.Client", FakeClient)
    sources = ModuleSources(tmp_path, ModuleStore(tmp_path))
    index_url = f"https://raw.githubusercontent.com/acme/tools/{COMMIT}/modules/index.json"
    monkeypatch.setitem(FILES, index_url, {"api_version": 1, "modules": [
        {"path": "focus-timer", "files": ["module.json", "panel.html", "assets/p?#%.png"]}]})
    raw_asset_url = f"https://raw.githubusercontent.com/acme/tools/{COMMIT}/modules/focus-timer/assets/p%3F%23%25.png"
    monkeypatch.setitem(FILES, raw_asset_url, "image")
    REQUESTED.clear()
    source = sources.add("https://github.com/acme/tools")
    sources.install(source["id"], "focus-timer")
    assert raw_asset_url in REQUESTED

    monkeypatch.setattr(module_sources.time, "monotonic", lambda: 100.0)
    with pytest.raises(ModulePackageError, match="time limit"):
        ModuleSources._request(FakeClient(), "https://raw.githubusercontent.com/x/y/file", 1, deadline=99)
