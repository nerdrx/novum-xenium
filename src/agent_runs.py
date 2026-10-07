"""Detached agent-run manager.

Keeps an agent/chat stream running server-side after the SSE client disconnects
(tab close, navigate away, refresh). The streaming generator is drained by a
background asyncio task into a per-session replay buffer; SSE clients SUBSCRIBE
to that buffer (replay everything so far, then live). Closing the SSE only drops
the subscriber — the drain task keeps going.

The wrapped generator already persists the assistant message to the session on
completion, so reopening the session shows the finished result even if nobody
was connected when it finished. Reconnecting mid-run replays the buffer + streams
live (pick up where it is).

The live SSE replay buffer stays in memory. A bounded SQLite checkpoint records
last output and completed tool outcomes so a later process can expose interrupted
runs for an explicit, one-use recovery decision; it never replays tools.
"""
import asyncio
import json
import logging
import threading
import time
import uuid
from typing import AsyncGenerator, Dict, Optional

from src import run_checkpoints, run_evidence
from src.stream_errors import describe_stream_failure

logger = logging.getLogger(__name__)


class _Run:
    __slots__ = (
        "buffer", "subscribers", "status", "task", "evict_task", "run_id", "owner",
        "checkpoint_pending", "checkpoint_last_flush", "persist_checkpoint", "drain_started",
        "deleted_scope", "predecessor_task",
    )

    def __init__(self, owner: Optional[str] = None, persist_checkpoint: bool = True,
                 predecessor_task: Optional[asyncio.Task] = None) -> None:
        self.buffer: list = []          # ordered SSE event strings (replay log)
        self.subscribers: set = set()   # one asyncio.Queue per connected client
        self.status: str = "running"    # running | done | error | stopped
        self.task: Optional[asyncio.Task] = None
        self.evict_task: Optional[asyncio.Task] = None
        # Stable across every subscription/replay of this exact detached run.
        # The browser uses it to make local cost accounting replay-idempotent.
        self.run_id: str = uuid.uuid4().hex
        self.owner = owner
        self.checkpoint_pending = ""
        self.checkpoint_last_flush = 0.0
        self.persist_checkpoint = persist_checkpoint
        self.drain_started = False
        self.deleted_scope: Optional[tuple[str, str]] = None
        # If this run is replaced before _drain starts, its own task cannot
        # carry the predecessor barrier onward, so the next run inherits it.
        self.predecessor_task = predecessor_task


_RUNS: Dict[str, _Run] = {}
_RUN_LOCK = threading.RLock()
_DELETIONS: Dict[tuple[str, str], list[bool]] = {}

# How long a FINISHED run (and its full replay buffer) is retained after the
# last subscriber disconnects, so a reconnect within the window can still
# replay the result. After this, the run is evicted to bound memory — without
# it, every session that ever streamed kept its entire event log forever.
_EVICT_GRACE_S = 180


def _publish(run: _Run, ev: str) -> None:
    """Append one SSE event and fan it out to every live subscriber."""
    if run.persist_checkpoint:
        run_evidence.record(run.run_id, ev)
    run.buffer.append(ev)
    seq = len(run.buffer) - 1
    for q in list(run.subscribers):
        try:
            q.put_nowait((seq, ev))
        except Exception:
            pass


def _wake_run_subscribers(run: _Run) -> None:
    """Close subscribers even when the drain task never reached its body."""
    for q in list(run.subscribers):
        try:
            q.put_nowait((None, None))
        except Exception:
            pass


def _flush_checkpoint_delta(run: _Run) -> None:
    if run.persist_checkpoint and run.checkpoint_pending:
        run_checkpoints.record_delta(run.run_id, run.checkpoint_pending)
        run.checkpoint_pending = ""
        run.checkpoint_last_flush = time.monotonic()


def _schedule_evict(session_id: str, expected_run: Optional[_Run] = None) -> None:
    """(Re)arm a grace-period eviction for a terminal run with no subscribers.
    Identity-checked so a run that gets replaced/reused is never evicted by a
    stale timer."""
    run = _RUNS.get(session_id)
    if run is None:
        return
    if expected_run is not None and run is not expected_run:
        return
    if run.evict_task and not run.evict_task.done():
        run.evict_task.cancel()

    async def _evict(run_ref: _Run) -> None:
        try:
            await asyncio.sleep(_EVICT_GRACE_S)
        except asyncio.CancelledError:
            return
        cur = _RUNS.get(session_id)
        if cur is run_ref and cur.status != "running" and not cur.subscribers:
            _RUNS.pop(session_id, None)

    run.evict_task = asyncio.create_task(_evict(run))


def is_active(session_id: str) -> bool:
    r = _RUNS.get(session_id)
    return bool(r and r.status == "running")


def get_status(session_id: str) -> Optional[str]:
    r = _RUNS.get(session_id)
    return r.status if r else None


def get_run_id(session_id: str) -> Optional[str]:
    """Return the opaque identity of the current detached run, if present."""
    r = _RUNS.get(session_id)
    return r.run_id if r else None


def get_run_owner(session_id: str) -> Optional[str]:
    run = _RUNS.get(session_id)
    return run.owner if run else None


def get_active_run(session_id: str) -> Optional[_Run]:
    """Return the exact active run currently registered for a session."""
    r = _RUNS.get(session_id)
    return r if r and r.status == "running" else None


async def _drain(session_id: str, run: _Run, agen: AsyncGenerator[str, None],
                 prev_task: Optional[asyncio.Task] = None) -> None:
    """Pull every event from the wrapped generator into the run buffer, fanning
    each out to live subscribers. Runs to completion regardless of subscribers."""
    run.drain_started = True
    subscribers_woken = False

    def _wake_subscribers() -> None:
        nonlocal subscribers_woken
        if subscribers_woken:
            return
        subscribers_woken = True
        _wake_run_subscribers(run)

    # If this run replaced an in-flight one (rapid double-send), wait for that
    # one to fully finish first. Its CancelledError handler calls aclose(), which
    # persists its partial response — letting it complete before we start writing
    # keeps the two runs' session saves sequential instead of interleaved.
    try:
        if prev_task is not None and not prev_task.done():
            await asyncio.wait({prev_task})
        async for ev in agen:
            if run.persist_checkpoint:
                change = run_checkpoints.checkpoint_event(ev)
                if "output_delta" in change:
                    run.checkpoint_pending = (
                        run.checkpoint_pending + change["output_delta"]
                    )[-32_000:]
                    if time.monotonic() - run.checkpoint_last_flush >= 0.5:
                        _flush_checkpoint_delta(run)
                elif "pending_tool" in change or "tool_outcome" in change:
                    _flush_checkpoint_delta(run)
                    run_checkpoints.record(run.run_id, ev)
            _publish(run, ev)
        if run.status == "running":
            run.status = "done"
    except asyncio.CancelledError:
        run.status = "stopped"
        # Let the wrapped generator's own CancelledError handler run (it saves
        # the partial response to the session).
        try:
            await agen.aclose()
        except Exception:
            pass
        # A rapid third replacement can cancel this task while it is still
        # waiting for its predecessor. Close this run's subscribers promptly,
        # but keep the task alive until the predecessor finishes so the next
        # run still observes the transitive session-save ordering barrier.
        _wake_subscribers()
        if prev_task is not None and not prev_task.done():
            try:
                await asyncio.shield(prev_task)
            except (asyncio.CancelledError, Exception):
                pass
    except Exception as e:
        logger.error("[agent-run] %s failed: %s", session_id, e, exc_info=True)
        run.status = "error"
        failure = {"error": "Agent run failed before completion.", "status": 500}
        if isinstance(e, ValueError) and str(e).startswith("Agent context budget cannot fit"):
            summary = describe_stream_failure(e)
            failure = {"error": summary["message"], "status": summary["status"]}
        _publish(
            run,
            "event: error\n"
            f"data: {json.dumps(failure)}\n\n",
        )
        _publish(run, "data: [DONE]\n\n")
    finally:
        try:
            # Wake every subscriber with the end sentinel so their SSE closes.
            _wake_subscribers()
            _flush_checkpoint_delta(run)
            if run.persist_checkpoint:
                run_checkpoints.finish(run.run_id, run.status)
                run_evidence.finish(run.run_id, run.status)
        finally:
            if run.deleted_scope is not None:
                _mark_deleted_run_drained(*run.deleted_scope)
                run.deleted_scope = None
        # Run is terminal — arm the grace timer so it (and its buffer) is
        # eventually freed even if nobody ever reconnects. subscribe() cancels
        # this on connect and re-arms on disconnect.
        _schedule_evict(session_id, run)


def start(
    session_id: str,
    agen: AsyncGenerator[str, None],
    *,
    owner: Optional[str] = None,
    context: Optional[dict] = None,
    persist: bool = True,
) -> _Run:
    """Start a detached run draining `agen` for a session. If a run is already in
    flight for this session (e.g. a rapid double-send), it's cancelled first."""
    with _RUN_LOCK:
        if _session_deletion_pending(session_id):
            raise ValueError("session is being deleted")
        if owner:
            from src.tool_result_store import results_fenced
            if results_fenced(owner, session_id):
                raise ValueError("session is being deleted")
        prev = _RUNS.get(session_id)
        prev_task: Optional[asyncio.Task] = None
        if prev:
            if prev.task and not prev.task.done():
                # A task cancelled before its first instruction never enters
                # _drain(), so its except/finally blocks cannot update status or
                # wake a response already bound to this exact run. Terminalize it
                # synchronously before cancelling; _drain's cleanup is idempotent
                # when the task had already started.
                if prev.status == "running":
                    prev.status = "stopped"
                    _wake_run_subscribers(prev)
                    if prev.persist_checkpoint:
                        run_checkpoints.finish(prev.run_id, "stopped")
                        run_evidence.finish(prev.run_id, "stopped")
                prev.task.cancel()
            if prev.drain_started:
                # A started drain holds its predecessor barrier until its own
                # cancellation cleanup finishes.
                if prev.task and not prev.task.done():
                    prev_task = prev.task
            else:
                # A not-yet-started task cannot run _drain's barrier/cleanup.
                # Inherit its predecessor directly so a rapid third send still
                # waits for the original run's partial save.
                inherited = prev.predecessor_task
                if inherited and not inherited.done():
                    prev_task = inherited
                elif prev.task and not prev.task.done():
                    prev_task = prev.task
            if prev.evict_task and not prev.evict_task.done():
                prev.evict_task.cancel()
        run = _Run(owner, persist_checkpoint=persist, predecessor_task=prev_task)
        _RUNS[session_id] = run
        if persist:
            run_checkpoints.begin(run.run_id, session_id, owner, context)
            run_evidence.begin(run.run_id, session_id, owner, context)
        run.task = asyncio.create_task(_drain(session_id, run, agen, prev_task))
    return run


async def subscribe(
    session_id: str,
    expected_run: Optional[_Run] = None,
) -> AsyncGenerator[str, None]:
    """Replay the run's buffer from the start, then stream live until it ends.
    Safe to call repeatedly (reconnect) and from multiple clients at once.

    ``expected_run`` binds a lazy StreamingResponse body to the same run whose
    identity was put in its response headers. Without that binding, a rapid
    replacement between response construction and body iteration could replay
    the replacement run under the prior run's identity.
    """
    run = expected_run or _RUNS.get(session_id)
    if run is None:
        return
    q: asyncio.Queue = asyncio.Queue()
    run.subscribers.add(q)            # register BEFORE replaying so nothing is missed
    # A live subscriber is connected — don't let a pending grace timer evict
    # the run out from under it mid-replay.
    if run.evict_task and not run.evict_task.done():
        run.evict_task.cancel()
    try:
        next_seq = 0
        while next_seq < len(run.buffer):
            yield run.buffer[next_seq]
            next_seq += 1
        if run.status != "running":
            return
        heartbeat_idx = 0
        while True:
            try:
                seq, ev = await asyncio.wait_for(q.get(), timeout=10.0)
            except asyncio.TimeoutError:
                # Keep slow local models/proxies alive while they prefill before
                # the first token. SSE comments are ignored by the UI but reset
                # browser/proxy idle timers, which prevents "empty response"
                # disconnects on llama.cpp first-token latencies of 30s+.
                if run.status == "running":
                    heartbeat_idx += 1
                    yield f": heartbeat {heartbeat_idx}\n\n"
                    continue
                seq, ev = (None, None)
            if seq is None:            # end sentinel
                while next_seq < len(run.buffer):   # flush any tail the sentinel raced
                    yield run.buffer[next_seq]
                    next_seq += 1
                break
            if seq >= next_seq:        # skip events already replayed from the buffer
                yield ev
                next_seq = seq + 1
    finally:
        run.subscribers.discard(q)
        # Last subscriber gone on a finished run — (re)arm eviction so the
        # buffer doesn't linger indefinitely.
        if not run.subscribers and run.status != "running":
            _schedule_evict(session_id, run)


def stop(session_id: str, expected_run_id: Optional[str] = None) -> bool:
    """Cancel the matching in-flight run (which saves its partial output).

    A stale browser may issue Stop after another tab has replaced the session's
    run. Once the caller knows its opaque run identity, fail closed rather than
    cancelling that newer run.
    """
    run = _RUNS.get(session_id)
    if not expected_run_id or run is None or run.run_id != expected_run_id:
        return False
    if run and run.task and not run.task.done():
        def _cancel() -> None:
            if run.task is None or run.task.done():
                if run.deleted_scope is not None:
                    _mark_deleted_run_drained(*run.deleted_scope)
                    run.deleted_scope = None
                return
            never_started = not run.drain_started
            if never_started:
                # A task cancelled before its coroutine first runs never enters
                # _drain's cancellation/finally handlers.
                run.status = "stopped"
                _wake_run_subscribers(run)
                if run.persist_checkpoint:
                    run_checkpoints.finish(run.run_id, "stopped")
                    run_evidence.finish(run.run_id, "stopped")
                _schedule_evict(session_id, run)
            async def _cleanup_owned() -> None:
                try:
                    from src.agent_tools.subprocess_tools import stop_owned
                    await stop_owned(session_id, run.run_id)
                    from src import bg_jobs
                    await asyncio.to_thread(bg_jobs.kill_run, session_id, run.run_id)
                except Exception:
                    logger.exception("failed to clean up run-owned commands")
            asyncio.create_task(_cleanup_owned())
            run.task.cancel()
            if never_started and run.deleted_scope is not None:
                _mark_deleted_run_drained(*run.deleted_scope)
                run.deleted_scope = None

        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            loop = None
        if loop is run.task.get_loop():
            _cancel()
        else:
            run.task.get_loop().call_soon_threadsafe(_cancel)
        return True
    return False


def fence_deleted_session(session_id: str, owner: Optional[str]) -> bool:
    """Fence tool archives and stop a live run before its session is removed."""
    with _RUN_LOCK:
        run = _RUNS.get(session_id)
        active = bool(run and run.task and not run.task.done())
        owner = owner or (run.owner if run else None)
        if owner:
            from src.tool_result_store import fence_results
            fence_results(owner, session_id)
            key = (owner, session_id)
            _DELETIONS.setdefault(key, [not active, False])
            if active:
                run.deleted_scope = key
        if active:
            stop(session_id, run.run_id)
        return bool(owner)


def _session_deletion_pending(session_id: str) -> bool:
    return any(deleted_sid == session_id for _owner, deleted_sid in _DELETIONS)


def _finish_deletion_scope(owner: str, session_id: str, *, run_done=False, cleanup_done=False) -> None:
    key = (owner, session_id)
    with _RUN_LOCK:
        state = _DELETIONS.get(key)
        if state is None:
            return
        state[0] = state[0] or run_done
        state[1] = state[1] or cleanup_done
        if all(state):
            _DELETIONS.pop(key, None)
            from src.tool_result_store import release_results_fence
            release_results_fence(owner, session_id)


def _mark_deleted_run_drained(owner: str, session_id: str) -> None:
    _finish_deletion_scope(owner, session_id, run_done=True)


def complete_session_deletion(owner: Optional[str], session_id: str) -> None:
    """Release deletion fence after DB and private-context cleanup finish."""
    if owner:
        _finish_deletion_scope(owner, session_id, cleanup_done=True)


def ensure_session_reusable(session_id: str) -> None:
    """Do not let an explicit ID reuse race a canceled run's final writes."""
    with _RUN_LOCK:
        run = _RUNS.get(session_id)
        if (_session_deletion_pending(session_id)
                or (run is not None and run.task is not None and not run.task.done())):
            raise ValueError("session ID is still draining a previous run")


def get_checkpoint(session_id: str, owner: Optional[str] = None) -> Optional[dict]:
    """Read durable state for a session, scoped to its authenticated owner."""
    return run_checkpoints.get_checkpoint(session_id, owner)


def claim_recovery(session_id: str, owner: Optional[str], run_id: str) -> Optional[dict]:
    """Claim an interrupted checkpoint once; this never replays tool calls."""
    return run_checkpoints.claim_recovery(session_id, owner, run_id)


def delete_checkpoints(session_id: str, owner: Optional[str] = None) -> None:
    """Delete durable metadata when an owning session is permanently removed."""
    run_checkpoints.delete_session(session_id, owner)
    run_evidence.delete_session(session_id, owner)
