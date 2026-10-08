"""Small authenticated execution worker; mounts code, never application data."""
from __future__ import annotations

import hmac
import json
import os
from pathlib import Path
import signal
import subprocess
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = Path(os.getenv("EXECUTOR_ROOT", "/workspace")).resolve()
JOBS = {}
LOCK = threading.RLock()
TOKEN = os.getenv("ODYSSEUS_EXECUTOR_TOKEN", "")
_CANCELLED_IDS: dict[str, float] = {}
_CANCEL_TTL = 60
_MAX_CANCELLED_IDS = 128


def _purge_cancelled_ids(now: float) -> None:
    for job_id, expires in list(_CANCELLED_IDS.items()):
        if expires <= now:
            _CANCELLED_IDS.pop(job_id, None)


def _remember_cancelled_id(job_id: str, now: float) -> None:
    _purge_cancelled_ids(now)
    if job_id not in _CANCELLED_IDS and len(_CANCELLED_IDS) >= _MAX_CANCELLED_IDS:
        oldest = min(_CANCELLED_IDS, key=_CANCELLED_IDS.get)
        _CANCELLED_IDS.pop(oldest, None)
    _CANCELLED_IDS[job_id] = now + _CANCEL_TTL


def harden_process() -> None:
    """Keep same-UID job children from reading the worker's token via procfs."""
    if os.name == "posix" and Path("/proc/self").exists():
        import ctypes
        libc = ctypes.CDLL(None, use_errno=True)
        if libc.prctl(4, 0, 0, 0, 0) != 0:  # PR_SET_DUMPABLE = 4
            err = ctypes.get_errno()
            raise OSError(err, os.strerror(err), "prctl(PR_SET_DUMPABLE)")


def validate(body):
    code = body.get("code")
    if not isinstance(code, str) or not code.strip() or len(code) > 100_000:
        raise ValueError("Command must contain 1 to 100000 characters")
    language = body.get("language")
    if language not in {"bash", "python"}:
        raise ValueError("Unsupported execution language")
    cwd = (ROOT / str(body.get("cwd", "."))).resolve()
    if not cwd.is_relative_to(ROOT) or not cwd.is_dir():
        raise ValueError("Workspace is outside the mounted root or does not exist")
    timeout = body.get("timeout", 3600)
    if not isinstance(timeout, int) or isinstance(timeout, bool) or not 1 <= timeout <= 3600:
        raise ValueError("Timeout must be 1 to 3600 seconds")
    return code, language, cwd, timeout


def kill(job):
    job["cancelled"] = True
    proc = job.get("proc")
    if proc:
        # Job code may create a new session (for example, a nested verifier
        # subprocess). Freeze the worker's own group before discovering and
        # killing those descendant process groups, or they can escape DELETE.
        try:
            os.killpg(proc.pid, signal.SIGSTOP)
        except OSError:
            pass
        for pgid in _descendant_process_groups(proc.pid):
            try:
                os.killpg(pgid, signal.SIGKILL)
            except OSError:
                pass
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except OSError:
            pass


def _descendant_process_groups(root_pid: int) -> set[int]:
    """Return separate POSIX process groups below a live worker job PID."""
    proc_root = Path("/proc")
    if os.name != "posix" or not proc_root.is_dir():
        return set()
    parents: dict[int, tuple[int, int]] = {}
    try:
        entries = list(proc_root.iterdir())
    except OSError:
        return set()
    for entry in entries:
        if not entry.name.isdigit():
            continue
        try:
            fields = (entry / "stat").read_text().rsplit(")", 1)[1].split()
            # fields begin at proc stat field 3 (state); parent is 4, pgrp is 5.
            parents[int(entry.name)] = (int(fields[1]), int(fields[2]))
        except (OSError, ValueError, IndexError):
            continue
    children: dict[int, list[int]] = {}
    for child, (parent, _pgid) in parents.items():
        children.setdefault(parent, []).append(child)
    groups: set[int] = set()
    pending = list(children.get(root_pid, ()))
    seen = {root_pid}
    while pending:
        pid = pending.pop()
        if pid in seen:
            continue
        seen.add(pid)
        _parent, pgid = parents.get(pid, (0, 0))
        if pgid and pgid != root_pid:
            groups.add(pgid)
        pending.extend(children.get(pid, ()))
    return groups


def run(job, code, language, cwd, timeout):
    proc = None
    try:
        with LOCK:
            if job["cancelled"]:
                return
            proc = subprocess.Popen(
                ["/bin/bash", "--noprofile", "--norc", "-c", code] if language == "bash"
                else ["python", "-u", "-c", code], cwd=cwd,
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True,
                env={"PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
                     "HOME": "/tmp", "LANG": "C.UTF-8", "PYTHONUNBUFFERED": "1"},
            )
            job["proc"] = proc
        def read():
            while chunk := proc.stdout.read1(4096):
                with LOCK:
                    job["output"] = (job["output"] + chunk.decode("utf-8", "replace"))[-64_000:]
        reader = threading.Thread(target=read, daemon=True)
        reader.start()
        try:
            job["exit_code"] = proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            job["error"] = f"Command timed out after {timeout} seconds"
            kill(job)
            job["exit_code"] = proc.wait(timeout=5)
        # Detached descendants belong to this command too, not to the app.
        kill(job)
        reader.join(timeout=2)
    except Exception:
        job["error"] = "Execution failed in separate worker"
        job["exit_code"] = 1
        if proc:
            kill(job)
    finally:
        with LOCK:
            job["status"] = "done"
            job["finished"] = time.monotonic()
            if job.get("delete_requested"):
                JOBS.pop(job["id"], None)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass  # Never log submitted commands or bearer tokens.

    def reply(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def authorized(self):
        if not TOKEN or not hmac.compare_digest(self.headers.get("Authorization", ""), f"Bearer {TOKEN}"):
            self.reply(401, {"error": "Worker authentication required"})
            return False
        return True

    def do_POST(self):
        if not self.authorized():
            return
        if self.path != "/jobs":
            return self.reply(404, {"error": "Not found"})
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if not 0 < size <= 110_000:
                raise ValueError("Invalid request size")
            body = json.loads(self.rfile.read(size))
            args = validate(body)
            requested_id = body.get("id")
            if requested_id is not None and (
                    not isinstance(requested_id, str)
                    or uuid.UUID(requested_id).hex != requested_id):
                raise ValueError("Invalid job ID")
        except (ValueError, TypeError, AttributeError):
            return self.reply(400, {"error": "Invalid execution request"})
        with LOCK:
            now = time.monotonic()
            _purge_cancelled_ids(now)
            for key, job in list(JOBS.items()):
                if job.get("finished", now) < now - 600:
                    JOBS.pop(key)
            if requested_id in _CANCELLED_IDS:
                return self.reply(410, {"error": "Job was canceled before it was accepted"})
            if sum(j["status"] == "running" for j in JOBS.values()) >= 4 or len(JOBS) >= 64:
                return self.reply(429, {"error": "Worker busy"})
            job_id = requested_id or uuid.uuid4().hex
            if job_id in JOBS:
                return self.reply(409, {"error": "Job ID is already in use"})
            job = {"id": job_id, "status": "running", "output": "", "exit_code": 1, "cancelled": False}
            JOBS[job_id] = job
            threading.Thread(target=run, args=(job, *args), daemon=True).start()
        self.reply(202, {"id": job_id})

    def do_GET(self):
        if not self.authorized():
            return
        if self.path == "/health":
            return self.reply(200, {"client_job_ids": True})
        with LOCK:
            job = JOBS.get(self.path.removeprefix("/jobs/")) if self.path.startswith("/jobs/") else None
            if not job:
                return self.reply(404, {"error": "Not found"})
            self.reply(200, {k: job[k] for k in ("status", "output", "exit_code", "error") if k in job})

    def do_DELETE(self):
        if not self.authorized():
            return
        with LOCK:
            key = self.path.removeprefix("/jobs/")
            job = JOBS.get(key) if self.path.startswith("/jobs/") else None
            if not job:
                try:
                    if uuid.UUID(key).hex != key:
                        raise ValueError
                except (ValueError, AttributeError):
                    return self.reply(404, {"error": "Not found"})
                _remember_cancelled_id(key, time.monotonic())
                return self.reply(200, {"stopped": True})
            if job["status"] == "running":
                job["delete_requested"] = True
                kill(job)
            else:
                JOBS.pop(key)
        self.reply(200, {"stopped": True})


if __name__ == "__main__":
    if len(TOKEN) < 32:
        raise SystemExit("ODYSSEUS_EXECUTOR_TOKEN must contain at least 32 characters")
    harden_process()
    ThreadingHTTPServer(("0.0.0.0", 9100), Handler).serve_forever()
