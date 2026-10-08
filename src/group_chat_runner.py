"""Run team assignments through the ordinary authenticated chat route."""
from __future__ import annotations

import asyncio
import json
from urllib.parse import urlencode

from starlette.requests import Request
from src import agent_runs


def create_assignment_runner(chat_stream, session_manager):
    async def run(session_id, prompt, *, read_only, owner, context):
        context = context or {}
        scope = dict(context.get("request_scope") or {})
        scope.update(type="http", method="POST", path="/api/chat/stream",
                     raw_path=b"/api/chat/stream", query_string=b"", scheme="http", http_version="1.1")
        scope["state"] = dict(scope.get("state") or {})
        from src.auth_helpers import storage_owner_for_request
        from routes.session_routes import _verify_session_owner
        options = dict(context.get("options") or {})
        options.update(message=prompt, session=session_id, mode="agent", incognito="false")
        if read_only:
            options.update(plan_mode="true", allow_bash="false")
        data = urlencode(options).encode()
        scope["headers"] = list(scope.get("headers") or []) + [
            (b"content-type", b"application/x-www-form-urlencoded"),
            (b"content-length", str(len(data)).encode()),
        ]
        consumed = False
        async def receive():
            nonlocal consumed
            if not consumed:
                consumed = True
                return {"type": "http.request", "body": data, "more_body": False}
            return {"type": "http.request", "body": b"", "more_body": False}
        request = Request(scope, receive)
        if storage_owner_for_request(request) != owner:
            raise RuntimeError("Team request owner changed; reopen the team chat")
        _verify_session_owner(request, session_id)
        session = session_manager.get_session(session_id)
        expected = (context.get("models") or {}).get(session_id)
        if not session or not expected or session.model != expected:
            raise RuntimeError("Team participant model changed; recreate the group")
        if agent_runs.is_active(session_id):
            raise RuntimeError("Participant chat already has an active run")
        run_id = None
        buffer = ""
        output = []
        tool_reports = []
        tools = 0
        failed = False
        complete = False
        needs_user_input = False
        verification_passed = None
        required_verification_failed = False
        try:
            response = await chat_stream(request)
            run_id = response.headers.get("X-Odysseus-Run-Id")
            async for chunk in response.body_iterator:
                buffer += chunk.decode() if isinstance(chunk, bytes) else chunk
                while "\n\n" in buffer:
                    block, buffer = buffer.split("\n\n", 1)
                    for line in block.splitlines():
                        if not line.startswith("data: "):
                            continue
                        if line[6:] == "[DONE]":
                            complete = True
                            continue
                        try:
                            event = json.loads(line[6:])
                        except ValueError:
                            continue
                        if not isinstance(event, dict):
                            continue
                        if event.get("error") or event.get("type") == "error":
                            failed = True
                        if (event.get("type") == "agent_terminal"
                                and isinstance(event.get("data"), dict)
                                and event["data"].get("failed")):
                            failed = True
                        if event.get("type") in {
                            "loop_breaker_triggered", "intent_nudge_exhausted",
                            "budget_exceeded", "rounds_exhausted",
                        }:
                            failed = True
                        if event.get("type") == "verification" and isinstance(event.get("passed"), bool):
                            verification_passed = event["passed"]
                        ask_user = event.get("ask_user") or (event.get("data") if event.get("type") == "ask_user" else {})
                        if (event.get("type") in {"tool_approval", "ask_user"} or event.get("approval_id")
                                or isinstance(ask_user, dict) and ask_user.get("kind") == "tool_approval"):
                            needs_user_input = True
                        if isinstance(event.get("delta"), str):
                            output.append(event["delta"])
                            if sum(map(len, output)) > 24_000:
                                output = ["".join(output)[-24_000:]]
                        if event.get("type") == "tool_output":
                            tools += 1
                            if event.get("tool") == "verification":
                                try:
                                    report_data = json.loads(event.get("output") or "{}")
                                    results = report_data.get("results", [])
                                    required_verification_failed = any(
                                        isinstance(item, dict)
                                        and item.get("required", True) is True
                                        and item.get("passed") is False
                                        for item in results if isinstance(results, list)
                                    )
                                except (TypeError, ValueError):
                                    pass
                            command = f" ({event['command']})" if event.get("command") else ""
                            report = f"{event.get('tool') or 'tool'}{command}: {event.get('output') or ''}"
                            if sum(map(len, tool_reports)) < 10_000:
                                tool_reports.append(report[:3_000])
            if failed or agent_runs.get_status(session_id) in {"error", "stopped"}:
                raise RuntimeError("Assignment stopped before completion; inspect the participant chat")
            if not complete:
                raise RuntimeError("Assignment ended without a completion signal")
            if needs_user_input:
                raise RuntimeError("Assignment needs your approval or input. Open the participant chat; inspect before retrying the team pass.")
            if verification_passed is False and required_verification_failed:
                raise RuntimeError("Required project checks failed; inspect the participant chat before review")
            result = "\n\n".join(part for part in ["".join(output).strip(), *tool_reports] if part)
            if verification_passed is not True:
                result = "\n\n".join(part for part in [result,
                    "[Project verification: human review required; no passing configured checks were reported.]"] if part)
            return result[:12_000] or (f"Completed {tools} tool calls; inspect the participant chat." if tools else "")
        except BaseException:
            if run_id:
                active = agent_runs.get_active_run(session_id)
                if active and active.run_id == run_id:
                    agent_runs.stop(session_id, run_id)
                    try:
                        await asyncio.wait_for(asyncio.shield(active.task), timeout=5)
                    except (Exception, asyncio.CancelledError):
                        pass
            raise
    return run
