"""Workspace module package validation, admin controls, and panel isolation."""

import io
import json
import stat
import zipfile

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from core.database import Base, McpServer
from core.middleware import SecurityHeadersMiddleware
from routes import module_routes
from src.module_store import MAX_EXPANDED_BYTES, ModulePackageError, ModuleStore


def package(version="1.0.0", *, panel="<h1>Hello</h1>", extras=None, mcp=None, refs=None, permissions=None):
    manifest = {
        "api_version": 1,
        "id": "sample-module",
        "name": "Sample module",
        "version": version,
        "description": "Fixture module",
        "panel": "panel.html" if panel is not None else None,
        "mcp_server_ids": refs or [],
    }
    if mcp is not None:
        manifest["mcp"] = mcp
    if permissions is not None:
        manifest["permissions"] = permissions
    if panel is None:
        manifest["panel"] = None
    return zip_package(manifest, ({"panel.html": panel.encode()} if panel is not None else {}) | (extras or {}))


def zip_package(manifest, files=None):
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("module.json", json.dumps(manifest))
        for name, content in (files or {}).items():
            archive.writestr(name, content)
    return output.getvalue()


class FakeAuth:
    is_configured = True

    @staticmethod
    def is_admin(user):
        return user == "admin"


@pytest.fixture
def module_db(monkeypatch):
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine)
    monkeypatch.setattr(module_routes, "SessionLocal", factory)
    yield factory
    engine.dispose()


@pytest.fixture
def client(tmp_path, monkeypatch, module_db):
    monkeypatch.setenv("AUTH_ENABLED", "true")
    monkeypatch.setenv("LOCALHOST_BYPASS", "false")
    app = FastAPI()
    app.state.auth_manager = FakeAuth()

    @app.middleware("http")
    async def test_identity(request, call_next):
        user = request.headers.get("x-test-user")
        if user:
            request.state.current_user = user
        return await call_next(request)

    app.include_router(module_routes.setup_module_routes(data_dir=tmp_path))
    app.add_middleware(SecurityHeadersMiddleware)
    return TestClient(app)


def admin(client):
    return {"x-test-user": "admin"}


def test_install_enable_panel_and_asset_are_authenticated_and_sandboxed(client, tmp_path):
    uploaded = client.post("/api/modules/install", headers=admin(client), files={
        "file": ("sample.zip", package(panel='<h1>Panel</h1><script>window.ready=true</script>',
                                       extras={"assets/logo.png": b"png-bytes"}), "application/zip")
    })
    assert uploaded.status_code == 200
    module = uploaded.json()["module"]
    assert module["enabled"] is False
    assert module["panel_url"] is None
    assert uploaded.json()["updated"] is True
    assert client.get("/api/modules").status_code == 401
    assert client.get("/api/modules", headers={"x-test-user": "reader"}).json() == {
        "modules": [module], "is_admin": False,
    }
    assert client.get("/api/modules/sample-module/panel", headers={"x-test-user": "reader"}).status_code == 404
    assert client.post("/api/modules/sample-module/enabled", headers={"x-test-user": "reader"},
                       json={"enabled": True}).status_code == 403

    enabled = client.post("/api/modules/sample-module/enabled", headers=admin(client), json={"enabled": True})
    assert enabled.status_code == 200
    assert enabled.json()["module"]["panel_url"] == "/api/modules/sample-module/panel"
    panel_response = client.get("/api/modules/sample-module/panel", headers={"x-test-user": "reader"})
    assert panel_response.status_code == 200
    assert "Panel</h1>" in panel_response.text
    assert "sandbox allow-scripts" in panel_response.headers["content-security-policy"]
    assert "connect-src 'none'" in panel_response.headers["content-security-policy"]
    assert "form-action 'none'" in panel_response.headers["content-security-policy"]
    assert panel_response.headers.get("x-frame-options") is None
    asset = client.get("/api/modules/sample-module/assets/logo.png", headers={"x-test-user": "reader"})
    assert asset.status_code == 200
    assert asset.headers["content-type"] == "image/png"
    assert asset.content == b"png-bytes"
    with pytest.raises(ModulePackageError, match="Invalid package path"):
        ModuleStore(tmp_path).read_asset("sample-module", "assets/../../state.json")


def test_updates_disable_and_rollback_restores_previous_enabled_release(client):
    first = client.post("/api/modules/install", headers=admin(client), files={"file": ("v1.zip", package(permissions=["models"]), "application/zip")})
    assert first.status_code == 200
    assert first.json()["module"]["permissions"] == ["models"]
    client.post("/api/modules/sample-module/enabled", headers=admin(client), json={"enabled": True})

    second = client.post("/api/modules/install", headers=admin(client), files={
        "file": ("v2.zip", package("2.0.0", panel="<h1>Updated</h1>", permissions=["images"]), "application/zip")
    })
    assert second.status_code == 200
    assert second.json()["updated"] is True
    assert second.json()["module"]["enabled"] is False
    assert second.json()["module"]["previous_version"] == "1.0.0"
    assert client.get("/api/modules/sample-module/panel", headers={"x-test-user": "reader"}).status_code == 404

    rolled_back = client.post("/api/modules/sample-module/rollback", headers=admin(client))
    assert rolled_back.status_code == 200
    assert rolled_back.json()["module"]["version"] == "1.0.0"
    assert rolled_back.json()["module"]["enabled"] is False
    assert rolled_back.json()["module"]["permissions"] == ["models"]
    assert client.get("/api/modules/sample-module/panel", headers={"x-test-user": "reader"}).status_code == 404
    enabled = client.post("/api/modules/sample-module/enabled", headers=admin(client), json={"enabled": True})
    assert enabled.json()["module"]["enabled"] is True
    assert "Hello" in client.get("/api/modules/sample-module/panel", headers={"x-test-user": "reader"}).text


def test_install_never_connects_mcp_and_reports_matching_existing_server(client, module_db):
    package_data = package(mcp={"name": "Example tools", "transport": "http", "url": "https://tools.example/mcp"})
    with module_db() as db:
        db.add(McpServer(id="mcp123", name="Existing tools", transport="http", url="https://tools.example/mcp", is_enabled=True))
        db.commit()
    response = client.post("/api/modules/install", headers=admin(client), files={"file": ("tools.zip", package_data, "application/zip")})
    assert response.status_code == 200
    assert response.json()["module"]["mcp"] == {"name": "Example tools", "transport": "http", "url": "https://tools.example/mcp"}
    assert response.json()["module"]["mcp_servers"] == [{
        "id": "mcp123", "name": "Existing tools", "configured": True, "enabled": True,
        "status": "configured", "manifest_match": True,
    }]
    with pytest.raises(ModulePackageError, match="without credentials"):
        ModuleStore("/tmp/module-validation").install(package(mcp={
            "name": "Unsafe", "transport": "sse", "url": "https://user:pass@tools.example/mcp?token=secret"
        }))


@pytest.mark.parametrize("entry", ["../escape.txt", "/absolute.txt", "a\\b.txt", "a/./b.txt"])
def test_rejects_unsafe_paths_without_writing_outside_store(tmp_path, entry):
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as archive:
        archive.writestr("module.json", json.dumps({"api_version": 1, "id": "sample-module", "name": "x", "version": "1.0.0"}))
        archive.writestr(entry, "bad")
    with pytest.raises(ModulePackageError, match="Invalid package path"):
        ModuleStore(tmp_path).install(output.getvalue())
    assert not (tmp_path / "escape.txt").exists()


def test_rejects_symlinks_scripts_and_non_inert_assets(tmp_path):
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as archive:
        archive.writestr("module.json", json.dumps({"api_version": 1, "id": "sample-module", "name": "x", "version": "1.0.0"}))
        link = zipfile.ZipInfo("assets/link.png")
        link.create_system = 3
        link.external_attr = (stat.S_IFLNK | 0o777) << 16
        archive.writestr(link, "target")
    with pytest.raises(ModulePackageError, match="non-regular"):
        ModuleStore(tmp_path).install(output.getvalue())
    with pytest.raises(ModulePackageError, match="remote scripts"):
        ModuleStore(tmp_path).install(package(panel='<script src="https://example.test/x.js"></script>'))
    with pytest.raises(ModulePackageError, match="inert image"):
        ModuleStore(tmp_path).install(package(extras={"assets/run.js": "alert(1)"}))


def test_rejects_expansion_bombs_and_immutable_version_replacement(tmp_path):
    store = ModuleStore(tmp_path)
    first = package()
    store.install(first)
    with pytest.raises(ModulePackageError) as conflict:
        store.install(package(panel="<h1>Changed</h1>"))
    assert conflict.value.status_code == 409
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("module.json", json.dumps({"api_version": 1, "id": "sample-module", "name": "x", "version": "2.0.0"}))
        archive.writestr("assets/payload.png", b"0" * (MAX_EXPANDED_BYTES + 1))
    with pytest.raises(ModulePackageError) as too_large:
        store.install(output.getvalue())
    assert too_large.value.status_code == 413


@pytest.mark.parametrize("url", ["https://[bad", "https://tools.example:99999/mcp", "https://tools.example /mcp"])
def test_rejects_malformed_mcp_urls(tmp_path, url):
    with pytest.raises(ModulePackageError):
        ModuleStore(tmp_path).install(package(mcp={"name": "Bad", "transport": "sse", "url": url}))


def test_rejects_boolean_api_version_empty_package_and_preserves_bad_state(tmp_path):
    store = ModuleStore(tmp_path)
    with pytest.raises(ModulePackageError, match="Unsupported module API version"):
        store.install(zip_package({"api_version": True, "id": "sample-module", "name": "x", "version": "1.0.0", "panel": "panel.html"}, {"panel.html": b"hi"}))
    with pytest.raises(ModulePackageError, match="must declare"):
        store.install(zip_package({"api_version": 1, "id": "sample-module", "name": "x", "version": "1.0.0"}))
    store.state_path.parent.mkdir(parents=True, exist_ok=True)
    store.state_path.write_text("{broken", encoding="utf-8")
    with pytest.raises(RuntimeError, match="refusing to overwrite"):
        store.install(package())
    assert store.state_path.read_text(encoding="utf-8") == "{broken"


@pytest.mark.parametrize("permissions", [["unknown"], ["runs", "runs"], "models", [1]])
def test_rejects_invalid_module_permissions(tmp_path, permissions):
    with pytest.raises(ModulePackageError, match="permissions"):
        ModuleStore(tmp_path).install(package(permissions=permissions))


def test_delete_is_admin_only_and_removes_module_from_listing(client):
    client.post("/api/modules/install", headers=admin(client), files={"file": ("v1.zip", package(), "application/zip")})
    assert client.delete("/api/modules/sample-module", headers={"x-test-user": "reader"}).status_code == 403
    assert client.delete("/api/modules/sample-module", headers=admin(client)).json() == {"ok": True}
    assert client.get("/api/modules", headers={"x-test-user": "reader"}).json()["modules"] == []


def test_module_source_routes_validate_admin_and_preserve_installs(client):
    assert client.get("/api/modules/sources").status_code == 401
    assert client.get("/api/modules/sources", headers={"x-test-user": "reader"}).json() == {"sources": []}
    assert client.post("/api/modules/sources", headers={"x-test-user": "reader"},
                       json={"url": "https://github.com/acme/tools"}).status_code == 403
    assert client.post("/api/modules/sources", headers=admin(client),
                       json={"url": "https://github.com.evil/acme/tools"}).status_code == 400
    assert client.delete("/api/modules/sources/missing", headers=admin(client)).status_code == 404
    assert client.post("/api/modules/sources/missing/install", headers=admin(client),
                       json={"module_id": "focus-timer"}).status_code == 404


def test_module_data_routes_require_enabled_grant_and_admin_for_git(client):
    uploaded = client.post("/api/modules/install", headers=admin(client), files={
        "file": ("data.zip", package(permissions=["git"]), "application/zip")
    })
    assert uploaded.status_code == 200
    assert client.get("/api/modules/sample-module/data/git", headers={"x-test-user": "reader"}).status_code == 404
    client.post("/api/modules/sample-module/enabled", headers=admin(client), json={"enabled": True})
    assert client.get("/api/modules/sample-module/data/research", headers={"x-test-user": "reader"}).status_code == 403
    assert client.get("/api/modules/sample-module/data/git", headers={"x-test-user": "reader"}).status_code == 403
