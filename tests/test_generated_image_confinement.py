import os
from pathlib import Path

import pytest
from fastapi import HTTPException


def _generated_images_module():
    from src import generated_images
    return generated_images


def test_generated_image_path_allows_safe_existing_file(tmp_path, monkeypatch):
    generated_images = _generated_images_module()
    image_dir = tmp_path / "generated_images"
    image_dir.mkdir()
    filename = "a" * 12 + ".png"
    image_path = image_dir / filename
    image_path.write_bytes(b"png")
    monkeypatch.setattr(generated_images, "GENERATED_IMAGE_DIR", image_dir)

    assert generated_images.resolve_generated_image_path(filename) == image_path


@pytest.mark.parametrize("filename", ["../../secret.png", "zzzzzzzz.png", "aaaaaaa.png", None, 12345])
def test_generated_image_path_rejects_invalid_filenames(tmp_path, monkeypatch, filename):
    generated_images = _generated_images_module()
    image_dir = tmp_path / "generated_images"
    image_dir.mkdir()
    monkeypatch.setattr(generated_images, "GENERATED_IMAGE_DIR", image_dir)

    with pytest.raises(HTTPException) as exc:
        generated_images.resolve_generated_image_path(filename)

    assert exc.value.status_code == 400


def test_generated_image_path_rejects_symlink_escape(tmp_path, monkeypatch):
    generated_images = _generated_images_module()
    image_dir = tmp_path / "generated_images"
    image_dir.mkdir()
    filename = "b" * 12 + ".png"
    outside = tmp_path / "outside.png"
    outside.write_bytes(b"outside image root")
    try:
        os.symlink(outside, image_dir / filename)
    except (AttributeError, NotImplementedError, OSError) as exc:
        pytest.skip(f"symlinks unavailable: {exc}")
    monkeypatch.setattr(generated_images, "GENERATED_IMAGE_DIR", image_dir)

    with pytest.raises(HTTPException) as exc:
        generated_images.resolve_generated_image_path(filename)

    assert exc.value.status_code == 400


def test_generated_image_headers_include_nosniff():
    generated_images = _generated_images_module()

    assert generated_images.GENERATED_IMAGE_HEADERS["X-Content-Type-Options"] == "nosniff"
    assert (
        generated_images.GENERATED_IMAGE_HEADERS["Cache-Control"]
        == "public, max-age=31536000, immutable"
    )


def test_generated_image_route_uses_confining_resolver():
    source = Path("app.py").read_text(encoding="utf-8")

    assert 'Path("data/generated_images") / filename' not in source
    assert "resolve_generated_image_path(filename)" in source
    assert "headers=GENERATED_IMAGE_HEADERS" in source


def test_generated_image_route_fails_closed_when_owner_lookup_fails(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient
    monkeypatch.setenv("AUTH_ENABLED", "false")
    import app
    import src.auth_helpers as auth_helpers
    import src.database as database
    from src import generated_images

    image_dir = tmp_path / "generated_images"
    image_dir.mkdir()
    filename = "c" * 12 + ".png"
    (image_dir / filename).write_bytes(b"fixture image")
    monkeypatch.setattr(generated_images, "GENERATED_IMAGE_DIR", image_dir)
    monkeypatch.setattr(auth_helpers, "get_current_user", lambda _request: "alice")

    def unavailable_database():
        raise RuntimeError("fixture database unavailable")

    monkeypatch.setattr(database, "SessionLocal", unavailable_database)
    response = TestClient(app.app, raise_server_exceptions=False).get(
        f"/api/generated-image/{filename}"
    )

    assert response.status_code == 503


def test_generated_image_route_still_serves_in_auth_disabled_mode(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient
    monkeypatch.setenv("AUTH_ENABLED", "false")
    import app
    import src.database as database
    from src import generated_images

    image_dir = tmp_path / "generated_images"
    image_dir.mkdir()
    filename = "d" * 12 + ".png"
    payload = b"fixture image"
    (image_dir / filename).write_bytes(payload)
    monkeypatch.setattr(generated_images, "GENERATED_IMAGE_DIR", image_dir)

    def unavailable_database():
        raise RuntimeError("the disabled-auth path must not query ownership")

    monkeypatch.setattr(database, "SessionLocal", unavailable_database)
    response = TestClient(app.app, raise_server_exceptions=False).get(
        f"/api/generated-image/{filename}"
    )

    assert response.status_code == 200
    assert response.content == payload
