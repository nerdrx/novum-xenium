"""Gallery rotation stays off-loop and cannot recreate deleted images."""

from __future__ import annotations

import asyncio
import hashlib
import io
import json
import threading
from datetime import datetime, timedelta
from types import SimpleNamespace

import pytest
from fastapi import HTTPException, Request
from PIL import Image
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from core.database import Base, ChatMessage, GalleryImage, Session
import routes.gallery_routes as gallery_routes


def _endpoints():
    routes = gallery_routes.setup_gallery_routes().routes
    rotate = next(
        route.endpoint for route in routes
        if getattr(route, "path", "") == "/api/gallery/{image_id}/rotate"
    )
    delete = next(
        route.endpoint for route in routes
        if getattr(route, "path", "") == "/api/gallery/{image_id}"
        and "DELETE" in getattr(route, "methods", set())
    )
    replace = next(
        route.endpoint for route in routes
        if getattr(route, "path", "") == "/api/gallery/{image_id}/replace"
    )
    return rotate, delete, replace


def _request(body=None):
    content = json.dumps(body or {}).encode()
    sent = False

    async def receive():
        nonlocal sent
        if not sent:
            sent = True
            return {"type": "http.request", "body": content, "more_body": False}
        return {"type": "http.disconnect"}

    return Request(
        {"type": "http", "method": "POST", "path": "/", "headers": [(b"content-type", b"application/json")]},
        receive,
    )


def _form_request():
    class FormRequest:
        async def form(self):
            return {"image": SimpleNamespace(filename="replacement.png", read=lambda: None)}

    return FormRequest()


def _seed(tmp_path, monkeypatch, *, owner="alice"):
    engine = create_engine(
        f"sqlite:///{tmp_path / 'gallery.db'}", connect_args={"check_same_thread": False}
    )
    Base.metadata.create_all(bind=engine)
    db_factory = sessionmaker(bind=engine)
    image_dir = tmp_path / "generated"
    image_dir.mkdir()
    # Asymmetric color regions ensure a 90-degree rotation changes the bytes.
    image = Image.new("RGB", (40, 20), "blue")
    for x in range(20):
        for y in range(20):
            image.putpixel((x, y), (255, 0, 0))
    image.save(image_dir / "x.png")
    content = (image_dir / "x.png").read_bytes()
    db = db_factory()
    db.add(GalleryImage(
        id="img-1", filename="x.png", owner=owner, is_active=True,
        file_hash=hashlib.sha256(content).hexdigest(), file_size=len(content), width=40, height=20,
    ))
    db.commit()
    db.close()
    monkeypatch.setattr(gallery_routes, "SessionLocal", db_factory)
    monkeypatch.setattr(gallery_routes, "GALLERY_IMAGE_DIR", image_dir)
    monkeypatch.setattr(gallery_routes, "get_current_user", lambda _request: owner)
    return db_factory, image_dir, content


async def _wait_thread_event(event: threading.Event):
    await asyncio.wait_for(asyncio.to_thread(event.wait), timeout=3)


def test_rotation_keeps_event_loop_responsive_and_updates_file_metadata(tmp_path, monkeypatch):
    db_factory, image_dir, _original = _seed(tmp_path, monkeypatch)
    rotate, _delete, _replace = _endpoints()
    entered = threading.Event()
    release = threading.Event()
    original_rotate = Image.Image.rotate

    def gated_rotate(image, *args, **kwargs):
        entered.set()
        release.wait(3)
        return original_rotate(image, *args, **kwargs)

    monkeypatch.setattr(Image.Image, "rotate", gated_rotate)

    async def exercise():
        request_task = asyncio.create_task(rotate(_request({"angle": 90}), "img-1"))
        await _wait_thread_event(entered)
        loop_ran = asyncio.Event()
        asyncio.get_running_loop().call_soon(loop_ran.set)
        await asyncio.wait_for(loop_ran.wait(), timeout=0.2)
        assert not release.is_set()
        release.set()
        return await request_task

    safety_release = threading.Timer(0.5, release.set)
    safety_release.start()
    try:
        result = asyncio.run(exercise())
    finally:
        release.set()
        safety_release.cancel()

    db = db_factory()
    row = db.query(GalleryImage).filter_by(id="img-1").one()
    content = (image_dir / "x.png").read_bytes()
    assert result == {"ok": True, "width": 20, "height": 40}
    assert (row.width, row.height) == (20, 40)
    assert row.file_size == len(content)
    assert row.file_hash == hashlib.sha256(content).hexdigest()
    db.close()


def test_delete_during_rotation_cannot_be_undone_by_late_file_write(tmp_path, monkeypatch):
    db_factory, image_dir, _original = _seed(tmp_path, monkeypatch)
    rotate, delete, _replace = _endpoints()
    entered = threading.Event()
    release = threading.Event()
    original_rotate = Image.Image.rotate

    def gated_rotate(image, *args, **kwargs):
        entered.set()
        release.wait(3)
        return original_rotate(image, *args, **kwargs)

    monkeypatch.setattr(Image.Image, "rotate", gated_rotate)

    async def exercise():
        rotate_task = asyncio.create_task(rotate(_request({"angle": 90}), "img-1"))
        await _wait_thread_event(entered)
        result = await delete(_request(), "img-1")
        release.set()
        with pytest.raises(HTTPException) as exc:
            await rotate_task
        assert exc.value.status_code == 404
        return result

    safety_release = threading.Timer(0.5, release.set)
    safety_release.start()
    try:
        result = asyncio.run(exercise())
    finally:
        release.set()
        safety_release.cancel()

    db = db_factory()
    row = db.query(GalleryImage).filter_by(id="img-1").one()
    assert result["status"] == "deleted"
    assert row.is_active is False
    assert not (image_dir / "x.png").exists()
    db.close()


def test_replace_serializes_with_rotation_compensation(tmp_path, monkeypatch):
    db_factory, image_dir, _original = _seed(tmp_path, monkeypatch)
    rotate, _delete, replace = _endpoints()
    replacement = Image.new("RGB", (60, 15), "green")
    replacement_buffer = io.BytesIO()
    replacement.save(replacement_buffer, format="PNG")
    replacement_bytes = replacement_buffer.getvalue()
    commit_entered = threading.Event()
    release_commit = threading.Event()
    upload_read = threading.Event()
    main_thread = threading.get_ident()
    factory_guard = threading.Lock()
    fail_first_worker_commit = True
    real_session_local = db_factory

    def session_factory():
        nonlocal fail_first_worker_commit
        db = real_session_local()
        with factory_guard:
            should_fail = threading.get_ident() != main_thread and fail_first_worker_commit
            if should_fail:
                fail_first_worker_commit = False
        if should_fail:
            def fail_commit():
                commit_entered.set()
                release_commit.wait(3)
                raise RuntimeError("controlled rotation commit failure")

            db.commit = fail_commit
        return db

    monkeypatch.setattr(gallery_routes, "SessionLocal", session_factory)

    async def read_replacement(_file, *_args):
        upload_read.set()
        return replacement_bytes

    monkeypatch.setattr(gallery_routes, "read_upload_limited", read_replacement)

    async def exercise():
        rotation = asyncio.create_task(rotate(_request({"angle": 90}), "img-1"))
        await _wait_thread_event(commit_entered)
        replacement_task = asyncio.create_task(replace(_form_request(), "img-1"))
        await _wait_thread_event(upload_read)
        await asyncio.sleep(0.03)
        assert not replacement_task.done(), "replacement must wait for rotation compensation"
        release_commit.set()
        with pytest.raises(RuntimeError, match="controlled rotation commit failure"):
            await rotation
        result = await replacement_task
        return result

    safety_release = threading.Timer(0.6, release_commit.set)
    safety_release.start()
    try:
        result = asyncio.run(exercise())
    finally:
        release_commit.set()
        safety_release.cancel()

    db = db_factory()
    row = db.query(GalleryImage).filter_by(id="img-1").one()
    content = (image_dir / "x.png").read_bytes()
    assert result == {"ok": True, "width": 60, "height": 15}
    assert content == replacement_bytes
    assert row.file_hash == hashlib.sha256(replacement_bytes).hexdigest()
    assert row.file_size == len(replacement_bytes)
    assert (row.width, row.height) == (60, 15)
    db.close()


def test_replace_started_before_delete_cannot_recreate_deleted_file(tmp_path, monkeypatch):
    db_factory, image_dir, _original = _seed(tmp_path, monkeypatch)
    _rotate, delete, replace = _endpoints()
    replacement_bytes = b"replacement content"
    upload_read = threading.Event()
    release_upload = threading.Event()

    async def gated_read(_file, *_args):
        upload_read.set()
        await asyncio.to_thread(release_upload.wait, 3)
        return replacement_bytes

    monkeypatch.setattr(gallery_routes, "read_upload_limited", gated_read)

    async def exercise():
        replacement_task = asyncio.create_task(replace(_form_request(), "img-1"))
        await _wait_thread_event(upload_read)
        deleted = await delete(_request(), "img-1")
        release_upload.set()
        with pytest.raises(HTTPException) as exc:
            await replacement_task
        assert exc.value.status_code == 404
        return deleted

    safety_release = threading.Timer(0.6, release_upload.set)
    safety_release.start()
    try:
        result = asyncio.run(exercise())
    finally:
        release_upload.set()
        safety_release.cancel()

    db = db_factory()
    row = db.query(GalleryImage).filter_by(id="img-1").one()
    assert result["status"] == "deleted"
    assert row.is_active is False
    assert not (image_dir / "x.png").exists()
    db.close()


def test_concurrent_rotations_reject_stale_source_and_preserve_owner_scope(tmp_path, monkeypatch):
    db_factory, image_dir, original_content = _seed(tmp_path, monkeypatch)
    rotate, _delete, _replace = _endpoints()
    gate = threading.Barrier(2)
    original_rotate = Image.Image.rotate

    def synchronized_rotate(image, *args, **kwargs):
        gate.wait(timeout=3)
        return original_rotate(image, *args, **kwargs)

    monkeypatch.setattr(Image.Image, "rotate", synchronized_rotate)

    async def exercise_two_rotations():
        first, second = await asyncio.gather(
            rotate(_request({"angle": 90}), "img-1"),
            rotate(_request({"angle": 90}), "img-1"),
            return_exceptions=True,
        )
        return first, second

    first, second = asyncio.run(exercise_two_rotations())
    results = (first, second)
    assert sum(isinstance(item, dict) for item in results) == 1
    conflict = next(item for item in results if isinstance(item, HTTPException))
    assert conflict.status_code == 409
    db = db_factory()
    row = db.query(GalleryImage).filter_by(id="img-1").one()
    content = (image_dir / "x.png").read_bytes()
    assert row.file_hash == hashlib.sha256(content).hexdigest()
    assert content != original_content
    db.close()


def test_rotation_rejects_other_owner_without_mutating_image(tmp_path, monkeypatch):
    db_factory, image_dir, original = _seed(tmp_path, monkeypatch)
    rotate, delete, replace = _endpoints()
    monkeypatch.setattr(gallery_routes, "get_current_user", lambda _request: "bob")

    async def exercise():
        with pytest.raises(HTTPException) as rotate_error:
            await rotate(_request({"angle": 90}), "img-1")
        with pytest.raises(HTTPException) as delete_error:
            await delete(_request(), "img-1")
        return rotate_error.value.status_code, delete_error.value.status_code

    assert asyncio.run(exercise()) == (403, 404)
    assert (image_dir / "x.png").read_bytes() == original
    db = db_factory()
    assert db.query(GalleryImage).filter_by(id="img-1").one().is_active is True
    db.close()

    decoded = []
    original_open = Image.open

    def tracked_open(*args, **kwargs):
        decoded.append(True)
        return original_open(*args, **kwargs)

    monkeypatch.setattr(Image, "open", tracked_open)

    async def replace_other_owner():
        async def replacement_bytes(_file, *_args):
            return original

        monkeypatch.setattr(gallery_routes, "read_upload_limited", replacement_bytes)
        with pytest.raises(HTTPException) as exc:
            await replace(_form_request(), "img-1")
        assert exc.value.status_code == 403

    asyncio.run(replace_other_owner())
    assert decoded == []


def test_rotation_commit_failure_restores_original_file_and_metadata(tmp_path, monkeypatch):
    db_factory, image_dir, original = _seed(tmp_path, monkeypatch)
    rotate, _delete, _replace = _endpoints()

    def failing_factory():
        db = db_factory()
        db.commit = lambda: (_ for _ in ()).throw(RuntimeError("fixture commit failure"))
        return db

    monkeypatch.setattr(gallery_routes, "SessionLocal", failing_factory)
    with pytest.raises(RuntimeError, match="fixture commit failure"):
        asyncio.run(rotate(_request({"angle": 90}), "img-1"))

    db = db_factory()
    row = db.query(GalleryImage).filter_by(id="img-1").one()
    assert (image_dir / "x.png").read_bytes() == original
    assert row.file_hash == hashlib.sha256(original).hexdigest()
    assert (row.file_size, row.width, row.height) == (len(original), 40, 20)
    db.close()


def test_image_delete_cleans_only_current_owners_chat_history(tmp_path, monkeypatch):
    db_factory, _image_dir, _original = _seed(tmp_path, monkeypatch)
    _rotate, delete, _replace = _endpoints()
    db = db_factory()
    for owner in ("alice", "bob"):
        db.add(Session(
            id=f"{owner}-session", name="Fixture", endpoint_url="", model="fixture", owner=owner,
        ))
        timestamp = datetime(2026, 1, 1, 0, 0, 0)
        db.add(ChatMessage(
            id=f"{owner}-prompt", session_id=f"{owner}-session", role="user",
            content="Generate a picture", meta_data="{}", timestamp=timestamp,
        ))
        db.add(ChatMessage(
            id=f"{owner}-image", session_id=f"{owner}-session", role="assistant",
            content="Generated image for: fixture",
            meta_data=json.dumps({"tool_events": [{
                "image_id": "img-1", "image_url": "/api/generated-image/x.png",
            }]}),
            timestamp=timestamp + timedelta(seconds=1),
        ))
    db.commit()
    db.close()

    result = asyncio.run(delete(_request(), "img-1"))

    db = db_factory()
    remaining = db.query(ChatMessage).order_by(ChatMessage.id).all()
    assert result["status"] == "deleted"
    assert {message.id for message in remaining} == {"bob-image", "bob-prompt"}
    db.close()
