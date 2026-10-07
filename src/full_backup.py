"""Create and safely stage full local-instance backups."""

from __future__ import annotations

import errno
import json
import os
import shutil
import sqlite3
import stat
import subprocess
import sys
import tempfile
import threading
import time
import uuid
import zipfile
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath

from src.constants import DATA_DIR

FORMAT_VERSION = 1
MANIFEST = "odysseus-backup.json"
MAX_ARCHIVE_BYTES = 20 * 1024**3
MAX_UNPACKED_BYTES = 40 * 1024**3
MAX_FILES = 200_000
MAX_COMPRESSION_RATIO = 1000
SKIP_DIRS = {
    "tmp", "temp", "cache", "caches", ".cache", "emoji_cache",
    "tts_cache", "email_urgency_cache", "fastembed_cache", "model_cache",
    "models", "ollama", "huggingface", "transformers", "logs",
    # Service-owned persistence can be live while the app restarts; Docker
    # volumes are outside DATA_DIR and are never part of this archive.
    "chroma", "searxng", "ntfy",
}

_DISCARD_ON_RESTORE = {"tmp", "temp"}
_RESTORE_STAGE_LOCK = threading.Lock()


def _is_sqlite(path: Path) -> bool:
    return path.suffix.lower() in {".db", ".sqlite", ".sqlite3"} and not path.name.endswith(("-wal", "-shm", "-journal"))


def _skip_path(relative: Path) -> bool:
    return (
        any(part in SKIP_DIRS or part.startswith(".odysseus-restore-") for part in relative.parts)
        or relative.name.lower().endswith((".lock", ".lck", ".pid", ".sock", "-wal", "-shm", "-journal"))
    )


def _raise_walk_error(error: OSError) -> None:
    raise error


_SQLITE_SNAPSHOT_TIMEOUT = 180
_SQLITE_SNAPSHOT_WORKER = r"""
import os, sqlite3, stat, sys
from pathlib import Path

def _identity(fd):
    info = os.fstat(fd)
    return info.st_dev, info.st_ino

def _fd_snapshot(directory_fd):
    result = {}
    for name in os.listdir(directory_fd):
        try:
            fd = int(name)
            result[fd] = (_identity(fd), os.readlink('/proc/self/fd/' + name))
        except (OSError, ValueError):
            continue
    return result

def _sidecar_matches(fd, expected, parent_fd, name, allow_empty):
    opened = os.fstat(fd)
    try:
        linked = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    except OSError:
        return False
    identity = (opened.st_dev, opened.st_ino)
    if not stat.S_ISREG(linked.st_mode) or linked.st_nlink != 1:
        return False
    if identity != (linked.st_dev, linked.st_ino):
        return False
    if expected is not None and identity != expected:
        return False
    if expected is not None:
        return True
    return not allow_empty or opened.st_size == 0

def _sidecar(path, suffix):
    path = path.removesuffix(' (deleted)')
    return path.rsplit('/', 1)[-1].endswith(suffix)

def main():
    source_fd, wal_fd, shm_fd, parent_fd = map(int, sys.argv[1:5])
    wal_name, shm_name = sys.argv[5:7]
    destination = sys.argv[7]
    expected_source = (int(sys.argv[8]), int(sys.argv[9]))
    expected_wal = None if wal_fd < 0 else (int(sys.argv[10]), int(sys.argv[11]))
    expected_shm = None if shm_fd < 0 else (int(sys.argv[12]), int(sys.argv[13]))
    if _identity(source_fd) != expected_source:
        return 2
    try:
        main_entry = os.stat(sys.argv[14], dir_fd=parent_fd, follow_symlinks=False)
    except OSError:
        return 2
    if (not stat.S_ISREG(main_entry.st_mode)
            or (main_entry.st_dev, main_entry.st_ino) != expected_source):
        return 2
    if expected_wal is not None and _identity(wal_fd) != expected_wal:
        return 3
    if expected_shm is not None and _identity(shm_fd) != expected_shm:
        return 4

    proc_fd_dir = os.open('/proc/self/fd', os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    source = destination_db = None
    try:
        before = _fd_snapshot(proc_fd_dir)
        uri = (Path('/proc/self/fd') / str(source_fd)).as_uri() + '?mode=ro'
        source = sqlite3.connect(uri, uri=True, timeout=30)
        source.execute('BEGIN')
        source.execute('SELECT name FROM sqlite_master LIMIT 0').fetchall()
        journal_mode = source.execute('PRAGMA journal_mode').fetchone()[0].lower()
        after = _fd_snapshot(proc_fd_dir)
        new_fds = {fd: value for fd, value in after.items() if fd not in before}

        main_matches = [value for value in new_fds.values() if value[0] == expected_source]
        if len(main_matches) != 1:
            return 5
        wal_fds = []
        shm_fds = []
        for fd, value in new_fds.items():
            if value[0] == expected_source:
                continue
            if _sidecar(value[1], '-wal'):
                if not _sidecar_matches(fd, expected_wal, parent_fd, wal_name, True):
                    return 6
                wal_fds.append(value)
            elif _sidecar(value[1], '-shm'):
                if not _sidecar_matches(fd, expected_shm, parent_fd, shm_name, False):
                    return 7
                shm_fds.append(value)
            else:
                try:
                    regular = stat.S_ISREG(os.fstat(fd).st_mode)
                except OSError:
                    regular = False
                if regular:
                    return 9
        if journal_mode == 'wal' and expected_wal is not None and not any(
            value[0] == expected_wal for value in wal_fds
        ):
            return 6

        destination_db = sqlite3.connect(destination, timeout=30)
        source.backup(destination_db)
        return 0
    except BaseException:
        return 8
    finally:
        if destination_db is not None:
            destination_db.close()
        if source is not None:
            source.close()
        os.close(proc_fd_dir)

sys.exit(main())
"""


def _snapshot_sqlite(
    source: Path, destination: Path, source_fd: int,
    wal_fd: int | None = None, shm_fd: int | None = None,
    parent_fd: int | None = None,
) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    proc_fd = Path("/proc/self/fd")
    if not proc_fd.is_dir():
        raise OSError(errno.ENOTSUP, "safe SQLite backup requires /proc/self/fd")
    source_stat = os.fstat(source_fd)
    if parent_fd is None:
        raise sqlite3.OperationalError("SQLite snapshot requires a pinned source directory")
    wal_stat = os.fstat(wal_fd) if wal_fd is not None else None
    shm_stat = os.fstat(shm_fd) if shm_fd is not None else None
    pass_fds = tuple(fd for fd in (source_fd, wal_fd, shm_fd, parent_fd) if fd is not None)
    try:
        result = subprocess.run(
            [
                sys.executable, "-I", "-c", _SQLITE_SNAPSHOT_WORKER,
                str(source_fd), str(wal_fd if wal_fd is not None else -1),
                str(shm_fd if shm_fd is not None else -1), str(parent_fd),
                source.name + "-wal", source.name + "-shm", str(destination),
                str(source_stat.st_dev), str(source_stat.st_ino),
                str(wal_stat.st_dev if wal_stat else -1),
                str(wal_stat.st_ino if wal_stat else -1),
                str(shm_stat.st_dev if shm_stat else -1),
                str(shm_stat.st_ino if shm_stat else -1),
                source.name,
            ],
            pass_fds=pass_fds,
            close_fds=True,
            timeout=_SQLITE_SNAPSHOT_TIMEOUT,
            capture_output=True,
            text=True,
        )
    except subprocess.TimeoutExpired as exc:
        raise sqlite3.OperationalError(
            "SQLite snapshot timed out; stop concurrent database writes or file moves and retry."
        ) from exc
    if result.returncode:
        raise sqlite3.DatabaseError(
            "SQLite snapshot failed identity verification or database validation; "
            "stop concurrent file moves and retry."
        )


def _open_optional_backup_file(root_fd: int, relative: Path) -> int | None:
    try:
        return _open_backup_file(root_fd, relative)
    except FileNotFoundError:
        return None


def _open_backup_root(root: Path) -> int:
    """Pin the resolved data root without following a swapped path component."""
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
    fd = os.open(os.path.sep, flags)
    try:
        for part in root.parts[1:]:
            child = os.open(part, flags, dir_fd=fd)
            os.close(fd)
            fd = child
        return fd
    except BaseException:
        os.close(fd)
        raise


def _open_backup_file(root_fd: int, relative: Path) -> int:
    """Open an inventoried file beneath a pinned root, refusing links."""
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
    fd = os.dup(root_fd)
    try:
        for part in relative.parts[:-1]:
            child = os.open(part, flags, dir_fd=fd)
            os.close(fd)
            fd = child
        file_fd = os.open(
            relative.parts[-1],
            os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC,
            dir_fd=fd,
        )
        if not stat.S_ISREG(os.fstat(file_fd).st_mode):
            os.close(file_fd)
            raise ValueError("Backup source is not a regular file")
        return file_fd
    finally:
        os.close(fd)


def _open_backup_directory(root_fd: int, relative: Path) -> int:
    """Open a directory below the pinned backup root without following links."""
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
    fd = os.dup(root_fd)
    try:
        for part in relative.parts:
            child = os.open(part, flags, dir_fd=fd)
            os.close(fd)
            fd = child
        return fd
    except BaseException:
        os.close(fd)
        raise


def _write_backup_file(
    archive: zipfile.ZipFile, source_fd: int, arcname: str, remaining_bytes: int,
) -> int:
    """Stream an already-pinned file into ZIP while retaining file metadata."""
    info = os.fstat(source_fd)
    stamp = time.localtime(info.st_mtime)[:6]
    if stamp < (1980, 1, 1, 0, 0, 0):
        stamp = (1980, 1, 1, 0, 0, 0)
    elif stamp > (2107, 12, 31, 23, 59, 58):
        stamp = (2107, 12, 31, 23, 59, 58)
    member = zipfile.ZipInfo(arcname, stamp)
    member.compress_type = archive.compression
    member.create_system = 3
    member.file_size = info.st_size
    member.external_attr = (stat.S_IFREG | stat.S_IMODE(info.st_mode)) << 16
    copied = 0
    with archive.open(member, "w", force_zip64=info.st_size > zipfile.ZIP64_LIMIT) as output:
        while chunk := os.read(source_fd, 1024 * 1024):
            copied += len(chunk)
            if copied > remaining_bytes:
                raise ValueError("Backup expands beyond the 40 GiB restore limit")
            output.write(chunk)
            if archive.fp.tell() > MAX_ARCHIVE_BYTES:
                raise ValueError("Archive exceeds the 20 GiB upload limit")
    return copied


def create_backup(data_dir: str | Path = DATA_DIR) -> Path:
    """Create ZIP with SQLite snapshots and regular files under data_dir."""
    root = Path(data_dir).resolve()
    if not root.is_dir():
        raise ValueError("Data directory is unavailable")
    safe_fd = (
        os.name == "posix" and hasattr(os, "O_NOFOLLOW")
        and hasattr(os, "O_DIRECTORY") and hasattr(os, "O_CLOEXEC")
        and os.open in os.supports_dir_fd
    )
    if not safe_fd:
        raise OSError(errno.ENOTSUP, "safe backup source reads are unavailable")
    fd, name = tempfile.mkstemp(prefix="odysseus-backup-", suffix=".zip")
    os.close(fd)
    archive_path = Path(name)
    root_fd = None
    try:
        root_fd = _open_backup_root(root) if safe_fd else None
        with tempfile.TemporaryDirectory(prefix="odysseus-sqlite-") as tmp_name:
            tmp = Path(tmp_name)
            sources = []
            staged: dict[Path, Path] = {}
            for directory, directories, filenames in os.walk(
                root, topdown=True, onerror=_raise_walk_error, followlinks=False,
            ):
                directory_path = Path(directory)
                parent_relative = directory_path.relative_to(root)
                directories[:] = [
                    name for name in directories
                    if not (directory_path / name).is_symlink()
                    and not _skip_path(parent_relative / name)
                ]
                for filename in filenames:
                    source = directory_path / filename
                    if source.is_symlink() or not source.is_file():
                        continue
                    relative = source.relative_to(root)
                    if _skip_path(relative):
                        continue
                    if len(sources) + 2 > MAX_FILES:  # include the manifest
                        raise ValueError("Backup has too many entries")
                    sources.append(source)
            for source in sources:
                if not _is_sqlite(source):
                    continue
                relative = source.relative_to(root)
                target = tmp / relative
                source_fd = _open_backup_file(root_fd, relative)
                parent_fd = _open_backup_directory(root_fd, relative.parent)
                wal_fd = shm_fd = None
                try:
                    wal_fd = _open_optional_backup_file(
                        root_fd, relative.with_name(relative.name + "-wal"),
                    )
                    shm_fd = _open_optional_backup_file(
                        root_fd, relative.with_name(relative.name + "-shm"),
                    )
                    _snapshot_sqlite(source, target, source_fd, wal_fd, shm_fd, parent_fd)
                finally:
                    if shm_fd is not None:
                        os.close(shm_fd)
                    if wal_fd is not None:
                        os.close(wal_fd)
                    os.close(parent_fd)
                    os.close(source_fd)
                staged[source] = target

            manifest = {
                "format": "odysseus-full-backup",
                "version": FORMAT_VERSION,
                "scope": "application-data-directory",
                "created_at": datetime.now(timezone.utc).isoformat(),
            }
            with zipfile.ZipFile(archive_path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
                manifest_bytes = json.dumps(manifest, separators=(",", ":")).encode("utf-8")
                archive.writestr(MANIFEST, manifest_bytes)
                unpacked_bytes = len(manifest_bytes)
                for source in sorted(sources):
                    relative = source.relative_to(root)
                    arcname = f"data/{relative.as_posix()}"
                    staged_source = staged.get(source)
                    source_fd = (
                        os.open(staged_source, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
                        if staged_source is not None
                        else _open_backup_file(root_fd, relative)
                    )
                    try:
                        unpacked_bytes += _write_backup_file(
                            archive, source_fd, arcname,
                            MAX_UNPACKED_BYTES - unpacked_bytes,
                        )
                    finally:
                        os.close(source_fd)
        inspect_archive(archive_path)
        return archive_path
    except Exception:
        archive_path.unlink(missing_ok=True)
        raise
    finally:
        if root_fd is not None:
            os.close(root_fd)


def _safe_member(info: zipfile.ZipInfo) -> PurePosixPath:
    name = info.filename
    path = PurePosixPath(name)
    mode = info.external_attr >> 16
    if (not name or "\\" in name or path.is_absolute() or ":" in name
            or ".." in path.parts or not path.parts):
        raise ValueError(f"Unsafe archive path: {name!r}")
    if name == MANIFEST:
        return path
    if path.parts[0] != "data" or (len(path.parts) < 2 and not (info.is_dir() and path.parts == ("data",))):
        raise ValueError(f"Archive entry is outside data/: {name!r}")
    file_type = stat.S_IFMT(mode)
    if stat.S_ISLNK(mode) or (file_type and file_type not in {stat.S_IFREG, stat.S_IFDIR}):
        raise ValueError(f"Archive contains a link or special file: {name!r}")
    if _skip_path(Path(*path.parts[1:])):
        raise ValueError(f"Archive contains excluded runtime data: {name!r}")
    return path


def inspect_archive(archive_path: str | Path) -> dict:
    """Validate archive structure and return a non-secret restore preview."""
    path = Path(archive_path)
    if path.stat().st_size > MAX_ARCHIVE_BYTES:
        raise ValueError("Archive exceeds the 20 GiB upload limit")
    try:
        with zipfile.ZipFile(path) as archive:
            infos = archive.infolist()
            if len(infos) > MAX_FILES:
                raise ValueError("Archive has too many entries")
            total = 0
            names = set()
            manifest = None
            files = []
            for info in infos:
                member = _safe_member(info)
                if member.as_posix() in names:
                    raise ValueError("Archive contains duplicate paths")
                names.add(member.as_posix())
                if info.flag_bits & 1:
                    raise ValueError("Encrypted ZIP entries are unsupported")
                if info.file_size < 0 or info.compress_size < 0:
                    raise ValueError("Archive has invalid entry sizes")
                total += info.file_size
                if total > MAX_UNPACKED_BYTES:
                    raise ValueError("Archive expands beyond the 40 GiB restore limit")
                sqlite_member = Path(member.name).suffix.lower() in {".db", ".sqlite", ".sqlite3"}
                if (not sqlite_member and info.file_size > 1024 * 1024
                        and info.file_size / max(info.compress_size, 1) > MAX_COMPRESSION_RATIO):
                    raise ValueError("Archive compression ratio is unsafe")
                if member.as_posix() == MANIFEST:
                    if info.file_size > 16_384:
                        raise ValueError("Backup manifest is too large")
                    manifest = json.loads(archive.read(info))
                elif not info.is_dir():
                    files.append(member.as_posix())
            if not isinstance(manifest, dict) or manifest.get("format") != "odysseus-full-backup" or manifest.get("version") != FORMAT_VERSION:
                raise ValueError("Unsupported or missing Odysseus backup manifest")
            if not files:
                raise ValueError("Backup contains no data files")
            if not any(name.startswith("data/") for name in files):
                raise ValueError("Backup has no data directory")
            return {
                "format": manifest["format"], "version": manifest["version"],
                "created_at": manifest.get("created_at"), "files": len(files),
                "unpacked_bytes": total,
                "includes_database": any(Path(n).suffix.lower() in {".db", ".sqlite", ".sqlite3"} for n in files),
                "includes_encryption_key": any(Path(n).name in {".app_key", ".key"} for n in files),
            }
    except (zipfile.BadZipFile, OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"Invalid backup archive: {exc}") from exc


def extract_archive(archive_path: str | Path, destination: str | Path) -> dict:
    """Extract validated regular files into destination/data without extractall."""
    preview = inspect_archive(archive_path)
    target_root = Path(destination).resolve()
    try:
        with zipfile.ZipFile(archive_path) as archive:
            for info in archive.infolist():
                member = _safe_member(info)
                if member.as_posix() == MANIFEST:
                    continue
                target = target_root.joinpath(*member.parts)
                if not target.is_relative_to(target_root):
                    raise ValueError("Archive path escaped staging directory")
                if info.is_dir():
                    target.mkdir(parents=True, exist_ok=True, mode=0o700)
                    target.chmod(0o700)
                    continue
                target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                copied = 0
                with archive.open(info) as source, target.open("xb") as output:
                    while chunk := source.read(1024 * 1024):
                        copied += len(chunk)
                        if copied > info.file_size or copied > MAX_UNPACKED_BYTES:
                            raise ValueError("Archive entry expanded beyond its declared size")
                        output.write(chunk)
                if copied != info.file_size:
                    raise ValueError(f"Archive entry size mismatch: {info.filename!r}")
                target.chmod(0o600)
    except (zipfile.BadZipFile, RuntimeError, OSError) as exc:
        raise ValueError(f"Invalid backup archive: {exc}") from exc
    return preview


def validate_extracted_data(data_root: str | Path) -> None:
    """Reject malformed SQLite files before an archive can replace live state."""
    root = Path(data_root)
    for path in root.rglob("*"):
        if path.is_symlink():
            raise ValueError("Restore data contains a symbolic link")
        if path.is_file() and _is_sqlite(path):
            try:
                conn = sqlite3.connect(f"{path.resolve().as_uri()}?mode=ro", uri=True, timeout=10)
                try:
                    result = conn.execute("PRAGMA integrity_check").fetchone()
                finally:
                    conn.close()
            except sqlite3.DatabaseError as exc:
                raise ValueError(f"Backup database is unreadable: {path.name}") from exc
            if not result or result[0] != "ok":
                raise ValueError(f"Backup database failed integrity check: {path.name}")


def stage_restore(archive_path: str | Path, data_dir: str | Path = DATA_DIR) -> dict:
    """Extract to an ignored staging directory and arm the startup restore."""
    with _RESTORE_STAGE_LOCK:
        root = Path(data_dir).resolve()
        root.mkdir(parents=True, exist_ok=True)
        marker = root / ".odysseus-restore-pending.json"
        if marker.exists():
            raise ValueError("A restore is already pending; restart the application first")
        restore_id = uuid.uuid4().hex
        stage = root / f".odysseus-restore-stage-{restore_id}"
        stage.mkdir(mode=0o700)
        try:
            preview = extract_archive(archive_path, stage)
            _write_marker(marker, {"version": 1, "id": restore_id, "status": "pending"})
            return preview
        except Exception:
            shutil.rmtree(stage, ignore_errors=True)
            raise


def _write_marker(marker: Path, data: dict) -> None:
    fd, temporary = tempfile.mkstemp(prefix=".odysseus-restore-marker-", suffix=".tmp", dir=marker.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(data, handle)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, marker)
    finally:
        Path(temporary).unlink(missing_ok=True)


def _control(path: Path) -> bool:
    return path.name.startswith(".odysseus-restore-")


def _preserve_on_restore(name: str) -> bool:
    return name in SKIP_DIRS and name not in _DISCARD_ON_RESTORE


def _remove_path(path: Path) -> None:
    if path.is_dir() and not path.is_symlink():
        shutil.rmtree(path)
    else:
        path.unlink(missing_ok=True)


def _rollback(root: Path, rollback: Path, original_names: list[str]) -> None:
    originals = set(original_names)
    for current in list(root.iterdir()):
        if _control(current):
            continue
        if current.name not in originals or (rollback / current.name).exists():
            _remove_path(current)
    if rollback.exists():
        for old in rollback.iterdir():
            target = root / old.name
            _remove_path(target) if target.exists() or target.is_symlink() else None
            os.replace(old, target)
        rollback.rmdir()


def _return_incoming(root: Path, payload: Path, incoming_names: list[str]) -> None:
    """Put already-installed backup entries back so a failed restore is retryable."""
    payload.mkdir(parents=True, exist_ok=True, mode=0o700)
    for name in incoming_names:
        current = root / name
        staged = payload / name
        if current.exists() or current.is_symlink():
            if not staged.exists() and not staged.is_symlink():
                os.replace(current, staged)


def apply_pending_restore(data_dir: str | Path = DATA_DIR) -> bool:
    """Apply restore before database initialization; rollback on interruption."""
    root = Path(data_dir).resolve()
    marker = root / ".odysseus-restore-pending.json"
    if not marker.exists():
        return False
    state = json.loads(marker.read_text(encoding="utf-8"))
    restore_id = state.get("id", "")
    if len(restore_id) != 32 or any(c not in "0123456789abcdef" for c in restore_id):
        raise ValueError("Invalid pending restore marker")
    stage = root / f".odysseus-restore-stage-{restore_id}"
    rollback = root / f".odysseus-restore-rollback-{restore_id}"
    status = state.get("status")
    if (state.get("version") != 1 or status not in {"pending", "applying", "applied"}
            or (status != "applied" and not stage.is_dir())):
        raise ValueError("Pending restore staging data is missing or invalid")
    if state["status"] == "applying":
        originals = state.get("originals")
        if not isinstance(originals, list) or any(not isinstance(n, str) or "/" in n or "\\" in n for n in originals):
            raise ValueError("Pending restore rollback inventory is invalid")
        incoming = state.get("incoming", [])
        if not isinstance(incoming, list) or any(not isinstance(n, str) or "/" in n or "\\" in n for n in incoming):
            raise ValueError("Pending restore incoming inventory is invalid")
        if state.get("phase") == "installing":
            _return_incoming(root, stage / "data", incoming)
        _rollback(root, rollback, originals)
        state["status"] = "pending"
        state.pop("originals", None)
        state.pop("incoming", None)
        state.pop("phase", None)
        _write_marker(marker, state)
    elif state["status"] == "applied":
        shutil.rmtree(rollback, ignore_errors=True)
        shutil.rmtree(stage, ignore_errors=True)
        marker.unlink(missing_ok=True)
        marker.with_suffix(".tmp").unlink(missing_ok=True)
        return True
    shutil.rmtree(rollback, ignore_errors=True)
    rollback.mkdir(mode=0o700)
    originals = [p.name for p in root.iterdir() if not _control(p)]
    payload = stage / "data"
    if not payload.is_dir():
        raise ValueError("Restore archive has no data directory")
    incoming = sorted(p.name for p in payload.iterdir())
    state["status"] = "applying"
    state["originals"] = originals
    state["incoming"] = incoming
    state["phase"] = "moving_old"
    _write_marker(marker, state)
    try:
        for current in list(root.iterdir()):
            if _control(current) or _preserve_on_restore(current.name):
                continue
            os.replace(current, rollback / current.name)
        state["phase"] = "installing"
        _write_marker(marker, state)
        for incoming in payload.iterdir():
            os.replace(incoming, root / incoming.name)
        # Persist completion before removing rollback. Startup retry is safe.
        state["status"] = "applied"
        _write_marker(marker, state)
    except Exception:
        _return_incoming(root, payload, state["incoming"])
        _rollback(root, rollback, originals)
        state["status"] = "pending"
        state.pop("originals", None)
        state.pop("incoming", None)
        state.pop("phase", None)
        _write_marker(marker, state)
        raise
    shutil.rmtree(rollback, ignore_errors=True)
    shutil.rmtree(stage, ignore_errors=True)
    marker.unlink(missing_ok=True)
    marker.with_suffix(".tmp").unlink(missing_ok=True)
    return True
