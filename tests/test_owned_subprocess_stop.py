import asyncio
import os
import shutil
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path

import pytest

from src.agent_tools import subprocess_tools


@pytest.mark.asyncio
@pytest.mark.skipif(os.name != "posix", reason="process group ownership is POSIX-specific")
async def test_stop_owned_kills_only_registered_run_group():
    owned = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"], start_new_session=True)
    unrelated = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"], start_new_session=True)
    key = ("stop-test-session", "stop-test-run")
    subprocess_tools._track_group(key, owned.pid)
    try:
        await subprocess_tools.stop_owned(*key, timeout=0.01)
        assert owned.poll() is not None
        assert unrelated.poll() is None
    finally:
        subprocess_tools._untrack_group(key, owned.pid)
        unrelated.kill()
        unrelated.wait(timeout=2)


@pytest.mark.asyncio
@pytest.mark.skipif(os.name != "posix" or not shutil.which("tmux"), reason="requires POSIX tmux")
async def test_tmux_bash_preserves_shell_state_and_stop_kills_command_children():
    from src.agent_tools.subprocess_tools import _run_tmux_bash, _tmux_session_name

    sid = f"stop-regression-{uuid.uuid4().hex[:10]}"
    name = _tmux_session_name(sid)
    cwd = Path(tempfile.mkdtemp(prefix="ody-tmux-stop-"))
    (cwd / "subdir").mkdir()
    setup = await _run_tmux_bash(
        "export NX_STOP_FIXTURE=kept; cd subdir",
        session_id=sid, cwd=str(cwd), env=os.environ.copy(), timeout=10,
    )
    assert setup[2] == 0 and not setup[3]
    verify = await _run_tmux_bash(
        'printf "%s|%s" "$NX_STOP_FIXTURE" "$PWD"',
        session_id=sid, cwd=str(cwd), env=os.environ.copy(), timeout=10,
    )
    assert "kept|" in verify[0]
    assert str(cwd / "subdir") in verify[0]

    key = (sid, "cancel-child-run")
    running = asyncio.create_task(_run_tmux_bash(
        'sleep 60 & child=$!; printf "child=%s\\n" "$child"; wait "$child"',
        session_id=sid, cwd=str(cwd), env=os.environ.copy(), timeout=30, owner_key=key,
    ))
    for _ in range(60):
        await asyncio.sleep(0.1)
        command = subprocess_tools._TMUX_COMMANDS.get(key)
        if command and command[3]:
            break
    assert command and command[3], "sleep child was not discovered under the persistent pane"
    owned_children = set(command[3])
    replacement = asyncio.create_task(_run_tmux_bash(
        'printf "REPLACEMENT_OK\\n"', session_id=sid, cwd=str(cwd),
        env=os.environ.copy(), timeout=10, owner_key=(sid, "replacement-run"),
    ))
    cleanup = asyncio.create_task(subprocess_tools.stop_owned(*key, timeout=0.1))
    running.cancel()
    await cleanup
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(running, timeout=3)
    replacement_result = await asyncio.wait_for(replacement, timeout=5)
    assert "REPLACEMENT_OK" in replacement_result[0]

    pane_pid = await subprocess_tools._tmux_pane_pid(name)
    for _ in range(20):
        live = await subprocess_tools._process_descendants(pane_pid)
        if not (owned_children & live):
            break
        await asyncio.sleep(0.1)
    assert not (owned_children & live), f"owned descendants remain after Stop: {owned_children & live}"

    assert await subprocess_tools._tmux_pane_pid(name) == pane_pid
    await subprocess_tools._run_exec("tmux", "kill-session", "-t", name, timeout=3)


@pytest.mark.asyncio
@pytest.mark.skipif(os.name != "posix", reason="process-group timeout is POSIX-specific")
async def test_tmux_helper_timeout_reaps_its_process_group(tmp_path):
    pid_file = tmp_path / "child.pid"
    child = f"import os,time; open({str(pid_file)!r}, 'w').write(str(os.getpid())); time.sleep(30)"
    parent = f"import subprocess,sys,time; subprocess.Popen([sys.executable, '-c', {child!r}]); time.sleep(30)"
    out, err, rc = await subprocess_tools._run_exec(sys.executable, "-c", parent, timeout=0.5)
    assert rc == 124 and err == "timeout"
    for _ in range(30):
        if pid_file.exists():
            break
        await asyncio.sleep(0.02)
    assert pid_file.exists(), "child did not start before helper timeout"
    pid = int(pid_file.read_text())
    for _ in range(30):
        try:
            stat = Path(f"/proc/{pid}/stat").read_text()
            if stat[stat.rfind(")") + 2] == "Z":
                break
        except FileNotFoundError:
            break
        await asyncio.sleep(0.02)
    else:
        pytest.fail(f"timed out process-group child {pid} is still alive")
