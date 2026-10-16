"""Manage local host alarms through the authenticated desktop bridge."""

from __future__ import annotations

import json
import logging
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import quote
from uuid import UUID

import httpx

from src.runtime_paths import get_app_root
from src.tools._common import _parse_tool_args
from src.user_time import now_user_local, user_timezone

logger = logging.getLogger(__name__)

_TIME_ONLY = re.compile(r"^(\d{1,2})(?::(\d{2}))?$")
_ALLOWED = {
    "create": {"action", "at", "time", "label", "volume_percent", "duration_seconds"},
    "list": {"action"},
    "stop": {"action", "alarm_id"},
}


def _bridge_url() -> str:
    value = os.environ.get("NOVUM_ALARM_BRIDGE_URL", "http://127.0.0.1:8127").strip()
    # The bridge is a local host-control boundary. Never allow model-controlled
    # URLs, and keep configuration loopback-only even when supplied by env.
    from urllib.parse import urlsplit

    parsed = urlsplit(value)
    if (parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost", "::1"}
            or parsed.port is None or parsed.path not in {"", "/"}
            or parsed.query or parsed.fragment or parsed.username or parsed.password):
        raise ValueError("alarm bridge URL must be an HTTP loopback address")
    return value.rstrip("/")


def _token_path() -> Path:
    override = os.environ.get("NOVUM_ALARM_BRIDGE_TOKEN_FILE")
    return Path(override).expanduser() if override else Path(get_app_root()) / ".local" / "novum-alarms" / "bridge-token"


def _resolve_alarm_time(value: Any) -> datetime:
    if not isinstance(value, str) or not value.strip():
        raise ValueError("Provide an alarm time as HH:MM or an ISO date and time.")
    raw = value.strip()
    match = _TIME_ONLY.fullmatch(raw)
    local_now = now_user_local()
    if match:
        hour = int(match.group(1))
        minute = int(match.group(2) or 0)
        if hour > 23 or minute > 59:
            raise ValueError("Use a valid 24-hour time such as 15 or 15:00.")
        resolved = local_now.replace(hour=hour, minute=minute, second=0, microsecond=0)
    else:
        try:
            resolved = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        except ValueError as exc:
            raise ValueError("Use HH:MM or an ISO date and time, such as 2026-10-16T15:00.") from exc
        if "T" not in raw and " " not in raw:
            raise ValueError("Include a time; date-only alarms are not accepted.")
        if resolved.tzinfo is None:
            resolved = resolved.replace(tzinfo=user_timezone())
    now = datetime.now(timezone.utc)
    if resolved.astimezone(timezone.utc) <= now:
        raise ValueError("That alarm time has already passed. Give a future time explicitly; I won't assume another day.")
    return resolved


async def _bridge_request(method: str, path: str, *, owner: str, payload: dict | None = None) -> dict:
    try:
        base = _bridge_url()
        token_path = _token_path()
        info = token_path.lstat()
        if token_path.is_symlink() or not token_path.is_file() or info.st_mode & 0o077:
            raise ValueError("unsafe bridge token file")
        token = token_path.read_text(encoding="utf-8").strip()
        if not token:
            raise ValueError("empty bridge token")
    except (OSError, ValueError) as exc:
        logger.info("Alarm bridge configuration unavailable: %s", type(exc).__name__)
        raise RuntimeError("The local alarm bridge is not configured. Start Novum Xenium Desktop and try again.") from None

    body = dict(payload or {})
    body["owner"] = owner
    try:
        async with httpx.AsyncClient(timeout=4.0) as client:
            response = await client.request(
                method,
                f"{base}{path}",
                headers={"Authorization": f"Bearer {token}"},
                params={"owner": owner} if method == "GET" else None,
                json=body if method != "GET" else None,
            )
            response.raise_for_status()
            data = response.json()
    except (httpx.HTTPError, ValueError) as exc:
        logger.info("Alarm bridge request failed: %s", type(exc).__name__)
        raise RuntimeError("The local alarm bridge could not be reached. Keep Novum Xenium Desktop open and try again.") from None
    if not isinstance(data, dict):
        raise RuntimeError("The local alarm bridge returned an invalid response.")
    return data


class ManageAlarmsTool:
    async def execute(self, content: str, ctx: dict | None = None) -> dict:
        ctx = ctx or {}
        owner = ctx.get("owner")
        try:
            args = _parse_tool_args(content)
        except ValueError:
            return {"error": "Invalid JSON arguments", "exit_code": 1}
        action = str(args.get("action") or "").strip().lower().replace("-", "_")
        aliases = {"schedule": "create", "add": "create", "new": "create", "get": "list", "cancel": "stop"}
        action = aliases.get(action, action)
        if action not in _ALLOWED:
            return {"error": "Choose action='create', 'list', or 'stop'.", "exit_code": 1}
        if set(args) - _ALLOWED[action]:
            return {"error": "Alarm arguments may only include the documented action fields; owner and bridge settings are server-controlled.", "exit_code": 1}
        if owner is None:
            return {"error": "No authenticated owner is available for this alarm request.", "exit_code": 1}
        owner = str(owner)
        try:
            if action == "list":
                data = await _bridge_request("GET", "/v1/alarms", owner=owner)
                alarms = data.get("alarms")
                if not isinstance(alarms, list):
                    raise RuntimeError("The local alarm bridge returned an invalid list.")
                return {"alarms": alarms, "exit_code": 0}
            if action == "create":
                at = _resolve_alarm_time(args.get("at", args.get("time")))
                label = str(args.get("label") or "Alarm").strip()
                if not label or len(label) > 120:
                    return {"error": "Alarm label must be 1–120 characters.", "exit_code": 1}
                volume = args.get("volume_percent", 100)
                duration = args.get("duration_seconds", 300)
                if isinstance(volume, bool) or not isinstance(volume, int) or not 0 <= volume <= 100:
                    return {"error": "volume_percent must be an integer from 0 to 100.", "exit_code": 1}
                if isinstance(duration, bool) or not isinstance(duration, int) or not 1 <= duration <= 300:
                    return {"error": "duration_seconds must be an integer from 1 to 300.", "exit_code": 1}
                data = await _bridge_request("POST", "/v1/alarms", owner=owner, payload={
                    "at": at.isoformat(), "label": label,
                    "volume_percent": volume, "duration_seconds": duration,
                })
                alarm = data.get("alarm")
                if not isinstance(alarm, dict):
                    raise RuntimeError("The local alarm bridge returned an invalid alarm.")
                return {"alarm": alarm, "exit_code": 0}
            try:
                alarm_id = str(UUID(str(args.get("alarm_id"))))
            except (ValueError, TypeError, AttributeError):
                return {"error": "Provide the alarm_id from the alarm list.", "exit_code": 1}
            data = await _bridge_request("POST", f"/v1/alarms/{quote(alarm_id, safe='')}/stop", owner=owner)
            alarm = data.get("alarm")
            if not isinstance(alarm, dict):
                raise RuntimeError("The local alarm bridge returned an invalid alarm.")
            return {"alarm": alarm, "exit_code": 0}
        except (RuntimeError, ValueError) as exc:
            return {"error": str(exc), "exit_code": 1}
