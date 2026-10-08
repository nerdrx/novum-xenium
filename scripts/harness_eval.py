"""Small same-model coding benchmark against a running NX app.

Use a disposable app instance and a workspace mounted in both this script and
the app. Supply the browser cookie through NX_EVAL_COOKIE, never a CLI argument.
Results require actual file tests; assistant completion text is not evidence.
"""
from __future__ import annotations

import argparse
import json
import math
import os
from pathlib import Path
import signal
import subprocess
import time
import urllib.parse
import urllib.request
import uuid

CASES = (
    {"name": "repair", "files": {"calc.py": "def add(a, b):\n    return a - b\n"},
     "prompt": "Fix calc.py so add correctly adds positive and negative numbers. Inspect the file, edit it, and verify the result.",
     "check": "from calc import add; assert add(2,3)==5; assert add(-2,3)==1; assert add(0,0)==0"},
    {"name": "implement", "files": {},
     "prompt": "Create strings.py with slug(text): lowercase text, replace runs of non ASCII letters or digits with one hyphen, strip edge hyphens. Test punctuation, blank input and repeated spaces.",
     "check": "from strings import slug; assert slug(' Hello, WORLD! ')== 'hello-world'; assert slug('')==''; assert slug('a   b')=='a-b'; assert slug('---')==''"},
    {"name": "multifile", "files": {"core.py": "def total(values):\n    return len(values)\n", "report.py": "from core import total\ndef summary(values):\n    return {'total': total(values), 'count': total(values)}\n"},
     "prompt": "Repair this project: core.total must sum numeric values; report.summary must return their sum and count, including empty input. Change the responsible files and verify.",
     "check": "from report import summary; assert summary([2,3])=={'total':5,'count':2}; assert summary([])=={'total':0,'count':0}; assert summary([-1,4])=={'total':3,'count':2}"},
)

# These are terminal-but-incomplete outcomes. A [DONE] delimiter only means the
# stream ended; none of these means the requested work was completed.
INCOMPLETE_EVENTS = {
    "ask_user", "rounds_exhausted", "budget_exceeded",
    "loop_breaker_triggered", "intent_nudge_exhausted",
}
_FILE_CHECK_DRAIN_TIMEOUT = 2


def parse_event(event_name, payload):
    """Return safe benchmark facts from one SSE event, never model text."""
    if payload == "[DONE]":
        return {"done": True}
    try:
        data = json.loads(payload)
    except (TypeError, ValueError):
        return {"stream_error": True} if event_name == "error" else {}
    if not isinstance(data, dict):
        return {"stream_error": True} if event_name == "error" else {}
    kind = data.get("type")
    status = data.get("status")
    if event_name == "error" or kind == "error" or data.get("error"):
        result = {"stream_error": True}
        if isinstance(status, int):
            result["error_status"] = status
        return result
    result = {}
    if kind in {"agent_terminal", "chat_terminal"} and isinstance(data.get("data"), dict) and data["data"].get("failed"):
        result["incomplete"] = f"{kind}_failed"
    if kind == "verification" and data.get("passed") is False:
        result["incomplete"] = "verification_failed"
    if kind == "tool_start":
        result["tool_calls"] = 1
    if kind in INCOMPLETE_EVENTS:
        result["incomplete"] = kind
    return result


def stream_events(response, deadline):
    """Keep heartbeat-producing streams inside the case's wall-clock budget."""
    current_event = "message"
    for raw in response:
        if time.monotonic() >= deadline:
            raise TimeoutError("Evaluation case exceeded its wall-clock budget")
        line = raw.decode("utf-8", "replace").strip()
        if line.startswith("event: "):
            current_event = line[7:]
        elif line.startswith("data: "):
            yield parse_event(current_event, line[6:])
            current_event = "message"


def run_file_check(case, fixture, timeout=15):
    command = [os.sys.executable, "-c", case["check"]]
    process = subprocess.Popen(
        command, cwd=fixture, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        start_new_session=(os.name == "posix"),
    )
    try:
        stdout, stderr = process.communicate(timeout=timeout)
    except subprocess.TimeoutExpired as exc:
        # The verifier imports generated files, which can spawn child
        # processes. Stop children in its process group before moving on to
        # the next fixture; independently detached children need separate cleanup.
        if os.name == "posix":
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        else:
            process.kill()
        try:
            stdout, stderr = process.communicate(timeout=_FILE_CHECK_DRAIN_TIMEOUT)
        except subprocess.TimeoutExpired as drain_exc:
            # A child can deliberately detach from the verifier's process
            # group while inheriting its pipes. Do not let draining those
            # descriptors turn the verifier timeout into an unbounded wait.
            stdout = drain_exc.output if drain_exc.output is not None else exc.output
            stderr = drain_exc.stderr if drain_exc.stderr is not None else exc.stderr
            for pipe in (process.stdout, process.stderr):
                if pipe is not None:
                    pipe.close()
        exc.output = stdout
        exc.stderr = stderr
        raise
    return subprocess.CompletedProcess(command, process.returncode, stdout, stderr)


def case_passes(*, done, errors, check_returncode, tool_calls):
    return bool(done and not errors and check_returncode == 0 and tool_calls > 0)


def stop_exact_run(request_fn, session_id, run_id):
    """Request cancellation for the run bound to this stream only."""
    if not run_id:
        return False
    with request_fn(f"/api/chat/stop/{session_id}",
                    headers={"X-Odysseus-Run-Id": run_id}, timeout=10):
        pass
    return True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://localhost:7000")
    parser.add_argument("--workspace-root", required=True, help="Local writable fixture root")
    parser.add_argument("--app-workspace-root", required=True, help="Same fixture root as seen by the app")
    parser.add_argument("--model", required=True)
    parser.add_argument("--endpoint-id", required=True)
    parser.add_argument("--report", default="harness-eval.json")
    parser.add_argument("--case-timeout", type=float, default=600, help="Maximum stream wall-clock seconds per case (default: 600)")
    args = parser.parse_args()
    if not math.isfinite(args.case_timeout) or args.case_timeout <= 0:
        parser.error("--case-timeout must be a positive finite number")
    cookie = os.environ.get("NX_EVAL_COOKIE", "")
    base = args.base_url.rstrip("/")
    def request(path, fields=None, *, headers=None, timeout=600):
        payload = urllib.parse.urlencode(fields).encode() if fields is not None else None
        request_headers = {"Cookie": cookie}
        request_headers.update(headers or {})
        if payload is not None:
            request_headers["Content-Type"] = "application/x-www-form-urlencoded"
        return urllib.request.urlopen(urllib.request.Request(base + path, data=payload, headers=request_headers), timeout=timeout)
    report = {"model": args.model, "endpoint_id": args.endpoint_id, "cases": []}
    batch = "nx-eval-" + uuid.uuid4().hex[:10]
    for case in CASES:
        fixture = Path(args.workspace_root) / batch / case["name"]
        fixture.mkdir(parents=True, exist_ok=False)
        for name, content in case["files"].items():
            (fixture / name).write_text(content)
        with request("/api/session", {"name": f"Evaluation: {case['name']}", "model": args.model,
                    "endpoint_id": args.endpoint_id, "skip_validation": "true"}) as response:
            session = json.load(response)["id"]
        started = time.monotonic()
        errors, tool_calls, done, run_id = [], 0, False, None
        stop_requested = False
        try:
            with request("/api/chat_stream", {"message": case["prompt"], "session": session,
                         "mode": "agent", "allow_bash": "true", "allow_web_search": "false",
                         "selected_endpoint_id": args.endpoint_id,
                         "workspace": f"{args.app_workspace_root.rstrip('/')}/{batch}/{case['name']}"}, timeout=args.case_timeout) as response:
                run_id = response.headers.get("X-Odysseus-Run-Id")
                for facts in stream_events(response, started + args.case_timeout):
                    done = done or facts.get("done", False)
                    tool_calls += facts.get("tool_calls", 0)
                    if facts.get("incomplete"):
                        errors.append(facts["incomplete"])
                    if facts.get("stream_error"):
                        errors.append("stream_error")
                        if "error_status" in facts:
                            errors.append(f"http_{facts['error_status']}")
        except Exception as exc:
            # Detached runs outlive this connection. Stop only the exact run
            # whose id arrived with the stream response; never cancel a newer run.
            errors.append(type(exc).__name__)
        if not done and run_id:
            try:
                stop_requested = stop_exact_run(request, session, run_id)
            except Exception as exc:
                errors.append(f"stop_{type(exc).__name__}")
        # The fixture's own imports and assertions are the outcome evidence.
        check_returncode = None
        try:
            check_returncode = run_file_check(case, fixture).returncode
        except Exception as exc:
            errors.append(f"verification_{type(exc).__name__}")
        evidence = None
        try:
            with request(f"/api/chat/evidence/{session}", timeout=10) as response:
                evidence = json.load(response)
        except Exception as exc:
            errors.append(f"evidence_{type(exc).__name__}")
        report["cases"].append({"name": case["name"], "session_id": session, "run_id": run_id,
            "seconds": round(time.monotonic() - started, 2), "tool_calls": tool_calls,
            "stream_complete": done, "incomplete": bool(errors), "errors": errors,
            "stop_requested": stop_requested, "file_tests_passed": check_returncode == 0,
            "passed": case_passes(done=done, errors=errors,
                                  check_returncode=check_returncode, tool_calls=tool_calls),
            "evidence": evidence})
        Path(args.report).write_text(json.dumps(report, indent=2))
    print(f"{sum(c['passed'] for c in report['cases'])}/{len(CASES)} tasks passed; report: {args.report}")
    return 0 if all(c["passed"] for c in report["cases"]) else 1


if __name__ == "__main__":
    raise SystemExit(main())
