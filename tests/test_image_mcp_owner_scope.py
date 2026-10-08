"""Owner scoping for image MCP dispatch; all provider responses are fixtures."""
import asyncio
import base64
import json
from types import SimpleNamespace

import httpx
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker


@pytest.mark.parametrize("tool", [
    "generate_image",
    "mcp__image_gen__generate_image",
])
@pytest.mark.parametrize("owner,trusted_owner", [("alice", "alice"), (None, "")])
@pytest.mark.asyncio
async def test_tool_dispatch_overwrites_model_supplied_image_owner(monkeypatch, tool, owner, trusted_owner):
    import src.tool_execution as execution
    import src.ai_interaction as images
    import src.settings as settings
    from mcp_servers import image_gen_server
    from src.tool_execution import NO_TOOL_SECURITY_CONTEXT, execute_tool_block

    calls = []
    async def generate(args, *, session_id=None, owner=None):
        calls.append((args, session_id, owner))
        return {"results": "fixture result"}

    monkeypatch.setattr(images, "do_generate_image", generate)
    monkeypatch.setattr(settings, "get_setting", lambda _key, default=None: True)
    monkeypatch.setattr(image_gen_server, "_mcp_owner_required", lambda _owner: False)
    monkeypatch.setattr(execution, "_owner_is_admin", lambda _owner: True)
    block = SimpleNamespace(
        tool_type=tool,
        content=json.dumps({"prompt": "fixture", "_odysseus_owner": "bob"}),
    )

    await execute_tool_block(
        block, session_id="fixture-session", owner=owner,
        security_context=NO_TOOL_SECURITY_CONTEXT,
    )

    assert calls == [({"prompt": "fixture"}, "fixture-session", trusted_owner or None)]


def test_ownerless_mcp_fails_closed_for_private_endpoints_but_allows_single_user(monkeypatch):
    import src.database as database
    import src.auth_helpers as auth_helpers
    from core.database import Base, ModelEndpoint
    from mcp_servers import image_gen_server

    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine)
    with factory() as db:
        db.add(ModelEndpoint(
            id="private-image", name="Bob image", base_url="http://example.test/v1",
            model_type="image", is_enabled=True, owner="bob",
        ))
        db.add(ModelEndpoint(
            id="private-mixed", name="Bob mixed", base_url="http://mixed.test/v1",
            model_type="llm", is_enabled=True, owner="bob",
        ))
        db.commit()
    monkeypatch.setattr(database, "SessionLocal", factory)
    monkeypatch.setattr(auth_helpers, "_auth_disabled", lambda: False)

    assert image_gen_server._mcp_owner_required(None) is True
    assert image_gen_server._mcp_owner_required("alice") is False

    monkeypatch.setattr(auth_helpers, "_auth_disabled", lambda: True)
    assert image_gen_server._mcp_owner_required(None) is False
    engine.dispose()


@pytest.mark.asyncio
async def test_untrusted_owner_cannot_authorize_ownerless_tool_call(monkeypatch):
    import src.database as database
    import src.auth_helpers as auth_helpers
    import src.tool_execution as execution
    import src.ai_interaction as images
    from core.database import Base, ModelEndpoint
    from mcp_servers import image_gen_server
    from src.tool_execution import NO_TOOL_SECURITY_CONTEXT, execute_tool_block

    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine)
    with factory() as db:
        db.add(ModelEndpoint(
            id="private-image", name="Alice image", base_url="http://example.test/v1",
            model_type="image", is_enabled=True, owner="alice",
        ))
        db.commit()
    monkeypatch.setattr(database, "SessionLocal", factory)
    monkeypatch.setattr(auth_helpers, "_auth_disabled", lambda: False)
    monkeypatch.setattr(execution, "_owner_is_admin", lambda _owner: True)
    monkeypatch.setattr(images, "_resolve_model", lambda *_args, **_kwargs: pytest.fail("provider was selected"))
    monkeypatch.setattr(images, "_auto_detect_image_model", lambda **_kwargs: pytest.fail("catalog was queried"))

    class FakeMcp:
        async def call_tool(self, _name, args):
            content = await image_gen_server.call_tool("generate_image", args)
            return {"stdout": content[0].text, "exit_code": 0}

    monkeypatch.setattr(execution, "get_mcp_manager", lambda: FakeMcp())
    desc, result = await execute_tool_block(
        SimpleNamespace(
            tool_type="mcp__image_gen__generate_image",
            content=json.dumps({"prompt": "fixture", "_odysseus_owner": "alice"}),
        ),
        owner=None,
        security_context=NO_TOOL_SECURITY_CONTEXT,
    )

    assert desc.startswith("mcp: mcp__image_gen__")
    assert result["exit_code"] == 1
    assert "requires an authenticated owner" in result["error"]
    engine.dispose()


@pytest.mark.asyncio
async def test_qualified_image_mcp_marks_text_error_as_failure(monkeypatch):
    import src.tool_execution as execution
    import src.ai_interaction as images
    import src.settings as settings
    from mcp_servers import image_gen_server
    from src.tool_execution import NO_TOOL_SECURITY_CONTEXT, execute_tool_block

    async def generate(*_args, **_kwargs):
        return {"error": "Image generation failed (422): fixture rejection"}
    monkeypatch.setattr(images, "do_generate_image", generate)
    monkeypatch.setattr(settings, "get_setting", lambda _key, default=None: True)
    monkeypatch.setattr(image_gen_server, "_mcp_owner_required", lambda _owner: False)
    monkeypatch.setattr(execution, "_owner_is_admin", lambda _owner: True)
    _, result = await execute_tool_block(
        SimpleNamespace(tool_type="mcp__image_gen__generate_image", content='{"prompt":"fixture"}'),
        owner="alice",
        security_context=NO_TOOL_SECURITY_CONTEXT,
    )

    assert result["exit_code"] == 1
    assert result["untrusted_content"] is True
    assert "fixture rejection" in result["error"]


@pytest.mark.asyncio
async def test_qualified_image_mcp_promotes_result_fields(monkeypatch):
    import src.tool_execution as execution
    import src.ai_interaction as images
    import src.settings as settings
    from mcp_servers import image_gen_server
    from src.tool_execution import NO_TOOL_SECURITY_CONTEXT, execute_tool_block

    async def generate(*_args, **_kwargs):
        return {
            "results": "Generated image for: fixture prompt",
            "image_url": "/api/generated-image/fixture.png",
            "image_prompt": "fixture prompt", "image_model": "chatgpt-image-codex",
            "image_size": "1024x1024",
        }
    monkeypatch.setattr(images, "do_generate_image", generate)
    monkeypatch.setattr(settings, "get_setting", lambda _key, default=None: True)
    monkeypatch.setattr(image_gen_server, "_mcp_owner_required", lambda _owner: False)
    monkeypatch.setattr(execution, "_owner_is_admin", lambda _owner: True)
    _, result = await execute_tool_block(
        SimpleNamespace(tool_type="mcp__image_gen__generate_image", content='{"prompt":"fixture"}'),
        owner="alice",
        security_context=NO_TOOL_SECURITY_CONTEXT,
    )

    assert result["image_url"] == "/api/generated-image/fixture.png"
    assert result["image_prompt"] == "fixture prompt"
    assert result["image_model"] == "chatgpt-image-codex"
    assert result["image_size"] == "1024x1024"


@pytest.mark.asyncio
async def test_in_process_image_tool_preserves_admin_disable(monkeypatch):
    import src.ai_interaction as images
    import src.settings as settings
    import src.tool_execution as execution
    from mcp_servers import image_gen_server
    from src.tool_execution import NO_TOOL_SECURITY_CONTEXT, execute_tool_block

    async def should_not_generate(*_args, **_kwargs):
        pytest.fail("disabled image generation reached provider")

    monkeypatch.setattr(images, "do_generate_image", should_not_generate)
    monkeypatch.setattr(settings, "get_setting", lambda _key, default=None: False)
    monkeypatch.setattr(image_gen_server, "_mcp_owner_required", lambda _owner: False)
    monkeypatch.setattr(execution, "_owner_is_admin", lambda _owner: True)
    _, result = await execute_tool_block(
        SimpleNamespace(tool_type="mcp__image_gen__generate_image", content='{"prompt":"fixture"}'),
        owner="alice",
        security_context=NO_TOOL_SECURITY_CONTEXT,
    )

    assert result["exit_code"] == 1
    assert result["error"] == "Image generation is disabled by the administrator."


@pytest.mark.asyncio
async def test_image_mcp_scopes_discovery_resolution_and_gallery_record(monkeypatch, tmp_path):
    from mcp_servers import image_gen_server
    import src.ai_interaction as images
    import src.database as database
    import src.settings as settings

    owners = []
    resolutions = []
    gallery = []
    monkeypatch.setattr(image_gen_server, "_mcp_owner_required", lambda owner: False)

    async def autodetect(*, owner=None):
        owners.append(owner)
        return "chatgpt-image-codex@Alice bridge"

    def resolve(model, *, owner=None, model_type=None):
        resolutions.append((model, owner, model_type))
        return ("http://bridge/v1/chat/completions", "chatgpt-image-codex", {"Authorization": "Bearer fixture"})

    monkeypatch.setattr(images, "_auto_detect_image_model", autodetect)
    monkeypatch.setattr(images, "_resolve_model", resolve)
    monkeypatch.setattr(settings, "load_settings", lambda: {})
    monkeypatch.setattr(settings, "get_setting", lambda key, default=None: default if key != "image_gen_enabled" else True)
    monkeypatch.setattr(image_gen_server, "GENERATED_IMAGES_DIR", tmp_path)

    class FakeGalleryImage:
        def __init__(self, **kwargs):
            self.kwargs = kwargs
            gallery.append(kwargs)

    class FakeDb:
        def add(self, row):
            pass

        def commit(self):
            pass

        def close(self):
            pass

    monkeypatch.setattr(database, "SessionLocal", FakeDb)
    monkeypatch.setattr(database, "GalleryImage", FakeGalleryImage)

    class FakeClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def post(self, _url, *, json, headers):
            assert json["model"] == "chatgpt-image-codex"
            assert headers["Authorization"] == "Bearer fixture"
            encoded = base64.b64encode(b"fixture image bytes").decode("ascii")
            return httpx.Response(200, json={"data": [{"b64_json": encoded}]})

    monkeypatch.setattr(httpx, "AsyncClient", lambda **_kwargs: FakeClient())
    result = await image_gen_server.call_tool("generate_image", {
        "prompt": "fixture only", "_odysseus_owner": "alice",
    })

    assert owners == ["alice"]
    assert resolutions == [("chatgpt-image-codex@Alice bridge", "alice", "image")]
    assert len(gallery) == 1 and gallery[0]["owner"] == "alice"
    assert "fixture" in result[0].text
    assert "alice" not in result[0].text
