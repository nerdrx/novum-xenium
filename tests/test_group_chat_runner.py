import asyncio
from types import SimpleNamespace

import pytest
from fastapi.responses import StreamingResponse

from src import auth_helpers
from src import group_chat_runner
from routes import session_routes


class _Sessions:
    def get_session(self, session_id):
        return SimpleNamespace(model={"builder-session": "builder-model"}.get(session_id, "other-model"))


def _wire(monkeypatch, stream, *, active=None, owner="alice", verified=None):
    monkeypatch.setattr(auth_helpers, "storage_owner_for_request", lambda request: request.state.current_user)
    monkeypatch.setattr(session_routes, "_verify_session_owner", lambda request, sid: (verified or set()).add(sid))
    stopped = []
    monkeypatch.setattr(group_chat_runner.agent_runs, "is_active", lambda _sid: False)
    monkeypatch.setattr(group_chat_runner.agent_runs, "get_active_run", lambda _sid: active)
    monkeypatch.setattr(group_chat_runner.agent_runs, "get_status", lambda _sid: "done")
    def stop(sid, rid):
        stopped.append((sid, rid))
        if active and not active.task.done():
            active.task.cancel()
    monkeypatch.setattr(group_chat_runner.agent_runs, "stop", stop)
    runner = group_chat_runner.create_assignment_runner(stream, _Sessions())
    context = {
        "request_scope": {"state": {"current_user": owner}, "headers": [], "client": ("127.0.0.1", 1)},
        "options": {"workspace": "/workspace", "allow_bash": "true"},
        "models": {"builder-session": "builder-model"},
    }
    return runner, context, stopped


def test_runner_consumes_real_sse_done_and_tool_output(monkeypatch):
    seen = {}

    async def stream(request):
        seen["path"] = request.url.path
        seen["state"] = request.state.current_user

        async def events():
            yield 'data: {"delta":"Changed the file."}\n\n'
            yield 'data: {"type":"tool_output","tool":"write_file","output":"saved"}\n\n'
            yield "data: [DONE]\n\n"

        return StreamingResponse(events(), headers={"X-Odysseus-Run-Id": "run-1"})

    runner, context, _ = _wire(monkeypatch, stream)
    result = asyncio.run(runner("builder-session", "Implement it", read_only=False, owner="alice", context=context))
    assert result == ("Changed the file.\n\nwrite_file: saved\n\n"
                      "[Project verification: human review required; no passing configured checks were reported.]")
    assert seen == {"path": "/api/chat/stream", "state": "alice"}


@pytest.mark.parametrize("event", [
    'data: {"type":"ask_user","data":{"kind":"tool_approval","approval_id":"a1"}}\n\n',
    'event: error\ndata: {"error":"provider failed","status":500}\n\n',
    'data: {"type":"rounds_exhausted","rounds":8}\n\n',
    'data: {"type":"budget_exceeded","used":20,"limit":20}\n\n',
    'data: {"type":"loop_breaker_triggered","reason":"repeated action"}\n\n',
])
def test_approval_and_error_never_look_complete(monkeypatch, event):
    async def stream(_request):
        async def events():
            yield event
            yield "data: [DONE]\n\n"
        return StreamingResponse(events(), headers={"X-Odysseus-Run-Id": "run-2"})

    runner, context, _ = _wire(monkeypatch, stream)
    with pytest.raises(RuntimeError):
        asyncio.run(runner("builder-session", "Do work", read_only=False, owner="alice", context=context))


@pytest.mark.parametrize("owner,expected_model", [("bob", "builder-model"), ("alice", "wrong-model")])
def test_runner_rejects_owner_or_participant_model_mismatch(monkeypatch, owner, expected_model):
    async def stream(_request):
        raise AssertionError("chat must not start")

    runner, context, _ = _wire(monkeypatch, stream, owner="alice")
    context["models"]["builder-session"] = expected_model
    with pytest.raises(RuntimeError):
        asyncio.run(runner("builder-session", "Do work", read_only=False, owner=owner, context=context))


def test_cancellation_stops_the_matching_detached_child(monkeypatch):
    entered = asyncio.Event()
    child_task = None
    active = None

    async def stream(_request):
        async def events():
            entered.set()
            await asyncio.Event().wait()
            yield "data: [DONE]\n\n"
        return StreamingResponse(events(), headers={"X-Odysseus-Run-Id": "run-cancel"})

    async def scenario():
        nonlocal child_task, active
        child_task = asyncio.create_task(asyncio.sleep(60))
        active = SimpleNamespace(run_id="run-cancel", task=child_task)
        runner, context, stopped = _wire(monkeypatch, stream, active=active)
        task = asyncio.create_task(runner("builder-session", "Do work", read_only=False, owner="alice", context=context))
        await entered.wait()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert stopped == [("builder-session", "run-cancel")]
        assert child_task.cancelled()

    asyncio.run(scenario())
