"""Safe, actionable summaries for streamed provider failures."""

import json
import re
from typing import Any, Optional


def _status(value: Any) -> Optional[int]:
    if isinstance(value, bool):
        return None
    try:
        result = int(value)
    except (TypeError, ValueError):
        return None
    return result if 100 <= result <= 599 else None


def describe_stream_failure(
    error: Any = None,
    status: Any = None,
    timeout_seconds: Any = None,
) -> dict:
    """Return only an allowlisted message and normalized HTTP status."""
    status = _status(status)
    hint = str(error or "").lower()
    timeout = None
    try:
        if timeout_seconds is not None:
            timeout = max(1, int(float(timeout_seconds)))
    except (TypeError, ValueError, OverflowError):
        pass
    if timeout is None:
        match = re.search(r"\b(\d{1,6})-second idle read timeout", hint)
        if match:
            timeout = int(match.group(1))

    is_read_timeout = "read timeout" in hint or "idle read timeout" in hint
    if is_read_timeout:
        reason = "read_timeout"
    elif any(term in hint for term in ("connecterror", "connect timeout", "cannot reach", "could not connect")):
        reason = "connect"
    elif "pool timeout" in hint or "connection pool timeout" in hint or "no upstream connection became available" in hint:
        reason = "pool_timeout"
    elif "network error" in hint or "protocol error" in hint or "connection to the provider failed" in hint:
        reason = "network"
    elif status == 401:
        reason = "auth"
    elif status == 403:
        reason = "forbidden"
    elif status == 404:
        reason = "not_found"
    elif status == 429:
        reason = "rate_limit"
    elif status in (400, 422):
        reason = "bad_request"
    elif status is not None and 500 <= status <= 599:
        reason = "server"
    elif status is not None:
        reason = "http"
    else:
        reason = "unknown"

    if reason == "read_timeout":
        status = status or 504
        if timeout is not None:
            message = (
                f"Provider sent no further data within the {timeout}-second idle "
                "read timeout. It may still be loading or queued; check service "
                f"health and retry (HTTP {status})."
            )
        else:
            message = (
                "Provider sent no further data before the idle read timeout. It "
                "may still be loading or queued; check service health and retry "
                f"(HTTP {status})."
            )
    elif reason == "connect":
        message = "Could not connect to the provider. Check its network and service health, then retry."
    elif reason == "pool_timeout":
        message = "No upstream connection became available. Check provider load and retry."
    elif reason == "network":
        message = "The connection to the provider failed. Check network and service health, then retry."
    elif reason == "auth":
        message = "Provider authentication failed (HTTP 401). Check the configured credentials."
    elif reason == "forbidden":
        message = "Provider denied access (HTTP 403). Check account permissions and model access."
    elif reason == "not_found":
        message = "Provider could not find the requested model or endpoint (HTTP 404). Check the route configuration."
    elif reason == "rate_limit":
        message = "Provider rate limit reached (HTTP 429). Wait briefly, then retry."
    elif reason == "bad_request":
        message = f"Provider rejected the request (HTTP {status}). Check the model and request settings."
    elif reason == "server":
        message = f"Provider service failed (HTTP {status}). Check service health and retry."
    elif status is not None:
        message = f"Provider request failed (HTTP {status}). Check provider settings and service health."
    else:
        message = "Provider request failed. Check provider settings and service health, then retry."

    result = {"message": message, "status": status, "category": reason}
    if reason == "read_timeout" and timeout is not None:
        result["timeout_seconds"] = timeout
    return result


def describe_sse_failure(chunk: str) -> dict:
    """Extract status and timeout hints from an error SSE without saving raw detail."""
    payload = {}
    try:
        line = next(line[6:] for line in str(chunk or "").splitlines() if line.startswith("data: "))
        value = json.loads(line)
        if isinstance(value, dict):
            payload = value
    except (StopIteration, json.JSONDecodeError):
        pass
    return describe_stream_failure(
        payload.get("error") or payload.get("text"),
        payload.get("status"),
        payload.get("timeout_seconds"),
    )


def explain_sse_failure(chunk: str) -> str:
    """Add safe guidance without changing machine errors or fallback flags."""
    if not chunk.startswith("event: error"):
        return chunk
    try:
        line = next(line[6:] for line in chunk.splitlines() if line.startswith("data: "))
        payload = json.loads(line)
        if not isinstance(payload, dict):
            return chunk
    except (StopIteration, json.JSONDecodeError):
        return chunk
    payload["hint"] = describe_sse_failure(chunk)["message"]
    return f"event: error\ndata: {json.dumps(payload)}\n\n"
