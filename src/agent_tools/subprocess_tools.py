import asyncio
import os
import re
import shlex
import shutil
import sys
import time
import collections
import signal
import threading
from typing import Optional, Callable, Awaitable, Tuple, Dict
from core.platform_compat import IS_WINDOWS, find_bash
from src.constants import MAX_OUTPUT_CHARS

DEFAULT_BASH_TIMEOUT = 60 * 60     # 1 hour
DEFAULT_PYTHON_TIMEOUT = 60 * 60

PROGRESS_INTERVAL_S = 2.0
PROGRESS_TAIL_LINES = 12
TMUX_CAPTURE_LINES = 2000

# Only process groups created by this module are eligible for Stop cleanup.
_OWNED_GROUPS: dict[tuple[str, str], set[int]] = {}
_OWNED_LOCK = threading.Lock()
_TMUX_COMMANDS: dict[tuple[str, str], tuple[str, int, set[int], set[int]]] = {}
_TMUX_STOP_TASKS: dict[tuple[str, str], asyncio.Task] = {}
_TMUX_LOCKS: dict[str, asyncio.Lock] = {}


def _run_key(session_id: Optional[str], run_id: Optional[str]):
    return (str(session_id or ""), str(run_id or "")) if session_id and run_id else None


def _track_group(key, pid: int) -> None:
    if key and not IS_WINDOWS:
        with _OWNED_LOCK:
            _OWNED_GROUPS.setdefault(key, set()).add(pid)


def _untrack_group(key, pid: int) -> None:
    if key:
        with _OWNED_LOCK:
            groups = _OWNED_GROUPS.get(key)
            if groups:
                groups.discard(pid)
                if not groups:
                    _OWNED_GROUPS.pop(key, None)


async def stop_owned(session_id: str, run_id: str, *, timeout: float = 0.5) -> None:
    """Stop only command groups registered to this exact agent run."""
    key = (str(session_id), str(run_id))
    if IS_WINDOWS:
        return
    with _OWNED_LOCK:
        pids = tuple(_OWNED_GROUPS.get(key, ()))
    for pid in pids:
        try:
            os.killpg(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        except OSError:
            pass
    # Tmux runs execute in the persistent pane shell so cwd/exports survive.
    # Stop only descendants created since this specific command began; never
    # signal the pane shell or jobs that predated the agent command.
    command = _TMUX_COMMANDS.get(key)
    if command:
        await asyncio.shield(_request_tmux_stop(key, command, timeout=timeout))
        for pid in pids:
            _untrack_group(key, pid)
        return
    if not pids:
        return
    await asyncio.sleep(timeout)
    for pid in pids:
        try:
            os.killpg(pid, signal.SIGKILL)
        except OSError:
            pass
        _untrack_group(key, pid)


def _kill_groups(key, *, force=False) -> None:
    if not key or IS_WINDOWS:
        return
    with _OWNED_LOCK:
        pids = tuple(_OWNED_GROUPS.get(key, ()))
    for pid in pids:
        try:
            os.killpg(pid, signal.SIGKILL if force else signal.SIGTERM)
        except OSError:
            pass


async def _create_bash_subprocess(command: str, **kwargs):
    """Start the agent shell with Bash semantics on every supported OS.

    ``asyncio.create_subprocess_shell`` delegates to ``cmd.exe`` on native
    Windows.  That contradicts the Bash tool contract and makes POSIX commands
    such as ``pwd``, ``ls -la``, and ``cat`` unreliable even when the launcher
    has found Git Bash.  Pass the selected workspace as a structural ``cwd``
    argument; Git Bash inherits that native Windows directory and exposes it
    using its normal ``/c/...`` representation.
    """
    if IS_WINDOWS:
        bash = find_bash()
        if not bash:
            raise RuntimeError(
                "Git Bash is required for the Bash tool on Windows; "
                "install Git for Windows and restart Odysseus"
            )
        return await asyncio.create_subprocess_exec(bash, "-c", command, **kwargs)
    return await asyncio.create_subprocess_shell(command, **kwargs)


def _tmux_session_name(session_id: Optional[str]) -> str:
    raw = re.sub(r"[^A-Za-z0-9_.-]+", "-", str(session_id or "default")).strip("-")
    return f"ody-agent-{raw[:80] or 'default'}"


async def _run_exec(*args: str, timeout: float = 10) -> Tuple[str, str, int]:
    proc = await asyncio.create_subprocess_exec(
        *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        start_new_session=not IS_WINDOWS,
    )
    try:
        out_b, err_b = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        try:
            if not IS_WINDOWS:
                os.killpg(proc.pid, signal.SIGKILL)
            else:
                proc.kill()
        except Exception:
            pass
        try:
            await asyncio.wait_for(proc.communicate(), timeout=1)
        except Exception:
            pass
        return "", "timeout", 124
    except asyncio.CancelledError:
        try:
            if not IS_WINDOWS:
                os.killpg(proc.pid, signal.SIGKILL)
            else:
                proc.kill()
        except Exception:
            pass
        try:
            await asyncio.wait_for(proc.communicate(), timeout=1)
        except Exception:
            pass
        raise
    return (
        out_b.decode("utf-8", errors="replace"),
        err_b.decode("utf-8", errors="replace"),
        proc.returncode or 0,
    )


async def _tmux_has_session(name: str) -> bool:
    _, _, rc = await _run_exec("tmux", "has-session", "-t", name, timeout=3)
    return rc == 0


async def _tmux_capture(name: str) -> str:
    out, _, _ = await _run_exec(
        "tmux", "capture-pane", "-p", "-J", "-S", f"-{TMUX_CAPTURE_LINES}", "-t", name,
        timeout=5,
    )
    return out


async def _tmux_send_line(name: str, line: str) -> None:
    if line:
        await _run_exec("tmux", "send-keys", "-t", name, "-l", line, timeout=5)
    await _run_exec("tmux", "send-keys", "-t", name, "C-m", timeout=5)


async def _ensure_tmux_session(name: str, cwd: str, env: Optional[dict]) -> None:
    if await _tmux_has_session(name):
        await _run_exec("tmux", "send-keys", "-t", name, "stty -echo", "C-m", timeout=5)
        return
    await _run_exec(
        "tmux", "new-session", "-d", "-s", name, "-c", cwd,
        "env",
        f"TERM={env.get('TERM', 'xterm-256color') if env else 'xterm-256color'}",
        f"COLUMNS={env.get('COLUMNS', '120') if env else '120'}",
        f"LINES={env.get('LINES', '40') if env else '40'}",
        "/bin/bash",
        "--noprofile",
        "--norc",
        timeout=10,
    )
    if not await _tmux_has_session(name):
        raise RuntimeError(f"failed to create tmux session {name}")
    await _run_exec("tmux", "send-keys", "-t", name, "stty -echo", "C-m", timeout=5)


async def _tmux_pane_pid(name: str) -> int:
    out, _, rc = await _run_exec("tmux", "display-message", "-p", "-t", name, "#{pane_pid}", timeout=3)
    if rc or not out.strip().isdigit():
        raise RuntimeError("could not identify owned tmux pane")
    return int(out.strip())


async def _process_descendants(root_pid: int) -> set[int]:
    """Return descendants from `ps`; no process names or command text are read."""
    out, _, rc = await _run_exec("ps", "-eo", "pid=,ppid=", timeout=3)
    if rc:
        return set()
    children: dict[int, list[int]] = {}
    for line in out.splitlines():
        try:
            pid, ppid = (int(part) for part in line.split())
        except (TypeError, ValueError):
            continue
        children.setdefault(ppid, []).append(pid)
    found: set[int] = set()
    pending = list(children.get(root_pid, ()))
    while pending:
        pid = pending.pop()
        if pid in found:
            continue
        found.add(pid)
        pending.extend(children.get(pid, ()))
    return found


async def _refresh_tmux_owned(key, command) -> set[int]:
    name, pane_pid, baseline, owned = command
    current = await _process_descendants(pane_pid)
    owned.update(current - baseline)
    return set(owned)


async def _stop_tmux_command(key, command, *, timeout: float = 0.5) -> None:
    name, pane_pid, baseline, owned = command
    # Refresh before signalling so Stop also catches children forked between polls.
    targets = await _refresh_tmux_owned(key, command)
    for pid in sorted(targets, reverse=True):
        try:
            os.kill(pid, signal.SIGTERM)
        except OSError:
            pass
    # C-c handles shell builtins and ensures the persistent prompt resumes.
    await _run_exec("tmux", "send-keys", "-t", name, "C-c", timeout=2)
    await asyncio.sleep(max(0, timeout))
    targets.update(await _refresh_tmux_owned(key, command))
    for pid in sorted(targets, reverse=True):
        try:
            os.kill(pid, signal.SIGKILL)
        except OSError:
            pass


def _request_tmux_stop(key, command, *, timeout: float):
    """Share one cleanup task between Stop and the cancelled tool coroutine."""
    task = _TMUX_STOP_TASKS.get(key)
    if task is None or task.done():
        task = asyncio.create_task(_stop_tmux_command(key, command, timeout=timeout))
        _TMUX_STOP_TASKS[key] = task
    return task


def _output_after_marker(capture: str, start_marker: str, end_marker: str) -> Tuple[str, bool]:
    lines = capture.splitlines()
    start_idx = -1
    for idx, line in enumerate(lines):
        if line.strip() == start_marker:
            start_idx = idx
    if start_idx < 0:
        return capture, False
    end_idx = -1
    for idx in range(start_idx + 1, len(lines)):
        if lines[idx].strip().startswith(end_marker):
            end_idx = idx
    if end_idx < 0:
        return "\n".join(lines[start_idx + 1:]), False
    return "\n".join(lines[start_idx + 1:end_idx]), True


def _extract_marker_rc(capture: str, end_marker: str) -> int:
    for line in reversed(capture.splitlines()):
        stripped = line.strip()
        if stripped.startswith(end_marker):
            suffix = stripped[len(end_marker):].strip()
            if suffix.isdigit():
                return int(suffix)
    return 0


async def _run_tmux_bash(
    content: str,
    *,
    session_id: str,
    cwd: str,
    env: Optional[dict],
    timeout: float,
    owner_key=None,
    progress_cb: Optional[Callable[[Dict], Awaitable[None]]] = None,
) -> Tuple[str, str, Optional[int], bool]:
    name = _tmux_session_name(session_id)
    with _OWNED_LOCK:
        pane_lock = _TMUX_LOCKS.setdefault(name, asyncio.Lock())
    async with pane_lock:
        await _ensure_tmux_session(name, cwd, env)
        pane_pid = await _tmux_pane_pid(name)
        baseline = await _process_descendants(pane_pid)
        stamp = f"{int(time.time() * 1000)}-{abs(hash(content)) % 1000000}"
        start_marker = f"__ODYSSEUS_CMD_START_{stamp}__"
        end_prefix = f"__ODYSSEUS_CMD_END_{stamp}__:"
        # eval runs in the persistent pane shell, preserving cwd, exports and
        # activated environments while leaving descendants trackable.
        wrapped = (
            f"printf '\\n{start_marker}\\n'\n"
            f"eval {shlex.quote(content)}\n"
            f"__ody_rc=$?\n"
            f"printf '\\n{end_prefix}%s\\n' \"$__ody_rc\"\n"
        )
        command = (name, pane_pid, baseline, set())
        if owner_key:
            _TMUX_COMMANDS[owner_key] = command
        try:
            for line in wrapped.splitlines():
                await _tmux_send_line(name, line)

            started = time.time()
            last_tail = ""
            while True:
                capture = await _tmux_capture(name)
                if owner_key:
                    await _refresh_tmux_owned(owner_key, command)
                body, done = _output_after_marker(capture, start_marker, end_prefix)
                tail = "\n".join(body.splitlines()[-PROGRESS_TAIL_LINES:])
                if progress_cb and tail != last_tail:
                    last_tail = tail
                    try:
                        await progress_cb({"elapsed_s": round(time.time() - started, 1),
                                           "tail": tail, "tmux_session": name})
                    except Exception:
                        pass
                if done:
                    rc = _extract_marker_rc(capture, end_prefix)
                    return _clean_tmux_command_output(body, wrapped), "", rc, False
                if time.time() - started > timeout:
                    if owner_key:
                        await _request_tmux_stop(owner_key, command, timeout=0.1)
                    else:
                        await _stop_tmux_command(None, command, timeout=0.1)
                    return _clean_tmux_command_output(body, wrapped), "", 124, True
                await asyncio.sleep(0.5)
        except asyncio.CancelledError:
            cleanup = (_request_tmux_stop(owner_key, command, timeout=0.1)
                       if owner_key else asyncio.create_task(_stop_tmux_command(None, command, timeout=0.1)))
            try:
                await asyncio.wait_for(asyncio.shield(cleanup), timeout=8)
            except (asyncio.TimeoutError, asyncio.CancelledError, Exception):
                pass
            raise
        finally:
            if owner_key:
                _TMUX_COMMANDS.pop(owner_key, None)
                cleanup = _TMUX_STOP_TASKS.get(owner_key)
                if cleanup and cleanup.done():
                    _TMUX_STOP_TASKS.pop(owner_key, None)


def _clean_tmux_command_output(text: str, wrapped_command: str) -> str:
    lines = text.splitlines()
    wrapped_lines = {ln.rstrip() for ln in wrapped_command.splitlines() if ln.strip()}
    cleaned = []
    for line in lines:
        raw = line.rstrip()
        stripped = raw.strip()
        if not stripped:
            cleaned.append(raw)
            continue
        if stripped in wrapped_lines:
            continue
        if stripped.startswith("__ody_rc=") or stripped.startswith("printf "):
            continue
        if stripped.startswith("__ODYSSEUS_PID_"):
            continue
        if re.fullmatch(r"(?:bash|sh)-[\d.]+\$ ?", stripped):
            continue
        if re.fullmatch(r"[\w.@:/~+-]+[#$] ?", stripped):
            continue
        cleaned.append(raw)
    return "\n".join(cleaned).strip()

async def _run_subprocess_streaming(
    proc: asyncio.subprocess.Process,
    *,
    timeout: float,
    progress_cb: Optional[Callable[[Dict], Awaitable[None]]] = None,
    owner_key=None,
) -> Tuple[str, str, Optional[int], bool]:
    started = time.time()
    stdout_full: list[str] = []
    stderr_full: list[str] = []
    tail = collections.deque(maxlen=PROGRESS_TAIL_LINES)

    async def _reader(stream, full_buf, label: str):
        if stream is None:
            return
        while True:
            line = await stream.readline()
            if not line:
                break
            decoded = line.decode("utf-8", errors="replace").rstrip("\n")
            full_buf.append(decoded)
            if label == "err":
                tail.append(f"! {decoded}")
            else:
                tail.append(decoded)

    async def _progress_emitter():
        await asyncio.sleep(PROGRESS_INTERVAL_S)
        while True:
            if progress_cb:
                try:
                    await progress_cb({
                        "elapsed_s": round(time.time() - started, 1),
                        "tail": "\n".join(list(tail)),
                    })
                except Exception:
                    pass
            await asyncio.sleep(PROGRESS_INTERVAL_S)

    rd_out = asyncio.create_task(_reader(proc.stdout, stdout_full, "out"))
    rd_err = asyncio.create_task(_reader(proc.stderr, stderr_full, "err"))
    prog_task = asyncio.create_task(_progress_emitter()) if progress_cb else None

    timed_out = False
    _track_group(owner_key, proc.pid)
    try:
        await asyncio.wait_for(proc.wait(), timeout=timeout)
    except asyncio.TimeoutError:
        timed_out = True
        try:
            if not IS_WINDOWS:
                os.killpg(proc.pid, signal.SIGKILL)
            else:
                proc.kill()
        except Exception:
            pass
        try:
            await asyncio.wait_for(proc.wait(), timeout=2)
        except Exception:
            pass
    except asyncio.CancelledError:
        try:
            if not IS_WINDOWS:
                os.killpg(proc.pid, signal.SIGKILL)
            else:
                proc.kill()
        except Exception:
            pass
        try:
            await asyncio.wait_for(proc.wait(), timeout=2)
        except Exception:
            pass
        for t in (rd_out, rd_err):
            t.cancel()
        if prog_task is not None:
            prog_task.cancel()
        raise
    finally:
        _untrack_group(owner_key, proc.pid)
        if prog_task is not None and not prog_task.done():
            prog_task.cancel()
            try:
                await prog_task
            except (asyncio.CancelledError, Exception):
                pass
        for t in (rd_out, rd_err):
            try:
                await asyncio.wait_for(t, timeout=1)
            except Exception:
                pass

    return (
        "\n".join(stdout_full),
        "\n".join(stderr_full),
        proc.returncode,
        timed_out,
    )

class BashTool:
    async def execute(self, content: str, ctx: dict) -> dict:
        from src.tool_execution import agent_cwd, _truncate
        if isinstance(content, dict):
            content = str(content.get("command") or content.get("cmd") or content.get("code") or "")
        progress_cb = ctx.get("progress_cb")
        _subproc_env = ctx.get("subproc_env")
        session_id = ctx.get("session_id")
        if session_id:
            from src import agent_runs
            ctx = {**ctx, "run_id": agent_runs.get_run_id(session_id)}
        try:
            from src.execution_runtime import execute_isolated
        except ImportError:
            execute_isolated = None
        if execute_isolated:
            isolated = await execute_isolated(content, ctx, language="bash")
            if isolated is not None:
                return isolated
        from src import agent_runs
        owner_key = _run_key(session_id, agent_runs.get_run_id(session_id) if session_id else None)
        # tmux is a POSIX persistence path. A stray MSYS/Cygwin tmux.exe on
        # native Windows must not bypass the Git Bash launcher below: the tmux
        # setup hard-codes /bin/bash and cannot safely consume a native cwd.
        if session_id and not IS_WINDOWS and shutil.which("tmux"):
            stdout, stderr, rc, timed_out = await _run_tmux_bash(
                content,
                session_id=str(session_id),
                cwd=agent_cwd(),
                owner_key=owner_key,
                env=_subproc_env,
                timeout=DEFAULT_BASH_TIMEOUT,
                progress_cb=progress_cb,
            )
            if timed_out:
                return {
                    "error": f"bash: timed out after {DEFAULT_BASH_TIMEOUT}s — sent Ctrl-C to tmux session",
                    "exit_code": 124,
                    "stdout": _truncate(stdout, MAX_OUTPUT_CHARS),
                    "stderr": _truncate(stderr, MAX_OUTPUT_CHARS),
                    "tmux_session": _tmux_session_name(str(session_id)),
                }
            output = stdout.rstrip()
            err = stderr.rstrip()
            if err:
                output = (output + "\nSTDERR: " + err).strip() if output else "STDERR: " + err
            return {
                "output": _truncate(output, MAX_OUTPUT_CHARS) or "(no output)",
                "exit_code": rc or 0,
                "tmux_session": _tmux_session_name(str(session_id)),
            }

        try:
            proc = await _create_bash_subprocess(
                content,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=_subproc_env,
                cwd=agent_cwd(),
                start_new_session=not IS_WINDOWS,
            )
        except RuntimeError as e:
            return {"error": f"bash: {e}", "exit_code": 1}
        stdout, stderr, rc, timed_out = await _run_subprocess_streaming(
            proc,
            timeout=DEFAULT_BASH_TIMEOUT,
            progress_cb=progress_cb,
            owner_key=owner_key,
        )
        if timed_out:
            return {"error": f"bash: timed out after {DEFAULT_BASH_TIMEOUT}s — process killed", "exit_code": 124, "stdout": _truncate(stdout, MAX_OUTPUT_CHARS), "stderr": _truncate(stderr, MAX_OUTPUT_CHARS)}
        output = stdout.rstrip()
        err = stderr.rstrip()
        if err:
            output = (output + "\nSTDERR: " + err).strip() if output else "STDERR: " + err
        output = _truncate(output, MAX_OUTPUT_CHARS)
        return {"output": output or "(no output)", "exit_code": rc or 0}

class PythonTool:
    async def execute(self, content: str, ctx: dict) -> dict:
        from src.tool_execution import agent_cwd, _truncate
        progress_cb = ctx.get("progress_cb")
        _subproc_env = ctx.get("subproc_env")
        session_id = ctx.get("session_id")
        if session_id:
            from src import agent_runs
            ctx = {**ctx, "run_id": agent_runs.get_run_id(session_id)}
        try:
            from src.execution_runtime import execute_isolated
        except ImportError:
            execute_isolated = None
        if execute_isolated:
            isolated = await execute_isolated(content, ctx, language="python")
            if isolated is not None:
                return isolated
        from src import agent_runs
        owner_key = _run_key(session_id, agent_runs.get_run_id(session_id) if session_id else None)
        proc = await asyncio.create_subprocess_exec(
            (sys.executable or "python"), "-I", "-c", content,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=_subproc_env,
            cwd=agent_cwd(),
            start_new_session=not IS_WINDOWS,
        )
        stdout, stderr, rc, timed_out = await _run_subprocess_streaming(
            proc,
            timeout=DEFAULT_PYTHON_TIMEOUT,
            progress_cb=progress_cb,
            owner_key=owner_key,
        )
        if timed_out:
            return {"error": f"python: timed out after {DEFAULT_PYTHON_TIMEOUT}s — process killed", "exit_code": 124, "stdout": _truncate(stdout, MAX_OUTPUT_CHARS), "stderr": _truncate(stderr, MAX_OUTPUT_CHARS)}
        output = stdout.rstrip()
        err = stderr.rstrip()
        if err:
            output = (output + "\nSTDERR: " + err).strip() if output else "STDERR: " + err
        output = _truncate(output, MAX_OUTPUT_CHARS)
        return {"output": output or "(no output)", "exit_code": rc or 0}
