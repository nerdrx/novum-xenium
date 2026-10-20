"""Shared OAuth/device-flow route scaffolding for provider setup."""

from __future__ import annotations

import asyncio
import inspect
import threading
import time
import uuid
from dataclasses import dataclass
from typing import Any, Callable, Iterable, Mapping, Optional

from fastapi import APIRouter, Form, HTTPException, Request
from starlette.concurrency import run_in_threadpool

from core.middleware import require_admin


@dataclass(frozen=True)
class DeviceFlowStart:
    """Provider-specific start result consumed by the shared route wrapper."""

    pending: Mapping[str, Any]
    response: Mapping[str, Any]
    interval: int = 5
    expires_in: int = 900


@dataclass(frozen=True)
class DeviceFlowPoll:
    """Normalized provider poll outcome."""

    status: str
    endpoint: Optional[Mapping[str, Any]] = None
    error: Optional[str] = None
    detail: Optional[str] = None
    interval: Optional[int] = None

    @classmethod
    def pending(cls, detail: Optional[str] = None) -> "DeviceFlowPoll":
        return cls(status="pending", detail=detail)

    @classmethod
    def slow_down(cls, interval: Optional[int] = None, detail: Optional[str] = None) -> "DeviceFlowPoll":
        return cls(status="slow_down", interval=interval, detail=detail)

    @classmethod
    def authorized(cls, endpoint: Mapping[str, Any]) -> "DeviceFlowPoll":
        return cls(status="authorized", endpoint=endpoint)

    @classmethod
    def failed(cls, error: str) -> "DeviceFlowPoll":
        return cls(status="failed", error=error)


class PendingDeviceFlowStore:
    """Thread-safe in-memory pending device-flow store.

    Device codes and provider-side secrets stay inside this process. Each entry
    stores provider payload separately from poll metadata so provider callbacks
    only receive the fields they created.
    """

    def __init__(self, *, time_func: Callable[[], float] = time.time):
        self._pending: dict[str, dict[str, Any]] = {}
        self._lock = threading.Lock()
        self._time = time_func

    def _now(self) -> float:
        return float(self._time())

    def prune_expired(self) -> None:
        now = self._now()
        with self._lock:
            for key in [k for k, v in self._pending.items() if v.get("expires_at", 0) < now]:
                self._pending.pop(key, None)

    def add(self, payload: Mapping[str, Any], *, interval: int, expires_in: int) -> str:
        self.prune_expired()
        poll_id = uuid.uuid4().hex
        with self._lock:
            self._pending[poll_id] = {
                "payload": dict(payload),
                "interval": max(int(interval or 5), 1),
                "expires_at": self._now() + max(int(expires_in or 900), 1),
                "next_poll_at": 0.0,
            }
        return poll_id

    def get_payload(self, poll_id: str) -> Optional[dict[str, Any]]:
        self.prune_expired()
        with self._lock:
            entry = self._pending.get(poll_id)
            if entry is None:
                return None
            return dict(entry.get("payload") or {})

    def is_throttled(self, poll_id: str) -> bool:
        with self._lock:
            entry = self._pending.get(poll_id)
            return bool(
                entry
                and (
                    entry.get("in_flight")
                    or self._now() < float(entry.get("next_poll_at") or 0)
                )
            )

    def begin_poll(self, poll_id: str) -> tuple[str, Optional[dict[str, Any]]]:
        """Atomically claim a poll and return its provider-owned payload."""
        self.prune_expired()
        now = self._now()
        with self._lock:
            entry = self._pending.get(poll_id)
            if entry is None:
                return "missing", None
            if float(entry.get("expires_at") or 0) < now:
                self._pending.pop(poll_id, None)
                return "missing", None
            if entry.get("in_flight") or now < float(entry.get("next_poll_at") or 0):
                return "pending", None
            entry["in_flight"] = True
            return "claimed", dict(entry.get("payload") or {})

    def finish_poll(self, poll_id: str, outcome: DeviceFlowPoll) -> dict[str, Any]:
        """Apply provider outcome and release the claim under one lock."""
        now = self._now()
        with self._lock:
            entry = self._pending.get(poll_id)
            if entry is not None:
                entry.pop("in_flight", None)
                if outcome.status in {"authorized", "failed"}:
                    self._pending.pop(poll_id, None)
                elif outcome.status == "slow_down":
                    interval = int(outcome.interval or (int(entry.get("interval") or 5) + 5))
                    entry["interval"] = max(interval, 1)
                    entry["next_poll_at"] = now + entry["interval"]
                else:
                    entry["next_poll_at"] = now + int(entry.get("interval") or 5)

        if outcome.status == "authorized":
            return {"status": "authorized", "endpoint": dict(outcome.endpoint or {})}
        if outcome.status == "failed":
            return {"status": "failed", "error": outcome.error or "denied"}
        return _pending_response(outcome.detail)

    def schedule_next(self, poll_id: str) -> None:
        now = self._now()
        with self._lock:
            entry = self._pending.get(poll_id)
            if entry is not None:
                entry["next_poll_at"] = now + int(entry.get("interval") or 5)

    def slow_down(self, poll_id: str, interval: Optional[int] = None) -> None:
        now = self._now()
        with self._lock:
            entry = self._pending.get(poll_id)
            if entry is not None:
                new_interval = int(interval or (int(entry.get("interval") or 5) + 5))
                entry["interval"] = max(new_interval, 1)
                entry["next_poll_at"] = now + entry["interval"]

    def pop(self, poll_id: str) -> None:
        with self._lock:
            self._pending.pop(poll_id, None)


async def _maybe_await(value: Any) -> Any:
    if inspect.isawaitable(value):
        return await value
    return value


async def _run_flow_callback(callback: Callable, *args: Any) -> Any:
    """Run sync provider I/O off-loop while keeping async callbacks supported."""
    if inspect.iscoroutinefunction(callback):
        return await _maybe_await(callback(*args))
    return await _maybe_await(await run_in_threadpool(callback, *args))


def _pending_response(detail: Optional[str] = None) -> dict[str, Any]:
    response: dict[str, Any] = {"status": "pending"}
    if detail:
        response["detail"] = detail
    return response


def create_device_flow_router(
    *,
    prefix: str,
    tags: Iterable[str],
    store: PendingDeviceFlowStore,
    start_flow: Callable[[Request, Mapping[str, Any]], DeviceFlowStart],
    poll_flow: Callable[[Request, Mapping[str, Any]], DeviceFlowPoll],
) -> APIRouter:
    """Create standard `/device/start|poll|cancel` routes for a provider."""

    router = APIRouter(prefix=prefix, tags=list(tags))
    poll_tasks: set[asyncio.Task] = set()

    def _finish_poll_task(task: asyncio.Task) -> None:
        poll_tasks.discard(task)
        if not task.cancelled():
            task.exception()

    @router.post("/device/start")
    async def device_start(request: Request):
        require_admin(request)
        form = await request.form()
        start = await _run_flow_callback(start_flow, request, form)
        interval = int(start.interval or 5)
        expires_in = int(start.expires_in or 900)
        poll_id = store.add(start.pending, interval=interval, expires_in=expires_in)
        response = dict(start.response)
        response.update({"poll_id": poll_id, "interval": interval, "expires_in": expires_in})
        return response

    @router.post("/device/poll")
    async def device_poll(request: Request, poll_id: str = Form(...)):
        require_admin(request)
        claim, payload = store.begin_poll(poll_id)
        if claim == "missing":
            raise HTTPException(404, "Unknown or expired login session")
        if claim == "pending":
            return {"status": "pending"}

        async def _poll_and_finish() -> dict[str, Any]:
            try:
                outcome = await _run_flow_callback(poll_flow, request, payload or {})
                return store.finish_poll(poll_id, outcome)
            except BaseException:
                store.pop(poll_id)
                raise

        task = asyncio.create_task(_poll_and_finish())
        poll_tasks.add(task)
        task.add_done_callback(_finish_poll_task)
        return await asyncio.shield(task)

    @router.post("/device/cancel")
    def device_cancel(request: Request, poll_id: str = Form(...)):
        require_admin(request)
        store.pop(poll_id)
        return {"status": "cancelled"}

    return router
