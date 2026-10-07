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
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


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
        except (ValueError, TypeError, AttributeError):
            return self.reply(400, {"error": "Invalid execution request"})
        with LOCK:
            for key, job in list(JOBS.items()):
                if job.get("finished", time.monotonic()) < time.monotonic() - 600:
                    JOBS.pop(key)
            if sum(j["status"] == "running" for j in JOBS.values()) >= 4 or len(JOBS) >= 64:
                return self.reply(429, {"error": "Worker busy"})
            job_id = uuid.uuid4().hex
            job = {"id": job_id, "status": "running", "output": "", "exit_code": 1, "cancelled": False}
            JOBS[job_id] = job
            threading.Thread(target=run, args=(job, *args), daemon=True).start()
        self.reply(202, {"id": job_id})

    def do_GET(self):
        if not self.authorized():
            return
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
                return self.reply(404, {"error": "Not found"})
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
