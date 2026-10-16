"""A queued teacher check must not erase a verified student terminal."""
import asyncio
import json

import pytest

import src.teacher_escalation as te


def _event(payload):
    return "data: " + json.dumps(payload) + "\n\n"


@pytest.mark.parametrize("teacher_events, expected_parent", [
    ([], True),
    ([{"type": "teacher_takeover"}], False),
])
def test_completed_terminal_waits_for_actual_teacher_takeover(monkeypatch, teacher_events, expected_parent):
    async def teacher(**_kwargs):
        for payload in teacher_events:
            yield _event(payload)

    monkeypatch.setattr(te, "run_teacher_inline", teacher)

    @te.with_teacher_takeover
    async def parent():
        te.request_teacher_takeover(student_reply="verified")
        yield _event({"type": "agent_terminal", "status": "completed", "reason": "verified"})
        yield "data: [DONE]\n\n"

    chunks = asyncio.run(_collect(parent()))
    payloads = [json.loads(chunk[6:]) for chunk in chunks if chunk.startswith("data: ") and chunk != "data: [DONE]\n\n"]
    terminals = [item for item in payloads if item.get("type") == "agent_terminal"]
    assert any(item.get("type") == "teacher_takeover" for item in payloads) is bool(teacher_events)
    assert any(item.get("reason") == "verified" for item in terminals) is expected_parent


async def _collect(stream):
    return [chunk async for chunk in stream]


def test_teacher_exception_after_takeover_does_not_restore_student_success(monkeypatch):
    async def teacher(**_kwargs):
        yield _event({"type": "teacher_takeover"})
        raise RuntimeError("teacher stream failed")

    monkeypatch.setattr(te, "run_teacher_inline", teacher)

    @te.with_teacher_takeover
    async def parent():
        te.request_teacher_takeover(student_reply="verified")
        yield _event({"type": "agent_terminal", "status": "completed", "reason": "verified"})
        yield "data: [DONE]\n\n"

    chunks = asyncio.run(_collect(parent()))
    payloads = [json.loads(chunk[6:]) for chunk in chunks if chunk.startswith("data: ") and chunk != "data: [DONE]\n\n"]
    terminals = [item for item in payloads if item.get("type") == "agent_terminal"]
    assert [item.get("status") for item in terminals] == ["failed"]
    assert terminals[0]["reason"] == "teacher_takeover_failed"
