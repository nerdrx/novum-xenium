from __future__ import annotations

import hashlib
import io
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from core.database import Base, GalleryImage
import routes.gallery_routes as gallery_routes


@pytest.fixture
def gallery(tmp_path, monkeypatch):
    engine = create_engine(
        f"sqlite:///{tmp_path / 'gallery.db'}",
        connect_args={"check_same_thread": False},
    )
    Base.metadata.create_all(engine)
    db_factory = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    image_dir = tmp_path / "generated_images"
    monkeypatch.setattr(gallery_routes, "SessionLocal", db_factory)
    monkeypatch.setattr(gallery_routes, "GENERATED_IMAGES_DIR", image_dir)
    monkeypatch.setattr(gallery_routes, "GALLERY_IMAGE_DIR", image_dir)
    monkeypatch.setattr(gallery_routes, "get_current_user", lambda _request: "alice")
    app = FastAPI()
    app.include_router(gallery_routes.setup_gallery_routes())
    with TestClient(app) as client:
        yield SimpleNamespace(
            client=client, db_factory=db_factory, image_dir=image_dir, engine=engine,
        )
    engine.dispose()


def _encoded(fmt: str) -> bytes:
    output = io.BytesIO()
    Image.new("RGB", (16, 12), "#3478bd").save(output, format=fmt)
    return output.getvalue()


def _xbm_bytes() -> bytes:
    header = (
        b"#define" + b" " * 10 + b"_width 1\r"
        + b"#define" + b" " * 10 + b"_height 1\r"
        + b"#define" + b" " * 10 + b"_x_hot 1\r"
        + b"#define" + b" " * 10 + b"_y_hot 1" + b"\r" * 10
        + b"_bits"
    )
    return header + b"A" * (512 - len(header))


def _count_rows(db_factory) -> int:
    db = db_factory()
    try:
        return db.query(GalleryImage).count()
    finally:
        db.close()


@pytest.mark.parametrize(
    ("extension", "fmt"),
    [("png", "PNG"), ("jpg", "JPEG"), ("webp", "WEBP"), ("gif", "GIF")],
)
def test_gallery_upload_keeps_declared_formats_and_exif_warning(gallery, monkeypatch, extension, fmt):
    original_extract = gallery_routes._extract_exif

    def warning_after_identification(content):
        result = original_extract(content)
        result["exif_error"] = "synthetic EXIF warning"
        return result

    monkeypatch.setattr(gallery_routes, "_extract_exif", warning_after_identification)
    response = gallery.client.post(
        "/api/gallery/upload",
        files={"file": (f"valid.{extension}", _encoded(fmt), f"image/{extension}")},
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["exif_warning"] == "synthetic EXIF warning"
    assert _count_rows(gallery.db_factory) == 1
    assert (gallery.image_dir / body["filename"]).is_file()


@pytest.mark.parametrize(
    ("filename", "fmt"),
    [("mismatch.png", "JPEG"), ("extensionless", "PNG")],
)
def test_gallery_upload_accepts_declared_image_bytes_independent_of_suffix(gallery, filename, fmt):
    response = gallery.client.post(
        "/api/gallery/upload",
        files={"file": (filename, _encoded(fmt), "application/octet-stream")},
    )

    assert response.status_code == 200, response.text
    assert _count_rows(gallery.db_factory) == 1
    assert (gallery.image_dir / response.json()["filename"]).is_file()


@pytest.mark.parametrize("payload", [_xbm_bytes(), b"not an image"])
def test_gallery_upload_rejects_invalid_image_before_file_or_row_write(gallery, monkeypatch, payload):
    Image.init()
    entered = []
    factory, accept = Image.OPEN["XBM"]

    def observe_factory(*args, **kwargs):
        entered.append("factory")
        return factory(*args, **kwargs)

    def observe_accept(prefix):
        entered.append("accept")
        return accept(prefix)

    monkeypatch.setitem(Image.OPEN, "XBM", (observe_factory, observe_accept))
    response = gallery.client.post(
        "/api/gallery/upload",
        files={"file": ("invalid.png", payload, "image/png")},
    )

    assert response.status_code == 400, response.text
    assert _count_rows(gallery.db_factory) == 0
    assert not gallery.image_dir.exists() or not list(gallery.image_dir.iterdir())
    assert entered == []


def _seed_gallery_image(gallery) -> bytes:
    original = _encoded("PNG")
    gallery.image_dir.mkdir(parents=True, exist_ok=True)
    (gallery.image_dir / "existing.png").write_bytes(original)
    db = gallery.db_factory()
    try:
        db.add(GalleryImage(
            id="existing-image", filename="existing.png", prompt="original",
            owner="alice", is_active=True,
            file_hash=hashlib.sha256(original).hexdigest(),
            file_size=len(original), width=16, height=12,
        ))
        db.commit()
    finally:
        db.close()
    return original


@pytest.mark.parametrize("payload", [_xbm_bytes(), b"not an image"])
def test_replace_rejects_invalid_bytes_without_changing_file_or_row(gallery, payload):
    original = _seed_gallery_image(gallery)
    response = gallery.client.post(
        "/api/gallery/existing-image/replace",
        files={"image": ("replacement.png", payload, "image/png")},
    )

    assert response.status_code == 400, response.text
    assert (gallery.image_dir / "existing.png").read_bytes() == original
    db = gallery.db_factory()
    try:
        row = db.query(GalleryImage).filter_by(id="existing-image").one()
        assert row.file_hash == hashlib.sha256(original).hexdigest()
        assert (row.width, row.height) == (16, 12)
    finally:
        db.close()


def test_replace_keeps_generic_registered_formats(gallery):
    _seed_gallery_image(gallery)
    replacement = _encoded("TIFF")
    response = gallery.client.post(
        "/api/gallery/existing-image/replace",
        files={"image": ("replacement.png", replacement, "image/png")},
    )

    assert response.status_code == 200, response.text
    assert response.json()["width"] == 16
    assert response.json()["height"] == 12
    assert (gallery.image_dir / "existing.png").read_bytes() == replacement
