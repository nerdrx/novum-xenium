"""Run the isolated coding fixture through Novum's authenticated agent API.

Authentication is read from one named environment variable and is never logged.
The container-visible workspace must be supplied explicitly by the operator.
"""
from __future__ import annotations

import argparse
import json
import math
import os
from pathlib import Path
import sys
import time
import socket
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import Request, build_opener, HTTPCookieProcessor
from http.cookiejar import CookieJar


def validate_base(value: str) -> str:
    parts = urlsplit(value)
    if parts.scheme not in {"http", "https"} or not parts.hostname or parts.username or parts.password or parts.query or parts.fragment:
        raise ValueError("API base must be an http(s) URL without credentials, query, or fragment")
    return value.rstrip("/")


def emit(**values) -> None:
    print(json.dumps(values, sort_keys=True), flush=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--task-file", required=True)
    parser.add_argument("--host-workspace", required=True, help="Host path to this agent's isolated fixture copy")
    parser.add_argument("--container-workspace", required=True, help="Same workspace as visible to the Novum app")
    parser.add_argument("--api-base", required=True)
    parser.add_argument("--endpoint-id", required=True)
    parser.add_argument("--preset-id", help="Novum preset supplying generation settings for this comparison")
    parser.add_argument("--model", required=True)
    parser.add_argument("--session-cookie-env", default="ODYSSEUS_SESSION", help="Environment variable containing the app session cookie value")
    parser.add_argument("--timeout", type=float, default=600)
    args = parser.parse_args()

    try:
        api_base = validate_base(args.api_base)
        if not args.model.strip() or not args.endpoint_id.strip():
            raise ValueError("model and endpoint ID must not be empty")
        if args.preset_id is not None and not args.preset_id.strip():
            raise ValueError("preset ID must not be empty")
        if not math.isfinite(args.timeout) or args.timeout <= 0:
            raise ValueError("timeout must be a positive finite number")
        host = Path(args.host_workspace).resolve(strict=True)
        task_file = Path(args.task_file).resolve(strict=True)
        task_file.relative_to(host)
        if not (host / "calc.py").is_file():
            raise ValueError("workspace must contain the comparison fixture calc.py")
        if not args.container_workspace.startswith("/"):
            raise ValueError("container workspace must be an absolute path")
        cookie_value = os.environ.get(args.session_cookie_env, "").strip()
        if not cookie_value or any(c in cookie_value for c in "\r\n;,"):
            raise ValueError(f"missing or invalid cookie in environment variable {args.session_cookie_env}")
    except (OSError, ValueError) as exc:
        parser.error(str(exc))

    cookie_jar = CookieJar()
    # Set a host-scoped cookie through the cookie jar; token values stay out of
    # command-line arguments, temporary files, logs, and returned metadata.
    from http.cookiejar import Cookie
    parts = urlsplit(api_base)
    cookie_jar.set_cookie(Cookie(
        version=0, name="odysseus_session", value=cookie_value, port=None,
        port_specified=False, domain=parts.hostname, domain_specified=False,
        domain_initial_dot=False, path="/", path_specified=True, secure=parts.scheme == "https",
        expires=None, discard=True, comment=None, comment_url=None, rest={},
        rfc2109=False,
    ))
    opener = build_opener(HTTPCookieProcessor(cookie_jar))

    def post(path: str, fields: dict[str, str], timeout: float):
        data = urlencode(fields).encode()
        req = Request(api_base + path, data=data, headers={"Content-Type": "application/x-www-form-urlencoded"})
        return opener.open(req, timeout=timeout)

    session_id = None
    run_id = None
    started = time.monotonic()
    approval_needed = False
    complete = False
    try:
        with post("/api/session", {
            "name": "Coding comparison fixture",
            "model": args.model,
            "endpoint_id": args.endpoint_id,
            "skip_validation": "true",
        }, min(args.timeout, 30)) as response:
            payload = json.load(response)
        session_id = payload.get("id") or payload.get("session_id")
        if not session_id:
            raise RuntimeError("session response omitted its ID")
        prompt = task_file.read_text(encoding="utf-8")
        fields = {
            "message": prompt,
            "session": str(session_id),
            "mode": "agent",
            "allow_bash": "true",
            "allow_web_search": "false",
            "selected_endpoint_id": args.endpoint_id,
            "workspace": args.container_workspace,
        }
        if args.preset_id:
            fields["preset_id"] = args.preset_id
        request = Request(api_base + "/api/chat_stream", data=urlencode(fields).encode(), headers={"Content-Type": "application/x-www-form-urlencoded"})
        response = opener.open(request, timeout=(args.timeout + 15))
        run_id = response.headers.get("X-Odysseus-Run-Id")
        if not run_id:
            response.close()
            raise RuntimeError("stream response omitted its run ID")
        deadline = started + args.timeout
        with response:
            for raw in response:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError
                # Bound a blocked SSE read by the remaining whole-run budget.
                try:
                    response.fp.raw._sock.settimeout(remaining)
                except AttributeError:
                    pass
                line = raw.decode("utf-8", "replace").strip()
                if not line.startswith("data: "):
                    continue
                data = line[6:]
                if data == "[DONE]":
                    complete = True
                    break
                try:
                    event = json.loads(data)
                except json.JSONDecodeError:
                    continue
                # A human can inspect the exact pending action in the app. This
                # harness never grants broad approve-task or approval-all access.
                ask_user = event.get("ask_user")
                if (event.get("type") in {"tool_approval", "approval_required"}
                        or (event.get("type") == "ask_user" and isinstance(ask_user, dict)
                            and ask_user.get("kind") == "tool_approval")):
                    approval_needed = True
                    break
                if event.get("type") in {"agent_terminal", "done"} or event.get("done") is True:
                    complete = True
                    break
            if not complete and time.monotonic() > deadline:
                raise TimeoutError
        emit(status="approval_needed" if approval_needed else ("complete" if complete else "incomplete"),
             session_id=session_id, run_id=run_id, model=args.model, endpoint_id=args.endpoint_id,
             preset_id=args.preset_id,
             seconds=round(time.monotonic() - started, 3), output_saved=False)
        return 3 if approval_needed else (0 if complete else 2)
    except (TimeoutError, socket.timeout):
        stopped = False
        if session_id and run_id:
            try:
                stop_request = Request(api_base + "/api/chat/stop/" + str(session_id), data=b"", method="POST",
                                       headers={"X-Odysseus-Run-Id": run_id})
                with opener.open(stop_request, timeout=10):
                    stopped = True
            except (HTTPError, URLError, OSError):
                pass
        emit(status="timeout", session_id=session_id, run_id=run_id, model=args.model,
             endpoint_id=args.endpoint_id, preset_id=args.preset_id, stopped_exact_run=stopped,
             seconds=round(time.monotonic() - started, 3), output_saved=False)
        return 124
    except (HTTPError, URLError, OSError, RuntimeError, ValueError) as exc:
        # Return only exception class; HTTP bodies and request headers can hold
        # environment- or account-specific details.
        emit(status="error", error=type(exc).__name__, session_id=session_id,
             run_id=run_id, model=args.model, endpoint_id=args.endpoint_id, preset_id=args.preset_id,
             seconds=round(time.monotonic() - started, 3), output_saved=False)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
