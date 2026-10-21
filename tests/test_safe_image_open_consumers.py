"""Focused XBM exclusion checks for untrusted image decode consumers."""

import asyncio
import base64
import io
import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from PIL import Image
from starlette.datastructures import UploadFile

def _image_bytes(fmt: str) -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", (9, 7), "#2b7fff").save(buffer, format=fmt)
    return buffer.getvalue()


def _xbm_bytes() -> bytes:
    payload = (
        b"#define" + b" " * 10 + b"_width 1\r"
        + b"#define" + b" " * 10 + b"_height 1\r"
        + b"#define" + b" " * 10 + b"_x_hot 1\r"
        + b"#define" + b" " * 10 + b"_y_hot 1" + b"\r" * 10
        + b"_bits"
    )
    return payload + b"A" * max(0, 512 - len(payload))


@pytest.fixture
def xbm_spy(monkeypatch):
    Image.init()
    if "XBM" not in Image.OPEN:
        pytest.skip("XBM decoder is not registered in this Pillow runtime")
    calls = []

    def factory(*_args, **_kwargs):
        calls.append("factory")
        raise AssertionError("XBM decoder factory entered")

    def accept(_prefix):
        calls.append("accept")
        return True

    monkeypatch.setitem(Image.OPEN, "XBM", (factory, accept))
    return calls


def test_upload_metadata_open_keeps_tiff_and_stores_bad_optional_image(tmp_path, xbm_spy):
    from src.upload_handler import UploadHandler

    upload_root = tmp_path / "uploads"
    handler = UploadHandler(str(tmp_path), str(upload_root))
    handler.detect_content_type = lambda _file, filename: (
        "image/tiff" if filename.endswith(".tiff") else "image/png"
    )

    tiff = UploadFile(file=io.BytesIO(_image_bytes("TIFF")), filename="valid.tiff")
    valid = handler.save_upload(tiff, "127.0.0.1", owner="synthetic")
    assert (valid["width"], valid["height"]) == (9, 7)
    assert Path(valid["path"]).is_file()

    bad = UploadFile(file=io.BytesIO(_xbm_bytes()), filename="bad.png")
    stored = handler.save_upload(bad, "127.0.0.1", owner="synthetic")
    assert Path(stored["path"]).is_file()
    assert "width" not in stored and "height" not in stored
    assert xbm_spy == []


def test_upload_thumbnail_falls_back_for_xbm_and_handles_tiff(tmp_path, monkeypatch, xbm_spy):
    from fastapi import APIRouter, FastAPI
    from fastapi.testclient import TestClient
    from routes import upload_routes
    from src.upload_handler import UploadHandler

    monkeypatch.setattr(upload_routes, "router", APIRouter(prefix="/api/upload", tags=["upload"]))
    monkeypatch.setattr(upload_routes, "auth_disabled", lambda: True)
    upload_root = tmp_path / "uploads"
    upload_root.mkdir()
    handler = UploadHandler(str(tmp_path), str(upload_root))
    bad_id = "a" * 32 + ".png"
    bad_path = upload_root / bad_id
    bad_path.write_bytes(_xbm_bytes())
    tiff_id = "b" * 32 + ".tiff"
    tiff_path = upload_root / tiff_id
    tiff_path.write_bytes(_image_bytes("TIFF"))
    index = {
        f"synthetic:{bad_id}": {"id": bad_id, "path": str(bad_path), "name": "bad.png", "mime": "image/png", "owner": "synthetic"},
        f"synthetic:{tiff_id}": {"id": tiff_id, "path": str(tiff_path), "name": "valid.tiff", "mime": "image/tiff", "owner": "synthetic"},
    }
    (upload_root / "uploads.json").write_text(json.dumps(index), encoding="utf-8")

    upload_routes.setup_upload_routes(handler)
    app = FastAPI()
    app.include_router(upload_routes.router)
    with TestClient(app) as client:
        bad_response = client.get(f"/api/upload/{bad_id}?thumb=1")
        assert bad_response.status_code == 200
        assert bad_response.content == _xbm_bytes()
        assert bad_response.headers["content-type"] == "image/png"
    assert not (upload_root / ".thumbs" / f"{bad_id}.jpg").exists()
    with TestClient(app) as client:
        good_response = client.get(f"/api/upload/{tiff_id}?thumb=1")
    assert good_response.status_code == 200
    assert good_response.headers["content-type"] == "image/jpeg"
    with Image.open(io.BytesIO(good_response.content)) as thumbnail:
        assert thumbnail.size == (9, 7)
    assert xbm_spy == []


def test_media_ingress_keeps_bmp_and_rejects_xbm(tmp_path, xbm_spy):
    from src.media_ingress import (
        LocalMediaAttachment, MediaIngressLimits, build_multimodal_user_content,
    )

    for fmt, suffix in (("BMP", ".bmp"), ("GIF", ".gif"), ("JPEG", ".jpeg"),
                        ("PNG", ".png"), ("WEBP", ".webp")):
        path = tmp_path / f"valid{suffix}"
        path.write_bytes(_image_bytes(fmt))
        good = build_multimodal_user_content(
            f"Inspect {fmt}", [LocalMediaAttachment(path, f"/workspace/{path.name}")],
            limits=MediaIngressLimits(max_dimension=64),
        )
        assert len(good.artifacts) == 1, fmt
        assert good.artifacts[0].width == 9 and good.artifacts[0].height == 7, fmt

    xbm = tmp_path / "invalid.png"
    xbm.write_bytes(_xbm_bytes())
    bad = build_multimodal_user_content(
        "Inspect XBM", [LocalMediaAttachment(xbm, "/workspace/invalid.png")],
    )
    assert not bad.artifacts
    assert any("invalid image" in warning for warning in bad.warnings)
    assert xbm_spy == []


def test_inspect_media_and_clean_preview_exclude_xbm(tmp_path, monkeypatch, xbm_spy):
    from src.agent_tools.media_tools import InspectMediaTool
    from src.clean_agent_preview import bounded_visual_result_blocks
    from src.tool_execution import _active_workspace

    xbm = tmp_path / "invalid.png"
    xbm.write_bytes(_xbm_bytes())
    token = _active_workspace.set(str(tmp_path))
    try:
        result = asyncio.run(InspectMediaTool().execute(json.dumps({"path": "/workspace/invalid.png"}), {}))
    finally:
        _active_workspace.reset(token)
    assert result["exit_code"] == 1
    assert "invalid" in result["error"].lower() or "identify" in result["error"].lower()

    png_data = base64.b64encode(_image_bytes("PNG")).decode("ascii")
    xbm_data = base64.b64encode(_xbm_bytes()).decode("ascii")
    packed = bounded_visual_result_blocks({"images": [
        {"mimeType": "image/png", "data": png_data},
        {"mimeType": "image/x-xbitmap", "data": xbm_data},
    ]}, max_images=1)
    assert len(packed) == 1
    assert xbm_spy == []


def test_gallery_edit_and_image_edit_dimension_paths_exclude_xbm(tmp_path, monkeypatch, xbm_spy):
    from core import database
    from src import ai_interaction
    from src.tools.image import do_edit_image

    xbm = tmp_path / "source.png"
    xbm.write_bytes(_xbm_bytes())

    class Query:
        def filter(self, *_clauses):
            return self

        def first(self):
            return SimpleNamespace(filename=xbm.name, prompt="Synthetic", caption="", quality="", tags="", ai_tags="", session_id=None, album_id=None)

    class Db:
        def query(self, _model):
            return Query()

        def rollback(self):
            pass

        def close(self):
            pass

    monkeypatch.setattr(database, "SessionLocal", Db)
    monkeypatch.setattr("src.constants.GENERATED_IMAGES_DIR", str(tmp_path))
    result = asyncio.run(do_edit_image(json.dumps({"image_id": "synthetic", "action": "upscale"}), owner="synthetic"))
    assert result["exit_code"] == 1

    monkeypatch.setattr(ai_interaction, "_resolve_model", lambda *_args, **_kwargs: ("http://unused.invalid/v1", "synthetic", {}))
    monkeypatch.setattr("src.settings.load_settings", lambda: {"image_model": "synthetic"})
    ai_result = asyncio.run(ai_interaction.do_edit_image("synthetic", str(xbm), size="auto"))
    assert "Could not read the attached image dimensions" in ai_result["error"]
    assert xbm_spy == []


def test_dimension_helper_keeps_tiff_and_returns_none_for_xbm(xbm_spy):
    from src.ai_interaction import _image_dimensions

    assert _image_dimensions(_image_bytes("TIFF")) == "9x7"
    assert _image_dimensions(_xbm_bytes()) is None
    assert xbm_spy == []
