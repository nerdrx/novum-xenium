"""Authenticated, owner-scoped image discovery without generating images."""
import httpx
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from src import ai_interaction as images
from src.database import Base, ModelEndpoint


@pytest.mark.parametrize("empty_catalog", [False, True])
async def test_auto_detect_uses_bridge_auth_and_endpoint_name(monkeypatch, empty_catalog):
    import src.database as database
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine)
    with factory() as db:
        for name, owner in (("Other bridge", "bob"), ("My bridge", "alice")):
            db.add(ModelEndpoint(id=name, name=name, owner=owner,
                                 base_url="http://127.0.0.1:8111/v1", model_type="image",
                                 is_enabled=True))
        db.commit()
    monkeypatch.setattr(database, "SessionLocal", factory)

    def missing_cloud(*args, **kwargs):
        raise ValueError("No cloud image API configured")
    monkeypatch.setattr(images, "_resolve_model", missing_cloud)
    calls = []
    def runtime(endpoint, owner=None):
        assert endpoint.owner == owner == "alice"
        return endpoint.base_url, "test-bridge-token"
    monkeypatch.setattr(images, "resolve_endpoint_runtime", runtime)
    monkeypatch.setattr(images, "build_headers", lambda key, base: {"Authorization": "Bearer " + key})
    monkeypatch.setattr(images, "build_models_url", lambda base: base + "/models")

    def catalog(url, *, headers, timeout):
        calls.append((url, headers, timeout))
        data = [] if empty_catalog else [{"id": "chatgpt-image-codex"}]
        return httpx.Response(200, json={"data": data}, request=httpx.Request("GET", url))
    monkeypatch.setattr(httpx, "get", catalog)
    assert await images._auto_detect_image_model("alice") == (
        "" if empty_catalog else "chatgpt-image-codex@My bridge")
    assert calls == [("http://127.0.0.1:8111/v1/models",
                      {"Authorization": "Bearer test-bridge-token"}, 3)]
    engine.dispose()


async def test_mcp_auto_detect_forwards_bridge_auth_and_quality(monkeypatch):
    from mcp_servers import image_gen_server
    import src.settings as settings
    async def discover(owner=None):
        return "chatgpt-image-codex@My bridge"
    monkeypatch.setattr(images, "_auto_detect_image_model", discover)
    monkeypatch.setattr(images, "_resolve_model", lambda *a, **k: (
        "http://127.0.0.1:8111/v1/chat/completions", "chatgpt-image-codex",
        {"Authorization": "Bearer test-token"}))
    monkeypatch.setattr(settings, "load_settings", lambda: {})
    monkeypatch.setattr(settings, "get_setting", lambda key, default=None: default)
    calls = []
    class Client:
        def __init__(self, **kwargs): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
        async def post(self, url, *, json, headers):
            calls.append((url, json, headers))
            return httpx.Response(400, json={"error": {"message": "Fixture rejection"}})
    monkeypatch.setattr(httpx, "AsyncClient", Client)
    result = await image_gen_server.call_tool("generate_image", {"prompt": "a cat", "quality": "high"})
    assert "Fixture rejection" in result[0].text
    assert calls == [("http://127.0.0.1:8111/v1/images/generations",
                      {"model": "chatgpt-image-codex", "prompt": "a cat", "n": 1,
                       "size": "1024x1024", "quality": "high"},
                      {"Authorization": "Bearer test-token"})]
