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
from pathlib import PurePosixPath
import sys
import time
import socket
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import Request, build_opener, HTTPCookieProcessor
from http.cookiejar import CookieJar

EVENT_FIELDS = {
    "model_actual": ("model", "requested_model", "endpoint_id", "round"),
    "fallback": ("selected_model", "answered_by", "answered_by_endpoint_id", "round"),
    "agent_terminal": ("status", "reason", "failed", "model", "requested_model", "endpoint_id", "round"),
    "verification": ("passed", "status", "round"),
    "coding_work_packet": ("stage", "test_status", "review_status", "round"),
    "metrics": ("model", "requested_model", "endpoint_id", "actual_endpoint_id", "input_tokens", "output_tokens", "total_tokens", "total_time", "tps"),
    "error": ("status", "code", "fallback_eligible"),
}
MAX_TASK_APPROVALS = 3


def summarize_event(event: dict) -> dict | None:
    """Keep bounded routing and outcome metadata; never retain prompt/output text."""
    kind = event.get("type") or ("error" if event.get("error") else None)
    if kind not in EVENT_FIELDS:
        return None
    nested = event.get("data") if isinstance(event.get("data"), dict) else {}
    source = {**nested, **event}
    summary = {"type": kind}
    for key in EVENT_FIELDS[kind]:
        value = source.get(key)
        if isinstance(value, (str, int, float, bool)):
            summary[key] = value[:128] if isinstance(value, str) else value
    if kind == "agent_terminal" and isinstance(nested.get("failure"), dict):
        failure = nested["failure"]
        for key in ("status", "timeout_seconds"):
            value = failure.get(key)
            if isinstance(value, (str, int, float)):
                summary[f"failure_{key}"] = value[:128] if isinstance(value, str) else value
    return summary


def approval_card(event: dict) -> tuple[dict | None, bool]:
    """Return an exact tool-approval card and whether approval was requested."""
    candidates = []
    nested = event.get("data") if isinstance(event.get("data"), dict) else {}
    for source in (event, nested):
        value = source.get("ask_user")
        if isinstance(value, dict):
            candidates.append(value)
        if event.get("type") in {"ask_user", "tool_approval", "approval_required"}:
            candidates.append(source)
    for candidate in candidates:
        if candidate.get("kind") == "tool_approval":
            return candidate, True
    requested = event.get("type") in {"tool_approval", "approval_required"}
    return None, requested


def valid_approval_id(value) -> bool:
    return (
        isinstance(value, str) and bool(value) and value == value.strip()
        and len(value) <= 256 and not any(ord(char) < 32 for char in value)
    )


def approval_binding_matches(event: dict, card: dict, session_id: str, workspace: str) -> bool:
    nested = event.get("data") if isinstance(event.get("data"), dict) else {}
    for source in (event, nested, card):
        bound_session = source.get("session_id") or source.get("session")
        if bound_session is not None and str(bound_session) != str(session_id):
            return False
        bound_workspace = source.get("workspace") or source.get("container_workspace")
        if bound_workspace is not None and str(bound_workspace) != workspace:
            return False
    return True


def validate_base(value: str) -> str:
    parts = urlsplit(value)
    if parts.scheme not in {"http", "https"} or not parts.hostname or parts.username or parts.password or parts.query or parts.fragment:
        raise ValueError("API base must be an http(s) URL without credentials, query, or fragment")
    return value.rstrip("/")


def source_files(raw: str | None, workspace: Path) -> tuple[str, ...]:
    files = ["calc.py"] if raw is None else json.loads(raw)
    if (not isinstance(files, list) or not files
            or any(not isinstance(name, str) or not name for name in files)):
        raise ValueError("source files must be a non-empty JSON string array")
    checked = []
    root = workspace.resolve(strict=True)
    for name in files:
        path = PurePosixPath(name)
        candidate = workspace / name
        if ("\\" in name or path.is_absolute() or path.as_posix() != name
                or any(part in {"", ".", ".."} for part in path.parts)
                or not candidate.is_file()):
            raise ValueError("source files must be existing workspace-relative paths")
        try:
            candidate.resolve(strict=True).relative_to(root)
        except ValueError as exc:
            raise ValueError("source files must remain inside the workspace") from exc
        checked.append(name)
    if len(set(checked)) != len(checked):
        raise ValueError("source files must be unique")
    return tuple(checked)


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
    parser.add_argument("--files-json", help="JSON array of source files in this fixture")
    parser.add_argument("--approve-task", action="store_true",
                        help="Approve at most three exact tool requests in this isolated QA workspace")
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
        files = source_files(args.files_json, host)
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
    deadline = started + args.timeout
    approval_needed = False
    approval_count = 0
    stream_ended = False
    verification_passed = None
    terminal = None
    actual_route = {}
    evidence = []
    stream_error = False
    terminal_failure = False
    terminal_unverified = False
    try:
        with post("/api/session", {
            "name": "Coding comparison fixture",
            "model": args.model,
            "endpoint_id": args.endpoint_id,
            "skip_validation": "true",
        }, min(max(0.1, deadline - time.monotonic()), 30)) as response:
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
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError
            stream_ended = False
            request = Request(api_base + "/api/chat_stream", data=urlencode(fields).encode(), headers={"Content-Type": "application/x-www-form-urlencoded"})
            response = opener.open(request, timeout=remaining)
            run_id = response.headers.get("X-Odysseus-Run-Id")
            if not run_id:
                response.close()
                raise RuntimeError("stream response omitted its run ID")
            pending_approval = None
            approval_invalid = False
            with response:
                for raw in response:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise TimeoutError
                    try:
                        response.fp.raw._sock.settimeout(remaining)
                    except AttributeError:
                        pass
                    line = raw.decode("utf-8", "replace").strip()
                    if not line.startswith("data: "):
                        continue
                    data = line[6:]
                    if data == "[DONE]":
                        stream_ended = True
                        break
                    try:
                        event = json.loads(data)
                    except json.JSONDecodeError:
                        continue
                    if not isinstance(event, dict):
                        continue
                    summary = summarize_event(event)
                    if summary:
                        evidence.append(summary)
                        evidence = evidence[-32:]
                        if summary["type"] in {"model_actual", "fallback", "metrics"}:
                            actual_route.update({
                                key: summary[key]
                                for key in ("model", "requested_model", "endpoint_id", "actual_endpoint_id", "answered_by", "answered_by_endpoint_id", "round")
                                if key in summary
                            })
                        elif summary["type"] == "agent_terminal":
                            terminal = summary
                            reason = summary.get("reason")
                            is_unverified = reason in {"completion_unverified", "research_incomplete"}
                            terminal_unverified = is_unverified
                            terminal_failure = (
                                bool(summary.get("failed"))
                                or summary.get("status") in {"failed", "error"}
                            ) and not is_unverified
                        elif summary["type"] == "verification":
                            verification_passed = summary.get("passed") is True
                        elif summary["type"] == "error":
                            stream_error = True
                    card, requested = approval_card(event)
                    if card is not None or requested:
                        if not args.approve_task:
                            approval_needed = True
                        elif (card is None or not valid_approval_id(card.get("approval_id"))
                              or not approval_binding_matches(event, card, session_id, args.container_workspace)
                              or approval_count >= MAX_TASK_APPROVALS):
                            approval_needed = True
                            approval_invalid = True
                            pending_approval = None
                        else:
                            pending_approval = card["approval_id"]
                    if event.get("type") == "done" or event.get("done") is True:
                        stream_ended = True
                        break
            if time.monotonic() >= deadline:
                raise TimeoutError
            if pending_approval is None or approval_needed:
                break
            approval_count += 1
            evidence.append({"type": "approval_decision", "decision": "approve_task"})
            evidence = evidence[-32:]
            fields["message"] = ""
            fields["tool_approval_id"] = pending_approval
            fields["tool_approval_decision"] = "approve_task"
            # This exact pending approval is consumed by the same session; no
            # session-wide or global approval is granted.
        if approval_needed:
            status, returncode = ("approval_invalid", 4) if approval_invalid else ("approval_needed", 3)
        elif stream_error or terminal_failure:
            status, returncode = "failed", 1
        elif terminal_unverified or verification_passed is False:
            status, returncode = "unverified", 2
        elif (stream_ended and terminal
              and terminal.get("status") in {"complete", "completed", "success", "passed"}
              and not terminal.get("failed")):
            status, returncode = "complete", 0
        else:
            status, returncode = "incomplete", 2
        emit(status=status,
             session_id=session_id, run_id=run_id, model=args.model, endpoint_id=args.endpoint_id,
             preset_id=args.preset_id, source_files=list(files),
             seconds=round(time.monotonic() - started, 3), output_saved=False,
             stream_ended=stream_ended, actual_route=actual_route, terminal=terminal,
             verification_passed=verification_passed, approval_count=approval_count, evidence=evidence)
        return returncode
    except (TimeoutError, socket.timeout):
        stopped = False
        if session_id and run_id:
            try:
                stop_request = Request(api_base + "/api/chat/stop/" + str(session_id), data=b"", method="POST",
                                       headers={"X-Odysseus-Run-Id": run_id})
                with opener.open(stop_request, timeout=max(0.1, min(10, deadline - time.monotonic()))):
                    stopped = True
            except (HTTPError, URLError, OSError):
                pass
        emit(status="timeout", session_id=session_id, run_id=run_id, model=args.model,
             endpoint_id=args.endpoint_id, preset_id=args.preset_id, source_files=list(files), stopped_exact_run=stopped,
             seconds=round(time.monotonic() - started, 3), output_saved=False,
             stream_ended=stream_ended, actual_route=actual_route, terminal=terminal,
             verification_passed=verification_passed, approval_count=approval_count, evidence=evidence)
        return 124
    except (HTTPError, URLError, OSError, RuntimeError, ValueError) as exc:
        # Return only exception class; HTTP bodies and request headers can hold
        # environment- or account-specific details.
        emit(status="error", error=type(exc).__name__, session_id=session_id,
             run_id=run_id, model=args.model, endpoint_id=args.endpoint_id, preset_id=args.preset_id,
             source_files=list(files),
             seconds=round(time.monotonic() - started, 3), output_saved=False,
             stream_ended=stream_ended, actual_route=actual_route, terminal=terminal,
             verification_passed=verification_passed, approval_count=approval_count, evidence=evidence)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
