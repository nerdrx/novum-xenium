"""Small, owner-scoped snapshots for explicitly granted workspaces."""
from __future__ import annotations

import difflib
import base64
import errno
import hashlib
import json
import os
import re
import stat
import shutil
import tempfile
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path

from src.constants import DATA_DIR

_ROOT = Path(DATA_DIR) / "workspace_snapshots"
_MAX_FILES = 2_000
_MAX_FILE_BYTES = 8 * 1024 * 1024
_MAX_TOTAL_BYTES = 64 * 1024 * 1024
_MAX_SNAPSHOTS = 20
_MAX_PREVIEW_BYTES = 512 * 1024
_SCOPE_FILE = ".scope.json"
_EXCLUDED_DIRS = {".git", "node_modules", ".venv", "venv", "__pycache__", ".cache", "dist", "build"}
_EXCLUDED_NAMES = {
    ".env", ".netrc", ".npmrc", "id_rsa", "id_ed25519", "credentials.json",
    "secrets.json", "secret.json", "token.json", "tokens.json", "passwords.json",
    "api_key", "api_key.txt", "client_secret.json", "private_key.pem", "service-account.json",
}
_LOCK = threading.RLock()


class SnapshotError(ValueError):
    """Invalid, unsafe, or stale snapshot operation."""


class SnapshotRestoreError(SnapshotError):
    def __init__(self, message: str, rollback_snapshot_id: str):
        super().__init__(message)
        self.rollback_snapshot_id = rollback_snapshot_id


def _identity(workspace: str, owner: str, session_id: str) -> tuple[str, str]:
    if not isinstance(owner, str) or not owner.strip() or not isinstance(session_id, str) or not session_id.strip():
        raise SnapshotError("owner and session are required")
    from src.tool_execution import vet_workspace
    root = vet_workspace(workspace)
    if not root or root != os.path.realpath(workspace):
        raise SnapshotError("workspace is no longer valid")
    key = hashlib.sha256(json.dumps([owner, session_id, root], separators=(",", ":")).encode()).hexdigest()
    return root, key


def _session_scope(owner: str, session_id: str) -> str:
    return hashlib.sha256(json.dumps([owner, session_id], separators=(",", ":")).encode()).hexdigest()


def validate_session_scope(owner: str, session_id: str) -> None:
    """Fail closed if the chat no longer exists or belongs to another owner."""
    from src.owner_identity import auth_disabled
    from core.database import Session as DbSession, SessionLocal

    db = SessionLocal()
    try:
        row = db.query(DbSession).filter(DbSession.id == session_id).first()
        if row is not None:
            if auth_disabled() or row.owner == owner:
                return
            raise SnapshotError("chat is no longer available for this workspace snapshot")
    finally:
        db.close()

    # Preserve the existing no-DB ghost-session behavior for callers that
    # already have an owned in-memory chat.
    from core.models import get_session_manager_instance
    manager = get_session_manager_instance()
    ghost = getattr(manager, "sessions", {}).get(session_id) if manager else None
    if ghost is not None and (auth_disabled() or getattr(ghost, "owner", None) == owner):
        return
    raise SnapshotError("chat is no longer available for this workspace snapshot")


def _read_scope_marker(path: Path) -> dict | None:
    try:
        fd = os.open(
            path,
            os.O_RDONLY | os.O_CLOEXEC | os.O_NONBLOCK | getattr(os, "O_NOFOLLOW", 0),
        )
    except FileNotFoundError:
        return None
    except OSError as exc:
        raise SnapshotError("snapshot scope marker is not a safe file") from exc
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > 256:
            raise SnapshotError("snapshot scope marker is not a safe file")
        with os.fdopen(fd, "r", encoding="utf-8", closefd=False) as handle:
            value = json.load(handle)
        if not isinstance(value, dict):
            raise SnapshotError("snapshot scope marker is invalid")
        return value
    except (OSError, ValueError, UnicodeError) as exc:
        raise SnapshotError("snapshot scope marker is invalid") from exc
    finally:
        os.close(fd)


def _store(root: str, owner: str, session_id: str) -> Path:
    _, key = _identity(root, owner, session_id)
    if os.path.lexists(_ROOT) and (os.path.islink(_ROOT) or not os.path.isdir(_ROOT)):
        raise SnapshotError("snapshot storage is not a private directory")
    _ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
    try: os.chmod(_ROOT, 0o700)
    except OSError: pass
    path = _ROOT / key
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.is_symlink() or not path.is_dir():
        raise SnapshotError("snapshot storage is not a private directory")
    try:
        os.chmod(path, 0o700)
    except OSError:
        pass
    marker_path = path / _SCOPE_FILE
    marker = _read_scope_marker(marker_path)
    scope = _session_scope(owner, session_id)
    if marker is None:
        _write_json(marker_path, {"scope": scope})
    elif marker.get("scope") != scope:
        raise SnapshotError("snapshot scope does not match this chat")
    return path


def delete_session_snapshots(owner: str, session_id: str) -> int:
    """Remove tagged snapshots for exactly one deleted owner/chat pair."""
    if not isinstance(owner, str) or not owner.strip() or not isinstance(session_id, str) or not session_id.strip():
        return 0
    scope = _session_scope(owner, session_id)
    with _LOCK:
        if not _ROOT.exists():
            return 0
        if _ROOT.is_symlink() or not _ROOT.is_dir():
            raise SnapshotError("snapshot storage is not a private directory")
        deleted = 0
        with os.scandir(_ROOT) as entries:
            for entry in entries:
                if not re.fullmatch(r"[0-9a-f]{64}", entry.name) or not entry.is_dir(follow_symlinks=False):
                    continue
                directory = Path(entry.path)
                try:
                    marker = _read_scope_marker(directory / _SCOPE_FILE)
                except SnapshotError:
                    continue
                if marker and marker.get("scope") == scope:
                    shutil.rmtree(directory)
                    deleted += 1
        return deleted


def _safe_rel(path: str) -> str:
    if not isinstance(path, str) or not path or os.path.isabs(path):
        raise SnapshotError("invalid snapshot path")
    parts = Path(path).parts
    if any(p in {"", ".", ".."} for p in parts) or _excluded_rel(path):
        raise SnapshotError("excluded snapshot path")
    return Path(*parts).as_posix()


def _excluded_rel(path: str) -> bool:
    parts = Path(path).parts
    leaf = parts[-1].lower() if parts else ""
    return leaf.endswith((".pem", ".p12", ".pfx", ".key", ".keystore")) or any(
        part.lower() in _EXCLUDED_NAMES
        or part.lower().startswith(".env")
        or part.lower() in {"secrets", "credentials", "private_keys"}
        or part.lower() in _EXCLUDED_DIRS
        for part in parts
    )


def _supports_safe_restore() -> bool:
    required = (os.open, os.stat, os.unlink, os.mkdir, os.rename)
    return (
        os.name == "posix" and hasattr(os, "O_NOFOLLOW") and hasattr(os, "O_DIRECTORY")
        and hasattr(os, "fwalk") and all(fn in os.supports_dir_fd for fn in required)
        and os.stat in os.supports_follow_symlinks
    )


def _open_root_fd(root: str) -> int:
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
    fd = os.open(os.path.sep, flags)
    try:
        for part in Path(os.path.abspath(root)).parts[1:]:
            child = os.open(part, flags, dir_fd=fd)
            os.close(fd)
            fd = child
        return fd
    except OSError as exc:
        os.close(fd)
        if exc.errno in {errno.ELOOP, errno.ENOTDIR, errno.ENOENT}:
            raise SnapshotError("workspace is no longer a safe directory") from exc
        raise


def _open_parent_fd(root_fd: int, rel: str, *, create: bool = False) -> tuple[int, str]:
    parts = _safe_rel(rel).split("/")
    fd = os.dup(root_fd)
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
    try:
        for part in parts[:-1]:
            try:
                child = os.open(part, flags, dir_fd=fd)
            except FileNotFoundError:
                if not create:
                    raise SnapshotError("restore path is no longer safe")
                try:
                    os.mkdir(part, 0o700, dir_fd=fd)
                except FileExistsError:
                    pass
                child = os.open(part, flags, dir_fd=fd)
            os.close(fd)
            fd = child
        return fd, parts[-1]
    except OSError as exc:
        os.close(fd)
        if exc.errno in {errno.ELOOP, errno.ENOTDIR, errno.ENOENT}:
            raise SnapshotError("restore path is no longer safe") from exc
        raise
    except SnapshotError:
        os.close(fd)
        raise


def _read_regular_at(parent_fd: int, name: str) -> bytes | None:
    try:
        fd = os.open(
            name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC,
            dir_fd=parent_fd,
        )
    except FileNotFoundError:
        return None
    except OSError as exc:
        if exc.errno in {errno.ELOOP, errno.ENOTDIR}:
            raise SnapshotError("restore path is no longer safe") from exc
        raise
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink > 1:
            raise SnapshotError("restore path is no longer safe")
        with os.fdopen(fd, "rb", closefd=False) as handle:
            data = handle.read(_MAX_FILE_BYTES + 1)
        if len(data) > _MAX_FILE_BYTES:
            raise SnapshotError("restore path changed during restore")
        return data
    finally:
        os.close(fd)


def _tree_and_modes(root: str, root_fd: int | None = None) -> tuple[dict[str, bytes], dict[str, int]]:
    """Read a workspace tree without following links when dir-fd APIs exist."""
    from src.tool_execution import _is_sensitive_path

    def onerror(exc: OSError) -> None:
        raise SnapshotError("workspace could not be read during snapshot") from exc

    files: dict[str, bytes] = {}
    modes: dict[str, int] = {}
    total = 0
    if not _supports_safe_restore():
        for current, dirs, names in os.walk(root, topdown=True, onerror=onerror, followlinks=False):
            dirs[:] = sorted(d for d in dirs if d.lower() not in _EXCLUDED_DIRS and not d.startswith("."))
            for name in sorted(names):
                raw_rel = os.path.relpath(os.path.join(current, name), root)
                if _excluded_rel(raw_rel):
                    continue
                rel = _safe_rel(raw_rel)
                full = os.path.join(current, name)
                if _is_sensitive_path(full):
                    continue
                try:
                    mode = os.lstat(full).st_mode
                    if not stat.S_ISREG(mode) or os.stat(full).st_nlink > 1:
                        continue
                    size = os.path.getsize(full)
                    if size > _MAX_FILE_BYTES or total + size > _MAX_TOTAL_BYTES:
                        raise SnapshotError("workspace exceeds snapshot size limit")
                    if len(files) >= _MAX_FILES:
                        raise SnapshotError("workspace exceeds snapshot file limit")
                    with open(full, "rb") as handle:
                        data = handle.read(_MAX_FILE_BYTES + 1)
                    if len(data) != size or len(data) > _MAX_FILE_BYTES:
                        raise SnapshotError("workspace changed during snapshot")
                except FileNotFoundError as exc:
                    raise SnapshotError("workspace changed during snapshot") from exc
                if size > _MAX_FILE_BYTES or total + size > _MAX_TOTAL_BYTES:
                    raise SnapshotError("workspace exceeds snapshot size limit")
                if len(files) >= _MAX_FILES:
                    raise SnapshotError("workspace exceeds snapshot file limit")
                files[rel] = data
                modes[rel] = stat.S_IMODE(mode) & 0o777
                total += size
        return files, modes

    own_fd = root_fd is None
    root_fd = _open_root_fd(root) if own_fd else root_fd
    try:
        for current, dirs, names, dir_fd in os.fwalk(
            ".", topdown=True, onerror=onerror, follow_symlinks=False, dir_fd=root_fd
        ):
            dirs[:] = sorted(d for d in dirs if d.lower() not in _EXCLUDED_DIRS and not d.startswith("."))
            prefix = "" if current == "." else current.removeprefix("./")
            for name in sorted(names):
                raw_rel = f"{prefix}/{name}" if prefix else name
                if _excluded_rel(raw_rel):
                    continue
                rel = _safe_rel(raw_rel)
                full = os.path.join(root, *rel.split("/"))
                if _is_sensitive_path(full):
                    continue
                try:
                    info = os.stat(name, dir_fd=dir_fd, follow_symlinks=False)
                    if not stat.S_ISREG(info.st_mode) or info.st_nlink > 1:
                        continue
                    size = info.st_size
                    if size > _MAX_FILE_BYTES or total + size > _MAX_TOTAL_BYTES:
                        raise SnapshotError("workspace exceeds snapshot size limit")
                    if len(files) >= _MAX_FILES:
                        raise SnapshotError("workspace exceeds snapshot file limit")
                    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=dir_fd)
                    try:
                        info = os.fstat(fd)
                        if not stat.S_ISREG(info.st_mode) or info.st_nlink > 1:
                            continue
                        size = info.st_size
                        with os.fdopen(fd, "rb", closefd=False) as handle:
                            data = handle.read(_MAX_FILE_BYTES + 1)
                    finally:
                        os.close(fd)
                except FileNotFoundError as exc:
                    raise SnapshotError("workspace changed during snapshot") from exc
                except OSError as exc:
                    if exc.errno in {errno.ELOOP, errno.ENOTDIR}:
                        raise SnapshotError("workspace changed during snapshot") from exc
                    raise
                if len(data) != size or len(data) > _MAX_FILE_BYTES:
                    raise SnapshotError("workspace changed during snapshot")
                files[rel] = data
                modes[rel] = stat.S_IMODE(info.st_mode) & 0o777
                total += size
        return files, modes
    finally:
        if own_fd:
            os.close(root_fd)


def _tree(root: str) -> dict[str, bytes]:
    return _tree_and_modes(root)[0]


def _file_modes(root: str, files: dict[str, bytes]) -> dict[str, int]:
    current, modes = _tree_and_modes(root)
    if current.keys() != files.keys():
        raise SnapshotError("workspace changed during snapshot")
    return modes


def _digest(files: dict[str, bytes], modes: dict[str, int] | None = None) -> str:
    h = hashlib.sha256()
    for name, data in sorted(files.items()):
        h.update(name.encode("utf-8", "surrogateescape")); h.update(b"\0")
        h.update(hashlib.sha256(data).digest())
        if modes is not None:
            h.update(f"{modes.get(name, 0o644):04o}".encode())
    return h.hexdigest()


def _read_manifest(directory: Path, snapshot_id: str, key: str) -> dict:
    if not re.fullmatch(r"[0-9a-f]{32}", str(snapshot_id or "")):
        raise SnapshotError("snapshot not found")
    try:
        with open(directory / f"{snapshot_id}.json", "r", encoding="utf-8") as f:
            record = json.load(f)
    except (OSError, ValueError):
        raise SnapshotError("snapshot not found")
    if record.get("key") != key or record.get("id") != snapshot_id:
        raise SnapshotError("snapshot not found")
    return record


def _write_json(path: Path, data: dict) -> None:
    fd, temp = tempfile.mkstemp(prefix=".snapshot-", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, separators=(",", ":"))
            f.flush(); os.fsync(f.fileno())
        os.chmod(temp, 0o600)
        os.replace(temp, path)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def _capture_snapshot(root: str, directory: Path, key: str,
                      label: str | None, turn_id: str | None) -> dict:
    try: os.chmod(_ROOT, 0o700)
    except OSError: pass
    files, modes = _tree_and_modes(root)
    return _save_snapshot(directory, key, files, modes, label, turn_id)


def create_snapshot(workspace: str, owner: str, session_id: str, label: str | None = None,
                    turn_id: str | None = None, *, validate_scope=None) -> dict:
    """Capture bounded regular files; symlinks, hidden dirs, and dependencies are skipped."""
    root, key = _identity(workspace, owner, session_id)
    with _LOCK:
        if validate_scope:
            validate_scope()
        directory = _store(root, owner, session_id)
        return _capture_snapshot(root, directory, key, label, turn_id)


def _save_snapshot(directory: Path, key: str, files: dict[str, bytes], modes: dict[str, int],
                   label: str | None, turn_id: str | None = None) -> dict:
    records = []
    for path in directory.glob("[0-9a-f]" * 32 + ".json"):
        try:
            existing = json.loads(path.read_text(encoding="utf-8"))
            if existing.get("key") == key:
                records.append((str(existing.get("created_at") or ""), path))
        except (OSError, ValueError):
            records.append(("", path))
    snapshot_id = uuid.uuid4().hex
    record = {
        "id": snapshot_id, "key": key, "created_at": datetime.now(timezone.utc).isoformat(),
        "label": str(label or "")[:120], "turn_id": str(turn_id or "")[:160], "revision": _digest(files, modes),
        "files": {name: base64.b64encode(data).decode("ascii") for name, data in files.items()},
        "modes": modes,
    }
    _write_json(directory / f"{snapshot_id}.json", record)
    records.sort(key=lambda item: item[0])
    for _, old in records[:-(_MAX_SNAPSHOTS - 1)]:
        try: old.unlink()
        except OSError: pass
    return {k: record[k] for k in ("id", "created_at", "label", "revision")}


def ensure_snapshot(workspace: str, owner: str, session_id: str, turn_id: str,
                    *, validate_scope=None) -> dict:
    """Create one automatic pre-write checkpoint per agent turn."""
    if not isinstance(turn_id, str) or not turn_id.strip():
        raise SnapshotError("turn id is required for an automatic checkpoint")
    root, key = _identity(workspace, owner, session_id)
    with _LOCK:
        if validate_scope:
            validate_scope()
        directory = _store(root, owner, session_id)
        for path in directory.glob("[0-9a-f]" * 32 + ".json"):
            try:
                record = json.loads(path.read_text(encoding="utf-8"))
                if record.get("key") == key and record.get("turn_id") == turn_id:
                    return {k: record[k] for k in ("id", "created_at", "label", "revision")}
            except (OSError, ValueError, KeyError):
                continue
        return _capture_snapshot(root, directory, key, "Before agent tools", turn_id)


def list_snapshots(workspace: str, owner: str, session_id: str, *, validate_scope=None) -> list[dict]:
    root, key = _identity(workspace, owner, session_id)
    with _LOCK:
        if validate_scope:
            validate_scope()
        directory = _store(root, owner, session_id)
        out = []
        for path in directory.glob("[0-9a-f]" * 32 + ".json"):
            try:
                record = json.loads(path.read_text(encoding="utf-8"))
                if record.get("key") == key and record.get("id") == path.stem:
                    out.append({k: record.get(k) for k in ("id", "created_at", "label", "revision")})
            except (OSError, ValueError):
                continue
        return sorted(out, key=lambda x: x["created_at"] or "", reverse=True)


def preview_snapshot(workspace: str, owner: str, session_id: str, snapshot_id: str,
                     *, validate_scope=None) -> dict:
    root, key = _identity(workspace, owner, session_id)
    with _LOCK:
        if validate_scope:
            validate_scope()
        directory = _store(root, owner, session_id)
        record = _read_manifest(directory, snapshot_id, key)
        saved = {name: base64.b64decode(value, validate=True) for name, value in record.get("files", {}).items()}
        saved_modes = {name: int(mode) & 0o777 for name, mode in record.get("modes", {}).items()}
        current, current_modes = _tree_and_modes(root)
        changes = []
        preview_budget = _MAX_PREVIEW_BYTES
        for name in sorted(saved.keys() | current.keys()):
            before, after = current.get(name), saved.get(name)
            mode_changed = (before is not None and after is not None
                            and current_modes.get(name, 0o644) != saved_modes.get(name, 0o644))
            if before == after and not mode_changed:
                continue
            mode_diff = (
                f"mode {current_modes[name]:04o} -> {saved_modes.get(name, 0o644):04o}"
                if mode_changed else ""
            )
            if mode_diff:
                preview_budget = max(0, preview_budget - len(mode_diff))
            status = "added" if before is None else "deleted" if after is None else "modified"
            def display(data):
                if data is None: return None
                try: return data.decode("utf-8")[:40000]
                except UnicodeDecodeError: return None
            diff = ""
            if preview_budget:
                left, right = display(before), display(after)
                if (before is None or left is not None) and (after is None or right is not None):
                    raw_diff = "".join(difflib.unified_diff(
                        (left or "")[:12000].splitlines(True), (right or "")[:12000].splitlines(True),
                        fromfile=f"current/{name}", tofile=f"snapshot/{name}",
                    ))
                    diff = raw_diff[:min(8000, preview_budget)]
                    preview_budget -= len(diff)
            if mode_diff:
                diff = f"{diff}\n{mode_diff}" if diff else mode_diff
            changes.append({
                "path": name, "status": status,
                "current_hash": hashlib.sha256(before).hexdigest() if before is not None else None,
                "snapshot_hash": hashlib.sha256(after).hexdigest() if after is not None else None,
                "diff": diff,
            })
        revision = _digest(current, current_modes)
        return {"snapshot": {k: record[k] for k in ("id", "created_at", "label")}, "revision": revision, "changes": changes}


def restore_snapshot(workspace: str, owner: str, session_id: str, snapshot_id: str,
                     expected_revision: str, *, validate_scope=None) -> dict:
    """Restore a whole snapshot only if the current workspace matches its preview."""
    if not _supports_safe_restore():
        raise SnapshotError("safe snapshot restore is unavailable on this platform")
    root, key = _identity(workspace, owner, session_id)
    with _LOCK:
        if validate_scope:
            validate_scope()
        directory = _store(root, owner, session_id)
        record = _read_manifest(directory, snapshot_id, key)
        root_fd = _open_root_fd(root)
        try:
            current, current_modes = _tree_and_modes(root, root_fd)
            revision = _digest(current, current_modes)
            if not expected_revision or revision != expected_revision:
                raise SnapshotError("workspace changed after preview; review again")
            target = {
                _safe_rel(name): base64.b64decode(value, validate=True)
                for name, value in record.get("files", {}).items()
            }
            target_modes = {
                _safe_rel(name): int(mode) & 0o777
                for name, mode in record.get("modes", {}).items()
            }
            removals = sorted(current.keys() - target.keys(), reverse=True)
            writes = sorted(target.items())
            # Open or create every parent without following links before mutation.
            for name in removals:
                parent_fd, leaf = _open_parent_fd(root_fd, name)
                try:
                    if _read_regular_at(parent_fd, leaf) != current[name]:
                        raise SnapshotError("workspace changed after preview; review again")
                finally:
                    os.close(parent_fd)
            for name, _ in writes:
                parent_fd, leaf = _open_parent_fd(root_fd, name, create=True)
                try:
                    if _read_regular_at(parent_fd, leaf) != current.get(name):
                        raise SnapshotError("workspace changed after preview; review again")
                finally:
                    os.close(parent_fd)
            fresh, fresh_modes = _tree_and_modes(root, root_fd)
            if _digest(fresh, fresh_modes) != expected_revision:
                raise SnapshotError("workspace changed after preview; review again")
            rollback = _save_snapshot(directory, key, current, current_modes, "Before restore")

            try:
                for name in removals:
                    parent_fd, leaf = _open_parent_fd(root_fd, name)
                    try:
                        if _read_regular_at(parent_fd, leaf) != current[name]:
                            raise SnapshotError("workspace changed during restore; review again")
                        os.unlink(leaf, dir_fd=parent_fd)
                    finally:
                        os.close(parent_fd)
                for name, data in writes:
                    parent_fd, leaf = _open_parent_fd(root_fd, name, create=True)
                    try:
                        if _read_regular_at(parent_fd, leaf) != current.get(name):
                            raise SnapshotError("workspace changed during restore; review again")
                        temporary = f".restore-{uuid.uuid4().hex}"
                        fd = os.open(
                            temporary,
                            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                            0o600,
                            dir_fd=parent_fd,
                        )
                        try:
                            with os.fdopen(fd, "wb", closefd=False) as handle:
                                handle.write(data)
                                handle.flush()
                                os.fsync(fd)
                            os.fchmod(fd, target_modes.get(name, 0o644) & 0o777)
                            os.rename(temporary, leaf, src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
                        finally:
                            os.close(fd)
                            try: os.unlink(temporary, dir_fd=parent_fd)
                            except FileNotFoundError: pass
                    finally:
                        os.close(parent_fd)
            except Exception as exc:
                raise SnapshotRestoreError(
                    f"restore failed; inspect workspace and use rollback snapshot {rollback['id']} if needed",
                    rollback["id"],
                ) from exc
        finally:
            os.close(root_fd)
        return {"restored": snapshot_id, "rollback_snapshot_id": rollback["id"]}
