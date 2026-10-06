"""Small, owner-scoped snapshots for explicitly granted workspaces."""
from __future__ import annotations

import difflib
import base64
import hashlib
import json
import os
import re
import stat
import tempfile
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path

from src.constants import DATA_DIR

_ROOT = Path(DATA_DIR) / "workspace_snapshots"
_MAX_FILES = 2_000
_MAX_FILE_BYTES = 2 * 1024 * 1024
_MAX_TOTAL_BYTES = 20 * 1024 * 1024
_MAX_SNAPSHOTS = 20
_MAX_PREVIEW_BYTES = 512 * 1024
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
    return path


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


def _safe_target(root: str, rel: str, *, create: bool = False) -> str:
    """Resolve a path while refusing symlink/special-file parents."""
    parts = _safe_rel(rel).split("/")
    current = root
    for index, part in enumerate(parts[:-1]):
        current = os.path.join(current, part)
        try:
            mode = os.lstat(current).st_mode
            if not stat.S_ISDIR(mode):
                raise SnapshotError("restore path is no longer safe")
        except FileNotFoundError:
            if not create:
                return os.path.join(current, *parts[index + 1:])
            os.mkdir(current, 0o700)
    full = os.path.join(root, *parts)
    try:
        mode = os.lstat(full).st_mode
        if not stat.S_ISREG(mode) or os.stat(full).st_nlink > 1:
            raise SnapshotError("restore path is no longer safe")
    except FileNotFoundError:
        pass
    return full


def _tree(root: str) -> dict[str, bytes]:
    from src.tool_execution import _is_sensitive_path
    files: dict[str, bytes] = {}
    total = 0
    for current, dirs, names in os.walk(root, topdown=True, followlinks=False):
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
                if not stat.S_ISREG(mode):
                    continue
                if mode & 0o170000 != stat.S_IFREG or os.stat(full).st_nlink > 1:
                    continue
                size = os.path.getsize(full)
                if size > _MAX_FILE_BYTES or total + size > _MAX_TOTAL_BYTES:
                    raise SnapshotError("workspace exceeds snapshot size limit")
                if len(files) >= _MAX_FILES:
                    raise SnapshotError("workspace exceeds snapshot file limit")
                with open(full, "rb") as f:
                    data = f.read(_MAX_FILE_BYTES + 1)
                if len(data) != size or len(data) > _MAX_FILE_BYTES:
                    raise SnapshotError("workspace changed during snapshot")
                files[rel] = data
                total += size
            except FileNotFoundError:
                raise SnapshotError("workspace changed during snapshot")
    return files


def _file_modes(root: str, files: dict[str, bytes]) -> dict[str, int]:
    modes = {}
    for name in files:
        mode = os.lstat(os.path.join(root, *_safe_rel(name).split("/"))).st_mode
        if not stat.S_ISREG(mode):
            raise SnapshotError("workspace changed during snapshot")
        modes[name] = stat.S_IMODE(mode) & 0o777
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


def create_snapshot(workspace: str, owner: str, session_id: str, label: str | None = None, turn_id: str | None = None) -> dict:
    """Capture bounded regular files; symlinks, hidden dirs, and dependencies are skipped."""
    root, key = _identity(workspace, owner, session_id)
    with _LOCK:
        directory = _store(root, owner, session_id)
        try: os.chmod(_ROOT, 0o700)
        except OSError: pass
        files = _tree(root)
        modes = _file_modes(root, files)
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


def ensure_snapshot(workspace: str, owner: str, session_id: str, turn_id: str) -> dict:
    """Create one automatic pre-write checkpoint per agent turn."""
    if not isinstance(turn_id, str) or not turn_id.strip():
        raise SnapshotError("turn id is required for an automatic checkpoint")
    root, key = _identity(workspace, owner, session_id)
    with _LOCK:
        directory = _store(root, owner, session_id)
        for path in directory.glob("[0-9a-f]" * 32 + ".json"):
            try:
                record = json.loads(path.read_text(encoding="utf-8"))
                if record.get("key") == key and record.get("turn_id") == turn_id:
                    return {k: record[k] for k in ("id", "created_at", "label", "revision")}
            except (OSError, ValueError, KeyError):
                continue
        return create_snapshot(root, owner, session_id, "Before agent tools", turn_id)


def list_snapshots(workspace: str, owner: str, session_id: str) -> list[dict]:
    root, key = _identity(workspace, owner, session_id)
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


def preview_snapshot(workspace: str, owner: str, session_id: str, snapshot_id: str) -> dict:
    root, key = _identity(workspace, owner, session_id)
    directory = _store(root, owner, session_id)
    with _LOCK:
        record = _read_manifest(directory, snapshot_id, key)
        saved = {name: base64.b64decode(value, validate=True) for name, value in record.get("files", {}).items()}
        saved_modes = {name: int(mode) & 0o777 for name, mode in record.get("modes", {}).items()}
        current = _tree(root)
        current_modes = _file_modes(root, current)
        changes = []
        preview_budget = _MAX_PREVIEW_BYTES
        for name in sorted(saved.keys() | current.keys()):
            before, after = current.get(name), saved.get(name)
            mode_changed = (before is not None and after is not None
                            and current_modes.get(name, 0o644) != saved_modes.get(name, 0o644))
            if before == after and not mode_changed:
                continue
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
            if mode_changed and not diff:
                diff = f"mode {current_modes[name]:04o} -> {saved_modes.get(name, 0o644):04o}"
                preview_budget = max(0, preview_budget - len(diff))
            changes.append({
                "path": name, "status": status,
                "current_hash": hashlib.sha256(before).hexdigest() if before is not None else None,
                "snapshot_hash": hashlib.sha256(after).hexdigest() if after is not None else None,
                "diff": diff,
            })
        revision = _digest(current, current_modes)
        return {"snapshot": {k: record[k] for k in ("id", "created_at", "label")}, "revision": revision, "changes": changes}


def restore_snapshot(workspace: str, owner: str, session_id: str, snapshot_id: str, expected_revision: str) -> dict:
    """Restore a whole snapshot only if the current workspace matches its preview."""
    root, key = _identity(workspace, owner, session_id)
    directory = _store(root, owner, session_id)
    with _LOCK:
        record = _read_manifest(directory, snapshot_id, key)
        current = _tree(root)
        current_modes = _file_modes(root, current)
        revision = _digest(current, current_modes)
        if not expected_revision or revision != expected_revision:
            raise SnapshotError("workspace changed after preview; review again")
        target = {name: base64.b64decode(value, validate=True) for name, value in record.get("files", {}).items()}
        target_modes = {name: int(mode) & 0o777 for name, mode in record.get("modes", {}).items()}
        rollback = create_snapshot(root, owner, session_id, "Before restore")
        # Validate the complete operation before changing any workspace file.
        removals = []
        for name in sorted(current.keys() - target.keys(), reverse=True):
            full = _safe_target(root, name)
            removals.append(full)
        writes = [(name, data, _safe_target(root, name, create=True)) for name, data in target.items()]
        fresh = _tree(root)
        if _digest(fresh, _file_modes(root, fresh)) != expected_revision:
            raise SnapshotError("workspace changed after preview; review again")
        try:
            for full in removals:
                name = os.path.relpath(full, root).replace(os.sep, "/")
                if _safe_target(root, name) != full or _read_regular(full) != current[name]:
                    raise SnapshotError("workspace changed during restore; review again")
                os.unlink(full)
            for name, data, full in writes:
                if _safe_target(root, name, create=True) != full:
                    raise SnapshotError("restore path is no longer safe")
                actual = _read_regular(full) if os.path.exists(full) else None
                if actual != current.get(name):
                    raise SnapshotError("workspace changed during restore; review again")
                fd, temp = tempfile.mkstemp(prefix=".restore-", dir=os.path.dirname(full))
                try:
                    with os.fdopen(fd, "wb") as f:
                        f.write(data); f.flush(); os.fsync(f.fileno())
                    os.chmod(temp, target_modes.get(name, 0o644) & 0o777)
                    os.replace(temp, full)
                finally:
                    if os.path.exists(temp): os.unlink(temp)
        except Exception as exc:
            raise SnapshotRestoreError(
                f"restore failed; inspect workspace and use rollback snapshot {rollback['id']} if needed",
                rollback["id"],
            ) from exc
        return {"restored": snapshot_id, "rollback_snapshot_id": rollback["id"]}


def _read_regular(path: str) -> bytes:
    try:
        if not stat.S_ISREG(os.lstat(path).st_mode):
            raise SnapshotError("restore path is no longer safe")
        with open(path, "rb") as f:
            return f.read(_MAX_FILE_BYTES + 1)
    except FileNotFoundError:
        return None
