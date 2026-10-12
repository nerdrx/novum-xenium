"""Windows execution contract for the agent Bash tool."""

import os
import shutil
import uuid

import pytest

from src.agent_tools import subprocess_tools


@pytest.mark.asyncio
async def test_windows_bash_uses_git_bash_with_structural_cwd(monkeypatch):
    captured = {}
    bash = r"C:\Program Files\Git\bin\bash.exe"
    workspace = r"D:\Workspaces\Project with spaces"
    process = object()

    monkeypatch.setattr(subprocess_tools, "IS_WINDOWS", True)
    monkeypatch.setattr(subprocess_tools, "find_bash", lambda: bash)

    async def fake_exec(*argv, **kwargs):
        captured["argv"] = argv
        captured["kwargs"] = kwargs
        return process

    async def fail_shell(*_args, **_kwargs):
        pytest.fail("native Windows Bash must not execute through cmd.exe")

    monkeypatch.setattr(subprocess_tools.asyncio, "create_subprocess_exec", fake_exec)
    monkeypatch.setattr(subprocess_tools.asyncio, "create_subprocess_shell", fail_shell)

    result = await subprocess_tools._create_bash_subprocess(
        "pwd; cat package.json",
        cwd=workspace,
        env={"HOME": r"C:\Odysseus\data"},
    )

    assert result is process
    assert captured["argv"] == (bash, "-o", "pipefail", "-c", "pwd; cat package.json")
    assert captured["kwargs"]["cwd"] == workspace


@pytest.mark.asyncio
async def test_windows_bash_without_git_bash_fails_clearly(monkeypatch):
    monkeypatch.setattr(subprocess_tools, "IS_WINDOWS", True)
    monkeypatch.setattr(subprocess_tools, "find_bash", lambda: None)

    async def fail_spawn(*_args, **_kwargs):
        pytest.fail("no subprocess should start without Git Bash")

    monkeypatch.setattr(subprocess_tools.asyncio, "create_subprocess_exec", fail_spawn)
    monkeypatch.setattr(subprocess_tools.asyncio, "create_subprocess_shell", fail_spawn)

    with pytest.raises(RuntimeError, match="Git Bash is required"):
        await subprocess_tools._create_bash_subprocess("pwd", cwd=r"C:\Work")


@pytest.mark.asyncio
async def test_bash_tool_returns_install_hint_when_git_bash_is_missing(monkeypatch):
    monkeypatch.setattr(subprocess_tools, "IS_WINDOWS", True)
    monkeypatch.setattr(subprocess_tools, "find_bash", lambda: None)

    result = await subprocess_tools.BashTool().execute(
        "pwd",
        {"subproc_env": {}, "session_id": None},
    )

    assert result["exit_code"] == 1
    assert "install Git for Windows" in result["error"]


@pytest.mark.asyncio
async def test_windows_bash_does_not_use_a_stray_tmux_executable(monkeypatch):
    captured = {}
    workspace = r"D:\Workspaces\Project with spaces"

    monkeypatch.setattr(subprocess_tools, "IS_WINDOWS", True)
    monkeypatch.setattr(
        subprocess_tools.shutil,
        "which",
        lambda name: r"C:\msys64\usr\bin\tmux.exe",
    )
    monkeypatch.setattr("src.tool_execution.agent_cwd", lambda: workspace)

    async def fail_tmux(*_args, **_kwargs):
        pytest.fail("native Windows must not enter the POSIX tmux path")

    async def fake_create(command, **kwargs):
        captured["command"] = command
        captured["kwargs"] = kwargs
        return object()

    async def fake_stream(_process, **_kwargs):
        return "ok", "", 0, False

    monkeypatch.setattr(subprocess_tools, "_run_tmux_bash", fail_tmux)
    monkeypatch.setattr(subprocess_tools, "_create_bash_subprocess", fake_create)
    monkeypatch.setattr(subprocess_tools, "_run_subprocess_streaming", fake_stream)

    result = await subprocess_tools.BashTool().execute(
        "pwd",
        {"subproc_env": {}, "session_id": "chat-1"},
    )

    assert result == {"output": "ok", "exit_code": 0}
    assert captured["command"] == "pwd"
    assert captured["kwargs"]["cwd"] == workspace


@pytest.mark.asyncio
async def test_posix_bash_uses_bash_with_pipefail(monkeypatch):
    captured = {}
    process = object()
    bash = "/usr/bin/bash"

    monkeypatch.setattr(subprocess_tools, "IS_WINDOWS", False)
    monkeypatch.setattr(subprocess_tools, "find_bash", lambda: bash)

    async def fake_exec(*argv, **kwargs):
        captured["argv"] = argv
        captured["kwargs"] = kwargs
        return process

    async def fail_shell(*_args, **_kwargs):
        pytest.fail("Bash tool must use Bash with pipefail on POSIX too")

    monkeypatch.setattr(subprocess_tools.asyncio, "create_subprocess_shell", fail_shell)
    monkeypatch.setattr(subprocess_tools.asyncio, "create_subprocess_exec", fake_exec)

    result = await subprocess_tools._create_bash_subprocess("pwd", cwd="/tmp/work")

    assert result is process
    assert captured == {
        "argv": (bash, "-o", "pipefail", "-c", "pwd"),
        "kwargs": {"cwd": "/tmp/work"},
    }


@pytest.mark.asyncio
async def test_real_bash_pipeline_returns_failure_status():
    process = await subprocess_tools._create_bash_subprocess(
        "false | cat",
        stdout=subprocess_tools.asyncio.subprocess.PIPE,
        stderr=subprocess_tools.asyncio.subprocess.PIPE,
    )
    await process.communicate()
    assert process.returncode != 0


@pytest.mark.asyncio
@pytest.mark.skipif(os.name != "posix" or not shutil.which("tmux"), reason="requires POSIX tmux")
async def test_tmux_bash_pipeline_returns_failure_status(tmp_path):
    session_id = f"pipefail-{uuid.uuid4().hex[:10]}"
    result = None
    try:
        result = await subprocess_tools._run_tmux_bash(
            "false | cat", session_id=session_id, cwd=str(tmp_path),
            env=os.environ.copy(), timeout=10,
        )
        assert result[2] != 0
        assert not result[3]
    finally:
        await subprocess_tools._run_exec(
            "tmux", "kill-session", "-t", subprocess_tools._tmux_session_name(session_id),
            timeout=3,
        )
