import os
import subprocess
import sys
import time
import asyncio
import threading
import importlib
from http.server import ThreadingHTTPServer
from pathlib import Path

import pytest

from scripts.executor import server


def _pid_running(pid):
    try:
        stat = Path(f"/proc/{pid}/stat").read_text()
        return stat.split(") ", 1)[1][0] != "Z"
    except FileNotFoundError:
        return False


def test_validate_rejects_symlink_escape(tmp_path, monkeypatch):
    root = tmp_path / "workspace"
    root.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    (root / "escape").symlink_to(outside, target_is_directory=True)
    monkeypatch.setattr(server, "ROOT", root.resolve())

    with pytest.raises(ValueError):
        server.validate({"code": "pwd", "language": "bash", "cwd": "escape"})


def test_worker_omits_app_environment_and_kills_background_child(tmp_path, monkeypatch):
    monkeypatch.setenv("APP_SECRET_SHOULD_NOT_LEAK", "sentinel")
    monkeypatch.setattr(server, "JOBS", {})
    pid_file = tmp_path / "child.pid"
    job = {"id": "test", "status": "running", "output": "", "cancelled": False}
    code = f"sleep 30 & echo $! > {pid_file}; exit 0"

    server.run(job, code, "bash", tmp_path, 5)

    child_pid = int(pid_file.read_text())
    assert job["status"] == "done"
    env_job = {"id": "env", "status": "running", "output": "", "cancelled": False}
    server.run(env_job, "import os; print('APP_SECRET_SHOULD_NOT_LEAK' in os.environ)", "python", tmp_path, 5)
    assert "False" in env_job["output"]
    deadline = time.monotonic() + 2
    while _pid_running(child_pid) and time.monotonic() < deadline:
        time.sleep(0.02)
    assert not _pid_running(child_pid)


@pytest.mark.skipif(not Path("/proc/self").exists(), reason="requires Linux procfs")
def test_hardened_worker_process_hides_environment_from_same_uid(tmp_path):
    child = (
        "import os\n"
        "try: open(f'/proc/{os.getppid()}/environ','rb').read()\n"
        "except PermissionError: print('denied')\n"
    )
    code = (
        "from scripts.executor.server import harden_process; harden_process(); "
        "import subprocess,sys; "
        f"p=subprocess.run([sys.executable,'-c',{child!r}],capture_output=True,text=True); "
        "print(p.stdout + p.stderr)"
    )
    env = {**os.environ, "ODYSSEUS_EXECUTOR_TOKEN": "private-worker-token"}
    result = subprocess.run([sys.executable, "-c", code], env=env, capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    assert "denied" in result.stdout
    assert "private-worker-token" not in result.stdout


def test_worker_caps_captured_output(tmp_path):
    job = {"id": "output", "status": "running", "output": "", "cancelled": False}
    server.run(job, "python -c 'print(\"x\" * 100000)'", "bash", tmp_path, 5)
    assert len(job["output"]) <= 64_000


def test_worker_timeout_terminates_process_group(tmp_path):
    pid_file = tmp_path / "timed-child.pid"
    job = {"id": "timeout", "status": "running", "output": "", "cancelled": False}
    server.run(job, f"sleep 30 & echo $! > {pid_file}; wait", "bash", tmp_path, 1)
    child_pid = int(pid_file.read_text())
    assert "timed out" in job["error"]
    deadline = time.monotonic() + 2
    while _pid_running(child_pid) and time.monotonic() < deadline:
        time.sleep(0.02)
    assert not _pid_running(child_pid)


def test_worker_cancellation_terminates_new_session_descendant(tmp_path):
    marker = tmp_path / "cancelled-child-finished"
    child = f"import pathlib,time;time.sleep(1.5);pathlib.Path({str(marker)!r}).write_text('x')"
    code = (
        "import subprocess,sys,time; "
        f"subprocess.Popen([sys.executable,'-c',{child!r}],start_new_session=True); "
        "time.sleep(30)"
    )
    job = {"id": "cancel-session", "status": "running", "output": "", "cancelled": False}
    runner = threading.Thread(target=server.run, args=(job, code, "python", tmp_path, 30))
    runner.start()
    deadline = time.monotonic() + 3
    while not job.get("proc") and time.monotonic() < deadline:
        time.sleep(0.01)
    assert job.get("proc") is not None
    server.kill(job)
    runner.join(timeout=3)
    assert not runner.is_alive()
    time.sleep(1.7)
    assert not marker.exists()


@pytest.mark.asyncio
async def test_client_cancellation_deletes_worker_job(tmp_path, monkeypatch):
    # Several parser tests replace/re-import src.tool_execution during module
    # collection. Resolve the live sys.modules object here so the patched
    # workspace helpers are the ones execute_isolated imports at call time.
    execution_runtime = importlib.import_module("src.execution_runtime")
    tool_execution = importlib.import_module("src.tool_execution")
    worker = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
    thread = threading.Thread(target=worker.serve_forever, daemon=True)
    thread.start()
    token = "t" * 32
    monkeypatch.setattr(server, "TOKEN", token)
    monkeypatch.setattr(server, "ROOT", tmp_path.resolve())
    monkeypatch.setattr(tool_execution, "get_active_workspace", lambda: str(tmp_path))
    monkeypatch.setattr(tool_execution, "agent_cwd", lambda: str(tmp_path))
    monkeypatch.setenv("ODYSSEUS_EXECUTOR_URL", f"http://127.0.0.1:{worker.server_port}")
    monkeypatch.setenv("ODYSSEUS_EXECUTOR_TOKEN", token)
    monkeypatch.setenv("ODYSSEUS_EXECUTOR_ROOT", str(tmp_path))
    marker = tmp_path / "client-cancel-child-finished"
    child = f"import pathlib,time;time.sleep(1.5);pathlib.Path({str(marker)!r}).write_text('x')"
    code = (
        "import subprocess,sys,time; "
        f"subprocess.Popen([sys.executable,'-c',{child!r}],start_new_session=True); "
        "print('child started',flush=True); time.sleep(30)"
    )
    task = asyncio.create_task(execution_runtime.execute_isolated(
        code, {"session_id": "s", "run_id": "r"}, language="python"
    ))
    try:
        deadline = time.monotonic() + 3
        while not server.JOBS and time.monotonic() < deadline:
            if task.done():
                try:
                    result = task.result()
                except BaseException as exc:
                    pytest.fail(f"worker request exited before creating a job: {type(exc).__name__}: {exc}")
                pytest.fail(f"worker request exited before creating a job: {result!r}")
            await asyncio.sleep(0.02)
        assert server.JOBS
        deadline = time.monotonic() + 3
        while not any("child started" in job.get("output", "") for job in server.JOBS.values()) and time.monotonic() < deadline:
            await asyncio.sleep(0.02)
        assert any("child started" in job.get("output", "") for job in server.JOBS.values())
        assert not task.done(), f"client completed before cancellation: {task.result()!r}"
        assert task.cancel(), "client task was already complete when cancellation was requested"
        with pytest.raises(asyncio.CancelledError):
            await task
        deadline = time.monotonic() + 3
        while server.JOBS and time.monotonic() < deadline:
            await asyncio.sleep(0.02)
        assert not server.JOBS
        await asyncio.sleep(1.7)
        assert not marker.exists()
    finally:
        if not task.done():
            task.cancel()
        worker.shutdown()
        worker.server_close()


@pytest.mark.parametrize("stalled_poll", [False, True])
@pytest.mark.asyncio
async def test_client_deadline_cleans_up_worker_that_never_finishes(tmp_path, monkeypatch, stalled_poll):
    execution_runtime = importlib.import_module("src.execution_runtime")
    tool_execution = importlib.import_module("src.tool_execution")
    monkeypatch.setattr(tool_execution, "get_active_workspace", lambda: str(tmp_path))
    monkeypatch.setattr(tool_execution, "agent_cwd", lambda: str(tmp_path))
    monkeypatch.setenv("ODYSSEUS_EXECUTOR_URL", "http://worker.invalid")
    monkeypatch.setenv("ODYSSEUS_EXECUTOR_TOKEN", "t" * 32)
    monkeypatch.setenv("ODYSSEUS_EXECUTOR_ROOT", str(tmp_path))
    monkeypatch.setenv("ODYSSEUS_EXECUTOR_TIMEOUT", "1")

    now = [0.0]
    monkeypatch.setattr(execution_runtime.time, "monotonic", lambda: now[0])

    async def advance(seconds):
        now[0] += seconds

    monkeypatch.setattr(execution_runtime.asyncio, "sleep", advance)

    async def poll_with_optional_timeout(awaitable, timeout):
        if stalled_poll:
            awaitable.close()
            raise asyncio.TimeoutError
        return await awaitable

    monkeypatch.setattr(execution_runtime.asyncio, "wait_for", poll_with_optional_timeout)
    deleted = []
    polls = []

    class Response:
        def __init__(self, body):
            self.body = body

        def raise_for_status(self):
            pass

        def json(self):
            return self.body

    class Client:
        def __init__(self, **_kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            pass

        async def post(self, *_args, **_kwargs):
            return Response({"id": "stuck"})

        async def get(self, *_args, **_kwargs):
            polls.append(True)
            return Response({"status": "running", "output": ""})

        async def delete(self, *_args, **_kwargs):
            deleted.append(True)
            return Response({"stopped": True})

    monkeypatch.setattr(execution_runtime.httpx, "AsyncClient", Client)

    result = await execution_runtime.execute_isolated("print('hello')", {}, language="python")

    if stalled_poll:
        assert result == {
            "error": "Separate execution worker did not respond within 15s; command was not retried locally",
            "exit_code": 1,
        }
        assert now[0] == 0
        assert not polls
    else:
        assert result == {
            "error": "Separate execution worker did not complete within 1s plus 15s polling grace",
            "exit_code": 124,
        }
        assert now[0] == pytest.approx(16)  # Configured timeout plus the bounded poll grace.
        assert 0 < len(polls) <= 17
    assert deleted == [True]
