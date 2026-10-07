"""Backup routes — export/import user data (memories, presets, settings, skills, preferences)."""

import errno
import json
import logging
import sqlite3
import tempfile
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask
from starlette.concurrency import run_in_threadpool
from core.middleware import INTERNAL_TOOL_HEADER, require_admin
from services.memory import MemoryStoreUnreadable
from src.auth_helpers import get_current_user, is_delegated_credential
from src.owner_identity import INTERNAL_TOOL_USER
from src.settings import load_settings, save_settings, load_features, save_features

logger = logging.getLogger(__name__)


def _require_browser_admin(request: Request) -> str:
    """Full-instance archives require an interactive admin browser session."""
    if (request.headers.get(INTERNAL_TOOL_HEADER)
            or is_delegated_credential(request)
            or getattr(request.state, "current_user", None) == INTERNAL_TOOL_USER):
        raise HTTPException(403, "Full backup requires an admin browser session")
    require_admin(request)
    user = get_current_user(request)
    auth_manager = getattr(request.app.state, "auth_manager", None)
    if not user or not auth_manager or not auth_manager.is_admin(user):
        raise HTTPException(403, "Full backup requires an authenticated admin browser session")
    return user


async def _save_upload(request: Request, max_bytes: int) -> Path:
    """Stream raw ZIP request body to disk with a hard size cap."""
    if request.headers.get("content-type", "").split(";", 1)[0].strip() not in {
        "application/zip", "application/octet-stream",
    }:
        raise HTTPException(415, "Upload the ZIP archive as application/zip")
    try:
        declared_size = int(request.headers.get("content-length", "0"))
    except ValueError:
        declared_size = 0
    if declared_size > max_bytes:
        raise HTTPException(413, "Backup archive exceeds the upload limit")
    handle = tempfile.NamedTemporaryFile(prefix="odysseus-restore-upload-", suffix=".zip", delete=False)
    path = Path(handle.name)
    size = 0
    try:
        with handle:
            async for chunk in request.stream():
                size += len(chunk)
                if size > max_bytes:
                    raise HTTPException(413, "Backup archive exceeds the upload limit")
                handle.write(chunk)
        return path
    except Exception:
        path.unlink(missing_ok=True)
        raise


def setup_backup_routes(memory_manager, preset_manager, skills_manager) -> APIRouter:
    router = APIRouter(tags=["backup"])

    @router.get("/api/backup/full")
    async def export_full_backup(request: Request):
        """Download a sensitive full local-data archive."""
        _require_browser_admin(request)
        from src.constants import DATA_DIR
        from src.full_backup import create_backup
        try:
            path = await run_in_threadpool(create_backup, DATA_DIR)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        except sqlite3.Error as exc:
            raise HTTPException(
                409, "A database could not be snapshotted. Stop concurrent file moves and retry; "
                "check database health if this continues.",
            ) from exc
        except OSError as exc:
            if exc.errno == errno.ENOTSUP:
                detail = "Safe full backups are unavailable on this platform. Use the Linux Docker installation."
                status = 503
            elif exc.errno in {errno.ELOOP, errno.ENOENT, errno.ENOTDIR}:
                detail = "Application files changed while creating the backup. Stop concurrent file moves and retry."
                status = 409
            else:
                detail = "Could not read or save the application backup. Check folder permissions and free disk space, then retry."
                status = 500
            raise HTTPException(status, detail) from exc
        filename = f"odysseus_full_backup_{datetime.now().strftime('%Y%m%d_%H%M%S')}.zip"
        return FileResponse(
            path, media_type="application/zip", filename=filename,
            background=BackgroundTask(path.unlink, missing_ok=True),
            headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"},
        )

    @router.post("/api/backup/preview")
    async def preview_full_backup(request: Request):
        """Validate and summarize a full backup without touching live data."""
        _require_browser_admin(request)
        from src.full_backup import (
            MAX_ARCHIVE_BYTES, extract_archive, validate_extracted_data,
        )
        archive_path = await _save_upload(request, MAX_ARCHIVE_BYTES)
        try:
            with tempfile.TemporaryDirectory(prefix="odysseus-backup-preview-") as staging:
                preview = await run_in_threadpool(extract_archive, archive_path, staging)
                await run_in_threadpool(validate_extracted_data, Path(staging) / "data")
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        finally:
            archive_path.unlink(missing_ok=True)
        preview["sensitive"] = True
        preview["restore_requires_restart"] = True
        return preview

    @router.post("/api/backup/restore")
    async def restore_full_backup(request: Request):
        """Validate and stage archive; activation runs before DB initialization."""
        _require_browser_admin(request)
        from src.constants import DATA_DIR
        from src.full_backup import (
            MAX_ARCHIVE_BYTES, extract_archive, stage_restore,
            validate_extracted_data,
        )
        archive_path = await _save_upload(request, MAX_ARCHIVE_BYTES)
        try:
            with tempfile.TemporaryDirectory(prefix="odysseus-backup-check-") as staging:
                preview = await run_in_threadpool(extract_archive, archive_path, staging)
                await run_in_threadpool(validate_extracted_data, Path(staging) / "data")
            preview = await run_in_threadpool(stage_restore, archive_path, DATA_DIR)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        finally:
            archive_path.unlink(missing_ok=True)
        return {
            "ok": True, "restore_pending": True, "restart_required": True,
            "message": "Restore is staged. Stop and start Odysseus to activate it; runtime caches and external Docker volumes are preserved.",
            "files": preview["files"],
        }

    @router.get("/api/export")
    async def export_data(request: Request):
        """Export all user data as a downloadable JSON file."""
        require_admin(request)
        user = get_current_user(request)

        # Memories (filtered by owner when auth is enabled)
        memories = memory_manager.load(owner=user)

        # Presets (shared across users — export all)
        presets = preset_manager.get_all()

        # Skills (filtered by owner when auth is enabled)
        skills = skills_manager.load(owner=user)

        # Settings
        settings = load_settings()

        # Feature flags
        features = load_features()

        # User preferences
        from routes.prefs_routes import _load_for_user
        preferences = _load_for_user(user)

        export_data = {
            "version": 1,
            "exported_at": datetime.now().isoformat(),
            "exported_by": user,
            "memories": memories,
            "presets": presets,
            "skills": skills,
            "settings": settings,
            "features": features,
            "preferences": preferences,
        }

        filename = f"odysseus_backup_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
        return Response(
            content=json.dumps(export_data, indent=2, ensure_ascii=False),
            media_type="application/json",
            headers={"Content-Disposition": f"attachment; filename={filename}"},
        )

    @router.post("/api/import")
    async def import_data(request: Request):
        """Import user data from a previously exported JSON file. Merges with existing data."""
        require_admin(request)
        user = get_current_user(request)
        try:
            body = await request.json()
        except Exception:
            raise HTTPException(400, "Invalid JSON")

        if not isinstance(body, dict):
            raise HTTPException(400, "Expected a JSON object")

        imported = []

        # ── Memories ──
        if "memories" in body and isinstance(body["memories"], list):
            # Strict load: importing on top of an unreadable store would write
            # only the incoming rows back and drop everything already saved.
            try:
                existing = memory_manager.load_all_for_update()
            except MemoryStoreUnreadable as e:
                logger.error("Refusing to import memories: %s", e)
                raise HTTPException(
                    503, "Memory store is temporarily unreadable — nothing was imported."
                )
            # Dedup against THIS user's own memories only. Using every tenant's
            # rows (load_all) meant a memory whose text matched any other
            # user's was silently skipped, so the importing user lost their own
            # data. The full store is still saved back below.
            existing_texts = {e.get("text", "").strip().lower()
                              for e in existing if e.get("owner") == user}
            added = 0
            for mem in body["memories"]:
                if not isinstance(mem, dict) or not mem.get("text"):
                    continue
                if mem["text"].strip().lower() in existing_texts:
                    continue  # skip duplicates
                # Assign owner when auth is enabled
                if user and not mem.get("owner"):
                    mem["owner"] = user
                existing.append(mem)
                existing_texts.add(mem["text"].strip().lower())
                added += 1
            memory_manager.save(existing)
            imported.append(f"{added} memories")

        # ── Skills ──
        if "skills" in body and isinstance(body["skills"], list):
            existing = skills_manager.load_all()
            # Dedup against THIS user's own skills only. Using every tenant's
            # rows (load_all) meant a skill whose id/name/title matched any
            # other user's was silently skipped, so the importing user lost
            # their own data — same cross-tenant bug fixed for memories above.
            # The full store is still saved back below.
            own = [s for s in existing if s.get("owner") == user]
            existing_names = {s.get("name") for s in own if s.get("name")}
            existing_ids = {s.get("id") for s in own if s.get("id")}
            existing_titles = {
                (s.get("title") or s.get("description") or "").strip().lower()
                for s in own
            }
            added = 0
            for skill in body["skills"]:
                if not isinstance(skill, dict):
                    continue
                title = (
                    skill.get("title") or skill.get("description")
                    or skill.get("name") or ""
                ).strip()
                if not title:
                    continue
                sid = skill.get("id") or skill.get("name")
                if sid and sid in existing_ids:
                    continue
                nm = skill.get("name")
                if nm and nm in existing_names:
                    continue
                if title.lower() in existing_titles:
                    continue
                owner = skill.get("owner")
                if user and not owner:
                    owner = user
                # Skills live on disk as SKILL.md files; the old JSON-era
                # skills_manager.save() no longer exists. Write each new skill
                # via add_skill (source="user" skips auto-dedup — this is an
                # explicit backup restore).
                result = skills_manager.add_skill(
                    title=title,
                    name=skill.get("name"),
                    description=skill.get("description"),
                    problem=skill.get("problem", ""),
                    solution=skill.get("solution", ""),
                    steps=skill.get("steps"),
                    tags=skill.get("tags"),
                    source="user",
                    teacher_model=skill.get("teacher_model"),
                    confidence=skill.get("confidence", 0.8),
                    owner=owner,
                    category=skill.get("category", "general"),
                    when_to_use=skill.get("when_to_use"),
                    procedure=skill.get("procedure"),
                    pitfalls=skill.get("pitfalls"),
                    verification=skill.get("verification"),
                    platforms=skill.get("platforms"),
                    requires_toolsets=skill.get("requires_toolsets"),
                    fallback_for_toolsets=skill.get("fallback_for_toolsets"),
                    status=skill.get("status", "draft"),
                    version=skill.get("version", "1.0.0"),
                )
                if result.get("_deduped"):
                    continue
                if result.get("name"):
                    existing_names.add(result["name"])
                if result.get("id"):
                    existing_ids.add(result["id"])
                existing_titles.add(title.lower())
                added += 1
            imported.append(f"{added} skills")

        # ── Presets ──
        if "presets" in body and isinstance(body["presets"], dict):
            current = preset_manager.get_all()
            for key, value in body["presets"].items():
                if isinstance(value, dict):
                    current[key] = value
                elif isinstance(value, list):
                    current[key] = value
            preset_manager.save(current)
            imported.append("presets")

        # ── Settings ──
        if "settings" in body and isinstance(body["settings"], dict):
            current = load_settings()
            current.update(body["settings"])
            save_settings(current)
            imported.append("settings")

        # ── Features ──
        if "features" in body and isinstance(body["features"], dict):
            current = load_features()
            current.update(body["features"])
            save_features(current)
            imported.append("features")

        # ── Preferences ──
        if "preferences" in body and isinstance(body["preferences"], dict):
            from routes.prefs_routes import _load_for_user, _save_for_user
            current = _load_for_user(user)
            current.update(body["preferences"])
            _save_for_user(user, current)
            imported.append("preferences")

        if not imported:
            return {"ok": False, "message": "No recognized data found in the file"}

        return {"ok": True, "imported": imported, "message": f"Imported: {', '.join(imported)}"}

    return router
