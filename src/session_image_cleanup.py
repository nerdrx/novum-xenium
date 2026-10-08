"""Cleanup helpers for images attached to chat sessions."""

from __future__ import annotations

import json
import logging
import os
import re
import threading
import uuid
from pathlib import Path

from src.constants import GENERATED_IMAGES_DIR

logger = logging.getLogger(__name__)
IMAGE_PERSISTENCE_LOCK = threading.RLock()


def _database_models():
    """Import DB models at call time so early import stubs cannot stick here."""
    from core.database import ChatMessage, GalleryImage, SessionLocal

    return ChatMessage, GalleryImage, SessionLocal


def persist_generated_image(
    image_bytes: bytes,
    *,
    directory: str | Path,
    prompt: str,
    model: str,
    size: str,
    quality: str,
    session_id: str | None,
    owner: str | None,
    suffix: str = ".png",
) -> tuple[str, str]:
    """Serialize scope-checked generated-image file and Gallery persistence."""
    from src.database import GalleryImage, Session, SessionLocal

    stored_session_id = session_id or None
    image_path = None
    created_file = False
    db = SessionLocal()
    try:
        with IMAGE_PERSISTENCE_LOCK:
            if stored_session_id:
                session = db.query(Session).filter(Session.id == stored_session_id).first()
                if session is None or session.owner != owner:
                    raise ValueError("Chat is no longer available; generated image was not saved.")

            image_dir = Path(directory)
            image_dir.mkdir(parents=True, exist_ok=True)
            filename = f"{uuid.uuid4().hex[:12]}{suffix}"
            image_path = image_dir / filename
            with image_path.open("xb") as handle:
                created_file = True
                handle.write(image_bytes)
            image_id = str(uuid.uuid4())
            db.add(GalleryImage(
                id=image_id,
                filename=filename,
                prompt=prompt,
                model=model,
                size=size,
                quality=quality,
                session_id=stored_session_id,
                owner=owner,
            ))
            db.commit()
            return filename, image_id
    except Exception:
        try:
            db.rollback()
        except Exception:
            logger.warning("Could not roll back generated image Gallery insert", exc_info=True)
        if image_path is not None and created_file:
            try:
                image_path.unlink(missing_ok=True)
            except OSError:
                logger.warning("Could not remove unregistered generated image %s", image_path)
        raise
    finally:
        db.close()


def _generated_image_path_for_cleanup(filename: str) -> Path | None:
    if not isinstance(filename, str) or not filename:
        return None
    name = Path(filename).name
    if name != filename or name in {".", ".."}:
        return None
    root = Path(GENERATED_IMAGES_DIR).resolve()
    path = (root / name).resolve()
    try:
        if os.path.commonpath([str(root), str(path)]) != str(root):
            return None
    except Exception:
        return None
    return path


def _image_filename_from_url(url: str) -> str:
    if not isinstance(url, str) or not url:
        return ""
    match = re.search(r"/api/generated-image/([^?#/]+)", url)
    return match.group(1) if match else ""


def session_image_refs(db, session_id: str) -> tuple[set[str], set[str]]:
    """Return gallery image ids and generated-image filenames referenced by a chat."""
    ChatMessage, GalleryImage, _ = _database_models()
    image_ids: set[str] = set()
    filenames: set[str] = set()

    rows = db.query(GalleryImage).filter(GalleryImage.session_id == session_id).all()
    for img in rows:
        if img.id:
            image_ids.add(str(img.id))
        if img.filename:
            filenames.add(str(img.filename))

    messages = db.query(ChatMessage.meta_data).filter(ChatMessage.session_id == session_id).all()
    for row in messages:
        raw = getattr(row, "meta_data", None)
        if not raw:
            continue
        try:
            meta = json.loads(raw)
        except Exception:
            continue
        events = meta.get("tool_events") if isinstance(meta, dict) else None
        if not isinstance(events, list):
            continue
        for ev in events:
            if not isinstance(ev, dict):
                continue
            image_id = ev.get("image_id")
            if image_id:
                image_ids.add(str(image_id))
            filename = _image_filename_from_url(ev.get("image_url") or ev.get("url") or "")
            if filename:
                filenames.add(filename)

    return image_ids, filenames


def cleanup_session_images(session_id: str, db=None) -> int:
    """Soft-delete Gallery rows and unlink generated files owned by a chat."""
    with IMAGE_PERSISTENCE_LOCK:
        return _cleanup_session_images_locked(session_id, db)


def _cleanup_session_images_locked(session_id: str, db=None) -> int:
    _, GalleryImage, SessionLocal = _database_models()
    owns_db = db is None
    db = db or SessionLocal()
    try:
        image_ids, filenames = session_image_refs(db, session_id)
        query = db.query(GalleryImage).filter(GalleryImage.session_id == session_id)
        if image_ids or filenames:
            from sqlalchemy import or_

            clauses = [GalleryImage.session_id == session_id]
            if image_ids:
                clauses.append(GalleryImage.id.in_(list(image_ids)))
            if filenames:
                clauses.append(GalleryImage.filename.in_(list(filenames)))
            query = db.query(GalleryImage).filter(or_(*clauses))

        images = query.all()
        removed = 0
        for img in images:
            img.is_active = False
            if img.filename:
                path = _generated_image_path_for_cleanup(img.filename)
                if path and path.exists():
                    try:
                        path.unlink()
                    except Exception as exc:
                        logger.warning(
                            "Could not remove generated image %s for deleted session %s: %s",
                            img.filename,
                            session_id,
                            exc,
                        )
            removed += 1

        if owns_db and images:
            db.commit()
        return removed
    except Exception as exc:
        if owns_db:
            db.rollback()
        logger.warning("Failed to clean images for deleted session %s: %s", session_id, exc)
        return 0
    finally:
        if owns_db:
            db.close()
