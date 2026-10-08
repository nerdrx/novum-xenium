"""Opt-in separate shell worker. Never fall back locally after worker failure."""
from __future__ import annotations

import asyncio
import os
import time
from pathlib import Path

import httpx


async def execute_isolated(content, ctx: dict, *, language: str):
    url = os.getenv("ODYSSEUS_EXECUTOR_URL", "").strip().rstrip("/")
    if not url:
        return None
    from src.tool_execution import agent_cwd, get_active_workspace
    token = os.getenv("ODYSSEUS_EXECUTOR_TOKEN", "")
    if not token or not get_active_workspace():
        return {"error": "Separate execution requires a configured token and selected workspace", "exit_code": 1}
    root = Path(os.getenv("ODYSSEUS_EXECUTOR_ROOT", "/workspace")).resolve()
    try:
        cwd = Path(agent_cwd()).resolve().relative_to(root).as_posix()
    except ValueError:
        return {"error": "Selected workspace is outside the separate worker's mounted root", "exit_code": 1}
    if isinstance(content, dict):
        content = content.get("command") or content.get("code") or content.get("cmd") or ""
    job = None
    headers = {"Authorization": f"Bearer {token}"}
    try:
        worker_timeout = min(int(os.getenv("ODYSSEUS_EXECUTOR_TIMEOUT", "3600")), 3600)
        async with httpx.AsyncClient(timeout=15, trust_env=False) as client:
            response = await client.post(f"{url}/jobs", headers=headers, json={
                "code": str(content), "language": language, "cwd": cwd,
                "timeout": worker_timeout,
            })
            response.raise_for_status()
            job = response.json()["id"]
            # The worker enforces this timeout for the command itself. Keep a
            # client-side bound too, so a lost/stuck worker cannot pin a run
            # forever; the extra 15s covers one bounded in-flight HTTP poll.
            deadline = time.monotonic() + worker_timeout + 15
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return {"error": f"Separate execution worker did not complete within {worker_timeout}s plus 15s polling grace",
                            "exit_code": 124}
                try:
                    response = await asyncio.wait_for(
                        client.get(f"{url}/jobs/{job}", headers=headers),
                        timeout=min(15, remaining),
                    )
                except asyncio.TimeoutError:
                    if time.monotonic() >= deadline:
                        return {"error": f"Separate execution worker did not complete within {worker_timeout}s plus 15s polling grace",
                                "exit_code": 124}
                    return {"error": "Separate execution worker did not respond within 15s; command was not retried locally",
                            "exit_code": 1}
                response.raise_for_status()
                result = response.json()
                if result["status"] != "running":
                    return {"output": result.get("output") or "(no output)",
                            "exit_code": result.get("exit_code", 1), "execution": "separate_container",
                            **({"error": result["error"]} if result.get("error") else {})}
                if ctx.get("progress_cb"):
                    await ctx["progress_cb"]({"output": result.get("output", "")[-2000:],
                                               "execution": "separate_container"})
                await asyncio.sleep(min(1, max(0, deadline - time.monotonic())))
    except asyncio.CancelledError:
        raise
    except Exception:
        return {"error": "Separate execution worker unavailable; command was not retried locally", "exit_code": 1}
    finally:
        if job:
            async def cleanup():
                async with httpx.AsyncClient(timeout=5, trust_env=False) as client:
                    await client.delete(f"{url}/jobs/{job}", headers=headers)
            try:
                await asyncio.shield(cleanup())
            except (Exception, asyncio.CancelledError):
                pass
