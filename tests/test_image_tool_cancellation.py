"""Stopped native image tools must not persist a late provider response."""
import asyncio
import base64
import json
from types import SimpleNamespace

import httpx
import pytest


@pytest.mark.asyncio
async def test_stopping_native_image_tool_cancels_provider_and_prevents_gallery_write(
    monkeypatch, tmp_path,
):
    import src.ai_interaction as images
    import src.database as database
    import src.settings as settings
    import src.tool_execution as execution
    from mcp_servers import image_gen_server
    from src import agent_runs
    from src.tool_execution import NO_TOOL_SECURITY_CONTEXT, execute_tool_block

    provider_started = asyncio.Event()
    provider_cancelled = asyncio.Event()
    release_provider = asyncio.Event()
    gallery_rows = []
    monkeypatch.setattr(images, "GENERATED_IMAGES_DIR", tmp_path / "generated")
    monkeypatch.setattr(images, "_resolve_model", lambda *_a, **_kw: (
        "http://fixture/v1/chat/completions", "chatgpt-image-codex", {},
    ))
    monkeypatch.setattr(settings, "get_setting", lambda _key, default=None: True)
    monkeypatch.setattr(image_gen_server, "_mcp_owner_required", lambda _owner: False)
    monkeypatch.setattr(execution, "is_public_blocked_tool", lambda _tool: False)

    class GalleryImage:
        def __init__(self, **kwargs):
            gallery_rows.append(kwargs)

    class GallerySession:
        def add(self, row): pass
        def commit(self): pass
        def close(self): pass

    monkeypatch.setattr(database, "SessionLocal", GallerySession)
    monkeypatch.setattr(database, "GalleryImage", GalleryImage)

    class DelayedClient:
        async def __aenter__(self): return self
        async def __aexit__(self, *_args): return None

        async def post(self, *_args, **_kwargs):
            provider_started.set()
            try:
                await release_provider.wait()
            except asyncio.CancelledError:
                provider_cancelled.set()
                raise
            png = base64.b64encode(b"fixture png").decode()
            return httpx.Response(200, json={"data": [{"b64_json": png}]})

    monkeypatch.setattr(httpx, "AsyncClient", lambda **_kwargs: DelayedClient())

    async def stream():
        tool_task = asyncio.create_task(execute_tool_block(
            SimpleNamespace(
                tool_type="mcp__image_gen__generate_image",
                content=json.dumps({"prompt": "fixture", "model": "chatgpt-image-codex"}),
            ),
            session_id="fixture-image-stop",
            owner="alice",
            security_context=NO_TOOL_SECURITY_CONTEXT,
        ))
        try:
            await tool_task
            yield "data: [DONE]\n\n"
        finally:
            if not tool_task.done():
                tool_task.cancel()
                try:
                    await tool_task
                except asyncio.CancelledError:
                    pass

    run = agent_runs.start("fixture-image-stop", stream(), owner="alice", persist=False)
    await asyncio.wait_for(provider_started.wait(), timeout=2)
    assert agent_runs.stop("fixture-image-stop", run.run_id)
    await asyncio.wait_for(run.task, timeout=2)
    # A provider reply released after cleanup must have no path to app storage.
    release_provider.set()

    assert provider_cancelled.is_set()
    assert not list((tmp_path / "generated").glob("*"))
    assert gallery_rows == []
