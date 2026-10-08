"""Image dimensions come from saved artifacts rather than request sizes."""
import base64
from io import BytesIO
import httpx
import pytest
from PIL import Image


def _png(width=1254, height=1254):
    buffer = BytesIO()
    Image.new("RGB", (width, height), "white").save(buffer, format="PNG")
    return buffer.getvalue()


def _gallery(monkeypatch, rows):
    import src.database as database

    class GalleryImage:
        def __init__(self, **kwargs):
            rows.append(kwargs)

    class Session:
        def add(self, _row): pass
        def commit(self): pass
        def close(self): pass

    monkeypatch.setattr(database, "SessionLocal", Session)
    monkeypatch.setattr(database, "GalleryImage", GalleryImage)


@pytest.mark.asyncio
async def test_generation_uses_saved_png_dimensions(monkeypatch, tmp_path):
    from src import ai_interaction as images
    import src.settings as settings

    rows = []
    _gallery(monkeypatch, rows)
    monkeypatch.setattr(images, "GENERATED_IMAGES_DIR", tmp_path)
    monkeypatch.setattr(settings, "load_settings", lambda: {})
    monkeypatch.setattr(images, "_resolve_model", lambda *a, **k: (
        "http://fixture/v1/chat/completions", "chatgpt-image-codex", {}))
    payload = _png()

    class Client:
        def __init__(self, **_kwargs): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *_args): pass
        async def post(self, *_args, **_kwargs):
            return httpx.Response(200, json={"data": [{
                "b64_json": base64.b64encode(payload).decode(),
                "size": "1024x1024",  # untrusted provider metadata
            }]})

    monkeypatch.setattr(httpx, "AsyncClient", Client)
    result = await images.do_generate_image("fixture\nchatgpt-image-codex\n1024x1024")

    assert result["image_size"] == "1254x1254"
    assert rows[0]["size"] == "1254x1254"
    assert Image.open(tmp_path / result["image_url"].rsplit("/", 1)[-1]).size == (1254, 1254)


@pytest.mark.asyncio
async def test_edit_uses_saved_png_dimensions(monkeypatch, tmp_path):
    from src import ai_interaction as images
    import src.settings as settings

    rows = []
    _gallery(monkeypatch, rows)
    monkeypatch.setattr(images, "GENERATED_IMAGES_DIR", tmp_path / "out")
    monkeypatch.setattr(settings, "load_settings", lambda: {})
    monkeypatch.setattr(images, "_resolve_model", lambda *a, **k: (
        "http://fixture/v1/chat/completions", "chatgpt-image-codex", {}))
    source = tmp_path / "source.png"
    source.write_bytes(_png(64, 64))
    payload = _png()

    class Client:
        def __init__(self, **_kwargs): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *_args): pass
        async def post(self, *_args, **_kwargs):
            return httpx.Response(200, json={"data": [{
                "b64_json": base64.b64encode(payload).decode(),
                "size": "1024x1024",
            }]})

    monkeypatch.setattr(httpx, "AsyncClient", Client)
    result = await images.do_edit_image("fixture edit", str(source), "chatgpt-image-codex")

    assert result["image_size"] == "1254x1254"
    assert rows[0]["size"] == "1254x1254"


@pytest.mark.asyncio
async def test_edit_transport_errors_with_empty_detail_remain_actionable(monkeypatch, tmp_path):
    from src import ai_interaction as images
    import src.settings as settings

    monkeypatch.setattr(settings, "load_settings", lambda: {})
    monkeypatch.setattr(images, "_resolve_model", lambda *a, **k: (
        "http://fixture/v1/chat/completions", "chatgpt-image-codex", {}))
    source = tmp_path / "source.png"
    source.write_bytes(_png(64, 64))

    class Client:
        def __init__(self, **_kwargs): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *_args): pass
        async def post(self, *_args, **_kwargs):
            raise httpx.ReadError("")

    monkeypatch.setattr(httpx, "AsyncClient", Client)
    result = await images.do_edit_image("fixture edit", str(source), "chatgpt-image-codex")

    assert result["error"] == "Image edit error: ReadError with no provider error details"


@pytest.mark.asyncio
async def test_mcp_generation_uses_saved_png_dimensions(monkeypatch, tmp_path):
    from mcp_servers import image_gen_server
    from src import ai_interaction as images
    import src.settings as settings

    rows = []
    _gallery(monkeypatch, rows)
    monkeypatch.setattr(image_gen_server, "GENERATED_IMAGES_DIR", tmp_path)
    monkeypatch.setattr(image_gen_server, "_mcp_owner_required", lambda _owner: False)
    monkeypatch.setattr(images, "_resolve_model", lambda *a, **k: (
        "http://fixture/v1/chat/completions", "chatgpt-image-codex", {}))
    monkeypatch.setattr(settings, "load_settings", lambda: {})
    monkeypatch.setattr(settings, "get_setting", lambda _k, default=None: default)
    payload = _png()

    class Client:
        def __init__(self, **_kwargs): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *_args): pass
        async def post(self, *_args, **_kwargs):
            return httpx.Response(200, json={"data": [{
                "b64_json": base64.b64encode(payload).decode(),
                "size": "1024x1024",
            }]})

    monkeypatch.setattr(httpx, "AsyncClient", Client)
    result = await image_gen_server.call_tool("generate_image", {
        "prompt": "fixture", "model": "chatgpt-image-codex", "size": "1024x1024",
    })

    assert "size: 1254x1254" in result[0].text
    assert rows[0]["size"] == "1254x1254"
