"""Stopped native image tools must not persist a late provider response."""
import asyncio
import base64
import json
import os
import subprocess
import sys
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


def test_image_persistence_serializes_with_session_delete(tmp_path):
    code = r'''import asyncio, base64, json, os, threading
from pathlib import Path
import httpx
from types import SimpleNamespace
from core.database import Base, engine, SessionLocal, Session as DbSession, GalleryImage
from core.session_manager import SessionManager
import src.ai_interaction as images
import src.settings as settings
import src.tool_execution as execution
from mcp_servers import image_gen_server
from src import agent_runs
from src.tool_execution import NO_TOOL_SECURITY_CONTEXT, execute_tool_block

Base.metadata.create_all(engine)
manager = SessionManager()
image_dir = Path(os.environ["ODYSSEUS_DATA_DIR"]) / "generated_images"
images.GENERATED_IMAGES_DIR = image_dir
images._resolve_model = lambda *_a, **_kw: ("http://fixture/v1/chat/completions", "chatgpt-image-codex", {})
settings.get_setting = lambda _key, default=None: True
image_gen_server._mcp_owner_required = lambda _owner: False
execution.is_public_blocked_tool = lambda _tool: False
entered, release = threading.Event(), threading.Event()
block_dimensions = [True]
def dimensions(_bytes):
    if block_dimensions[0]:
        entered.set()
        if not release.wait(10):
            raise RuntimeError("test release timeout")
    return "10x10"
images._image_dimensions = dimensions
class FakeClient:
    async def __aenter__(self): return self
    async def __aexit__(self, *_args): return None
    async def post(self, *_args, **_kwargs):
        return httpx.Response(200, json={"data": [{"b64_json": base64.b64encode(b"fixture bytes").decode()}]})
httpx.AsyncClient = lambda **_kwargs: FakeClient()

deleted = []
manager.create_session("delete-first", "Race", "unused", "unused", owner="alice")
def delete_while_loop_is_blocked():
    if not entered.wait(5):
        deleted.append(False)
        release.set()
        return
    deleted.append(manager.delete_session("delete-first"))
    release.set()
thread = threading.Thread(target=delete_while_loop_is_blocked)
thread.start()
async def deleted_scope_run():
    async def stream():
        await execute_tool_block(SimpleNamespace(
            tool_type="mcp__image_gen__generate_image",
            content=json.dumps({"prompt": "fixture", "model": "chatgpt-image-codex"}),
        ), session_id="delete-first", owner="alice", security_context=NO_TOOL_SECURITY_CONTEXT)
        yield "data: [DONE]\n\n"
    run = agent_runs.start("delete-first", stream(), owner="alice", persist=False)
    try:
        await asyncio.wait_for(run.task, 5)
    except asyncio.CancelledError:
        pass
asyncio.run(deleted_scope_run())
thread.join(5)
assert deleted == [True]
db = SessionLocal()
assert db.get(DbSession, "delete-first") is None
assert db.query(GalleryImage).filter_by(session_id="delete-first").count() == 0
db.close()
assert not list(image_dir.glob("*"))

# Writer-first ordering remains valid, and deletion then removes both records.
block_dimensions[0] = False
manager.create_session("writer-first", "Race", "unused", "unused", owner="alice")
async def writer_first():
    result = await images.do_generate_image(
        {"prompt": "fixture", "model": "chatgpt-image-codex"},
        session_id="writer-first", owner="alice",
    )
    assert result.get("image_id")
asyncio.run(writer_first())
db = SessionLocal()
image = db.query(GalleryImage).filter_by(session_id="writer-first").one()
image_path = image_dir / image.filename
assert image_path.exists()
db.close()
assert manager.delete_session("writer-first")
db = SessionLocal()
assert db.query(GalleryImage).filter_by(session_id="writer-first").count() == 0
db.close()
assert not image_path.exists()

# An authenticated owner mismatch is rejected before any file is created.
manager.create_session("wrong-owner", "Race", "unused", "unused", owner="bob")
files_before = set(image_dir.glob("*"))
async def wrong_owner():
    result = await images.do_generate_image(
        {"prompt": "fixture", "model": "chatgpt-image-codex"},
        session_id="wrong-owner", owner="alice",
    )
    assert "no longer available" in result["error"]
asyncio.run(wrong_owner())
assert set(image_dir.glob("*")) == files_before
db = SessionLocal()
assert db.query(GalleryImage).filter_by(session_id="wrong-owner").count() == 0
db.close()

# In no-login mode the raw None owner remains the session/Gallery owner; it is
# not rewritten to the reserved local storage owner used by tool archives.
os.environ["AUTH_ENABLED"] = "false"
manager.create_session("local-owner-none", "Local", "unused", "unused", owner=None)
async def local_owner_none():
    result = await images.do_generate_image(
        {"prompt": "fixture", "model": "chatgpt-image-codex"},
        session_id="local-owner-none", owner=None,
    )
    assert result.get("image_id")
asyncio.run(local_owner_none())
db = SessionLocal()
local_image = db.query(GalleryImage).filter_by(session_id="local-owner-none").one()
assert local_image.owner is None
local_path = image_dir / local_image.filename
db.close()
assert manager.delete_session("local-owner-none")
assert not local_path.exists()
'''
    env = os.environ.copy()
    env.update(
        DATABASE_URL=f"sqlite:///{tmp_path / 'app.db'}",
        ODYSSEUS_DATA_DIR=str(tmp_path / "data"),
        AUTH_ENABLED="true",
        PYTHONPATH=os.getcwd(),
        PYTHONDONTWRITEBYTECODE="1",
    )
    result = subprocess.run(
        [sys.executable, "-c", code],
        capture_output=True, text=True, timeout=40, env=env,
    )
    assert result.returncode == 0, result.stderr


def test_failed_gallery_commit_removes_generated_file(monkeypatch, tmp_path):
    import src.database as database
    from src.session_image_cleanup import persist_generated_image

    class GalleryImage:
        def __init__(self, **_kwargs):
            pass

    class Session:
        def add(self, _row):
            pass

        def commit(self):
            raise RuntimeError("fixture commit failure")

        def rollback(self):
            pass

        def close(self):
            pass

    monkeypatch.setattr(database, "GalleryImage", GalleryImage)
    monkeypatch.setattr(database, "SessionLocal", Session)
    with pytest.raises(RuntimeError, match="fixture commit failure"):
        persist_generated_image(
            b"fixture image bytes",
            directory=tmp_path / "generated",
            prompt="fixture",
            model="fixture-model",
            size="1x1",
            quality="low",
            session_id=None,
            owner=None,
        )
    assert list((tmp_path / "generated").glob("*")) == []
