"""Outcome-based loop protection: progress, retries and saved pause reasons."""
import asyncio
import json

import pytest

import src.agent_loop as al
from src.agent_loop import _ToolProgressGuard, _tool_call_signature
from tests.test_agent_rounds_exhausted import _patch_common, _types


def record(tool="read_file", content="src/example.py", output="same page", code=0, **extra):
    return {"tool_name": tool, "content": content,
            "result": {"output": output, "exit_code": code, **extra}}


def test_limit_variants_and_json_order_do_not_hide_unchanged_reads():
    guard = _ToolProgressGuard("/workspace")
    for limit in (20, 30, 100):
        assert guard.observe([record(content=json.dumps({"limit": limit, "path": "./src/example.py", "offset": 1}))]) is None
    stall = guard.observe([record(content=json.dumps({"path": "/workspace/src/example.py", "limit": 200, "offset": 1}))])
    assert stall["read_repeats"] == 3
    assert stall["failed_retries"] == 0


def test_pagination_and_changed_results_are_progress():
    guard = _ToolProgressGuard()
    for offset in range(1, 20):
        assert guard.observe([record(content=json.dumps({"path": "log", "offset": offset, "limit": 1}))]) is None
    guard = _ToolProgressGuard()
    for version in range(20):
        assert guard.observe([record(output=f"version {version}")]) is None


def test_prose_and_other_round_bundles_cannot_reset_read_history():
    guard = _ToolProgressGuard()
    for i in range(3):
        assert guard.observe([record(), record("grep", json.dumps({"pattern": str(i)}), str(i))]) is None
    assert guard.observe([record()])["repeated_rounds"] == 3


def test_old_matches_expire_and_state_stays_bounded():
    guard = _ToolProgressGuard()
    for i in range(100):
        assert guard.observe([record(content=f"file-{i}")]) is None
    assert len(guard.seen) == len(guard.last_outputs) == 64
    assert len(guard.recent) == 8
    assert guard.observe([record(content="file-0")]) is None


def test_write_in_same_batch_resets_stall_and_existing_changes_survive():
    guard = _ToolProgressGuard()
    for _ in range(3):
        assert guard.observe([record()]) is None
    assert guard.observe([record(), record("edit_file", '{"path":"src/example.py"}', "Edited", diff={"added": 1})]) is None
    assert not guard.recent
    assert guard.observe([record(output="changed file")]) is None


def test_failed_retries_ignore_only_test_duration_noise():
    guard = _ToolProgressGuard()
    for seconds in ("0.01", "0.02", "0.03"):
        assert guard.observe([record("bash", "python -m unittest", f"FAILED in {seconds}s", 1)]) is None
    stall = guard.observe([record("bash", "python -m unittest", "FAILED in 0.04s", 1)])
    assert stall["failed_retries"] == 3
    assert stall["read_repeats"] == 0


def test_different_failure_and_successful_retry_reset_stall():
    guard = _ToolProgressGuard()
    failed = record("bash", "run tests", "missing module", 1)
    for _ in range(3):
        assert guard.observe([failed]) is None
    assert guard.observe([record("bash", "run tests", "different assertion failed", 1)]) is None
    assert guard.observe([record("bash", "run tests", "passed", 0)]) is None
    for _ in range(3):
        assert guard.observe([failed]) is None


@pytest.mark.parametrize("item", [
    record("manage_bg_jobs", '{"action":"output","job_id":"job"}', "still running"),
    record("tail_serve_output", "job", "loading"),
    record("ask_user", '{"question":"Continue?"}'),
    record(approval_required=True),
    record(blocked=True, code=1),
])
def test_polling_and_human_decisions_are_not_stalls(item):
    guard = _ToolProgressGuard()
    for _ in range(20):
        assert guard.observe([item]) is None
    assert not guard.recent


def test_full_arguments_avoid_long_prefix_collisions():
    prefix = "x" * 200
    assert _tool_call_signature("bash", prefix + "1") != _tool_call_signature("bash", prefix + "2")
    assert _tool_call_signature("grep", '{"path":"src","pattern":"foo"}') == _tool_call_signature("grep", '{"pattern":"foo", "path":"src"}')


def run_reads(monkeypatch, *, paginate=False, changing=False, native=False, failed=False):
    _patch_common(monkeypatch)
    monkeypatch.setattr(al, "blocked_tools_for_owner", lambda owner: set())
    calls = []
    rounds = 0
    teacher_attempts = []

    async def teacher(**kwargs):
        teacher_attempts.append(kwargs)
        if False:
            yield ""

    import src.teacher_escalation as escalation
    monkeypatch.setattr(escalation, "run_teacher_inline", teacher)

    async def stream(_candidates, messages, **kwargs):
        nonlocal rounds
        rounds += 1
        if rounds > 8:
            text = "Finished checking the requested pages."
        else:
            args = {"path": "example.py", "offset": rounds if paginate else 1, "limit": 10 if failed else 10 * rounds}
            text = "I'll check this file now.\n```read_file\n" + json.dumps(args) + "\n```"
            if native:
                yield "data: " + json.dumps({"delta": "I'll check this file now."}) + "\n\n"
                yield "data: " + json.dumps({"type": "tool_calls", "calls": [
                    {"id": f"read-{rounds}", "name": "read_file", "arguments": json.dumps(args)},
                ]}) + "\n\n"
                yield "data: [DONE]\n\n"
                return
        yield "data: " + json.dumps({"delta": text}) + "\n\n"
        yield "data: [DONE]\n\n"

    async def execute(block, *args, **kwargs):
        calls.append(block)
        return block.tool_type, {"output": str(len(calls)) if changing else "unchanged page", "exit_code": 1 if failed else 0}

    monkeypatch.setattr(al, "stream_llm_with_fallback", stream)
    monkeypatch.setattr(al, "execute_tool_block", execute)

    async def collect():
        return [chunk async for chunk in al.stream_agent_loop(
            "http://x/v1", "gpt-6.1-sol" if native else "m", [{"role": "user", "content": "Inspect the source files"}],
            approval_mode="full", relevant_tools={"read_file"}, max_rounds=20,
            workspace="/workspace", owner="test-admin",
        )]
    events = _types(asyncio.run(collect()))
    if any(event.get("type") == "loop_breaker_triggered" for event in events):
        assert not teacher_attempts, "A paused turn must not silently resume through a teacher"
    return events, calls


@pytest.mark.parametrize("native", [False, True])
def test_real_loop_pauses_repeated_reads_despite_narration_and_saves_reason(monkeypatch, native):
    events, calls = run_reads(monkeypatch, native=native)
    assert len(calls) == 4, events
    guard = next(event for event in events if event.get("type") == "loop_breaker_triggered")
    assert guard["reason"] == "repeated_tool_results"
    assert guard["persisted_in_text"] is True
    assert guard["read_repeats"] == 3
    assert not any(event.get("type") == "rounds_exhausted" for event in events)
    assert any("Agent paused:" in event.get("delta", "") for event in events)
    metrics = next(event["data"] for event in events if event.get("type") == "metrics")
    assert "Agent paused:" in metrics["round_texts"][-1]
    assert len(metrics["tool_events"]) == 4


@pytest.mark.parametrize("native", [False, True])
def test_real_loop_pauses_unchanged_failed_retries(monkeypatch, native):
    events, calls = run_reads(monkeypatch, native=native, failed=True)
    assert len(calls) == 4, events
    guard = next(event for event in events if event.get("type") == "loop_breaker_triggered")
    assert guard["failed_retries"] == 3
    assert guard["read_repeats"] == 0


@pytest.mark.parametrize("options", [{"paginate": True}, {"changing": True}])
def test_real_loop_allows_pagination_and_changed_output(monkeypatch, options):
    events, calls = run_reads(monkeypatch, **options)
    assert len(calls) == 8
    assert not any(event.get("type") == "loop_breaker_triggered" for event in events)
