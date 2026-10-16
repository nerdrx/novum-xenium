import asyncio
import os
import sys
import time
from pathlib import Path

import pytest

from src import containment
from src.agent_tools import subprocess_tools


@pytest.fixture(autouse=True)
def isolated_containment_store(tmp_path, monkeypatch):
    monkeypatch.setattr(containment, "_store_path", lambda: tmp_path / "grants.json")
    selected = [item for item in containment.MECHANISMS if item.name == "process_group"]
    assert selected, "process_group mechanism unavailable for this cancellation test"
    monkeypatch.setattr(containment, "MECHANISMS", tuple(selected))
    monkeypatch.setattr(containment, "CONTAINMENT_MODE", containment.MODE_ENFORCING)


@pytest.mark.asyncio
@pytest.mark.skipif(os.name != "posix", reason="requires POSIX process groups")
async def test_stop_owned_cancels_and_awaits_only_the_exact_run(tmp_path):
    scopes = (("session-a", "run-a"), ("session-b", "run-b"))
    pids = {}
    ready = {}
    runners = []
    for session_id, run_id in scopes:
        marker = tmp_path / f"{run_id}.pid"
        ready[run_id] = marker
        code = f"import os,time; open({str(marker)!r},'w').write(str(os.getpid())); time.sleep(60)"
        spec = containment.ContainmentSpec(
            workspace=str(tmp_path), env=dict(os.environ), wall_clock_s=30,
            required=frozenset({containment.WALL_CLOCK}),
        )
        grant = containment.acquire(spec, owner=session_id)
        ctx = {"session_id": session_id, "run_id": run_id}
        runners.append(asyncio.create_task(subprocess_tools._run_scoped(
            containment.run(grant, [sys.executable, "-c", code], argv=True), ctx
        )))

    deadline = time.monotonic() + 5
    while time.monotonic() < deadline and not all(path.exists() for path in ready.values()):
        await asyncio.sleep(0.02)
    assert all(path.exists() for path in ready.values()), "both contained commands should start"
    pids = {run_id: int(path.read_text()) for run_id, path in ready.items()}

    await subprocess_tools.stop_owned(*scopes[0])
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(runners[0], timeout=5)
    assert runners[1].done() is False, "stopping one run must not cancel another run"
    assert not containment._group_present(pids["run-a"])

    runners[1].cancel()
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(runners[1], timeout=5)
    assert not containment._group_present(pids["run-b"])
    assert containment.active_grants() == []


@pytest.mark.asyncio
async def test_stop_owned_awaits_host_bridge_cancel_request(monkeypatch):
    entered = asyncio.Event()
    cancelled = asyncio.Event()
    scope = ("bridge-session", "bridge-run")

    class Response:
        status_code = 200
        def json(self):
            return {"stdout": "", "stderr": "", "exit_code": 0}

    class Client:
        def __init__(self, *args, **kwargs):
            pass
        async def __aenter__(self):
            return self
        async def __aexit__(self, *args):
            return False
        async def post(self, url, **kwargs):
            if url.endswith("/cancel"):
                cancelled.set()
                return Response()
            entered.set()
            await asyncio.Event().wait()

    monkeypatch.setattr(subprocess_tools.httpx, "AsyncClient", Client)
    monkeypatch.setattr(subprocess_tools, "_owned_spec", lambda *a, **k: containment.ContainmentSpec(
        workspace=str(Path.cwd()), env={}, wall_clock_s=5,
    ))
    monkeypatch.setattr(subprocess_tools, "_run_scope", lambda _ctx: scope)
    tool_task = asyncio.create_task(subprocess_tools.HostShellTool().execute(
        "echo hi", {"session_id": scope[0], "run_id": scope[1],
                    "client_runtime_context": {"host_shell_bridge": {
                        "url": "http://127.0.0.1:8127/run", "token": "test-token"}}}
    ))
    await asyncio.wait_for(entered.wait(), 2)
    await subprocess_tools.stop_owned(*scope)
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(tool_task, 2)
    assert cancelled.is_set(), "Stop must wait until the bridge cancel request is sent"
