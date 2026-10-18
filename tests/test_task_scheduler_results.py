"""Scheduled LLM runs consume terminal agent results, not concatenated drafts."""
import asyncio
import json
from types import SimpleNamespace

import pytest

from src.agent_runtime.completion import with_completion_gate

_AJAX_PROMPT = (
    'Fetch https://data.pewdiepie.com/ and check whether the "Ajax" model download is now '
    'LIVE/available (not "coming soon"). Signals that it is ready: a download link/HuggingFace '
    'link, model file names (.gguf/.safetensors), a size or "available now", or the "Coming soon" '
    'wording being replaced by release text. If it is ready: give a clear, prominent heads-up that '
    'the Ajax download is up, quote the exact download link/file details if present, and note that '
    'the user asked to be reminded when it went up. If it is STILL "coming soon": reply in one '
    'short line that it is not up yet and this is just the daily check (no need for the user to act).'
)


def _event(payload):
    return "data: " + json.dumps(payload) + "\n\n"


def _task(prompt="check the public Ajax endpoint", request_authority_json=None):
    return SimpleNamespace(
        crew_member_id=None, endpoint_url="http://ep/v1", model="m",
        session_id="s", owner="admin", prompt=prompt,
        name="Ajax check", max_steps=5, character_id=None,
        task_type="llm", action=None,
        request_authority_json=request_authority_json,
    )


def _install_stream(monkeypatch, events, *, gate=False):
    async def stream_agent_loop(*args, messages=None, **kwargs):
        for event in events:
            yield event

    if gate:
        stream_agent_loop = with_completion_gate(stream_agent_loop)
    monkeypatch.setattr("src.agent_loop.stream_agent_loop", stream_agent_loop)
    monkeypatch.setattr("src.task_endpoint.resolve_task_candidates", lambda **kwargs: [])


async def _run(monkeypatch, events, prompt=None, *, gate=False, task=None, disabled_tools=None):
    from src.task_scheduler import TaskScheduler

    _install_stream(monkeypatch, events, gate=gate)
    return await TaskScheduler(session_manager=None)._run_agent_loop(
        "http://ep/v1", "model", task or _task(prompt or "check the public Ajax endpoint"), "s",
        disabled_tools=disabled_tools,
    )


def _ajax_task():
    from src.agent_runtime.authority import seal_task_authority

    return _task(_AJAX_PROMPT, seal_task_authority(_AJAX_PROMPT, "llm", None, owner="admin"))


def test_scheduler_uses_latest_terminal_round_after_buffered_agent_step(monkeypatch):
    result = asyncio.run(_run(monkeypatch, [
        _event({"delta": "I will check it now. "}),
        _event({"type": "agent_step", "round": 2}),
        _event({"delta": "The endpoint returned two releases."}),
        _event({"type": "metrics", "data": {"round_texts": [
            "I will check it now.", "The endpoint returned two releases."
        ]}}),
        "data: [DONE]\n\n",
    ], gate=True))

    assert result == "The endpoint returned two releases."


def test_completion_gate_replacement_is_authoritative(monkeypatch):
    result = asyncio.run(_run(monkeypatch, [
        _event({"delta": "I fetched the page and verified the result."}),
        _event({"type": "final_response", "content": "The task is incomplete: no fetch evidence."}),
        _event({"type": "metrics", "data": {"round_texts": [
            "The task is incomplete: no fetch evidence."
        ]}}),
        "data: [DONE]\n\n",
    ]))

    assert result == "The task is incomplete: no fetch evidence."


def test_tool_round_uses_clean_final_text_and_preserves_tool_evidence(monkeypatch):
    result = asyncio.run(_run(monkeypatch, [
        _event({"delta": "Searching now."}),
        _event({"type": "tool_output", "tool": "web_fetch", "output": "HTTP 200; 2 releases"}),
        _event({"type": "agent_step", "round": 2}),
        _event({"delta": "The endpoint returned two releases."}),
        _event({"type": "metrics", "data": {"round_texts": [
            "", "The endpoint returned two releases."
        ]}}),
        "data: [DONE]\n\n",
    ], gate=True))

    assert result == "The endpoint returned two releases."


def test_transient_completion_blocked_does_not_override_verified_terminal_result(monkeypatch):
    result = asyncio.run(_run(monkeypatch, [
        _event({"delta": "First draft needs another repair."}),
        _event({"type": "completion_blocked", "reason": "artifact_mutation_required",
                "round": 1}),
        _event({"type": "agent_step", "round": 2}),
        _event({"delta": "The report is now verified."}),
        _event({"type": "completion_decision", "data": {
            "status": "verified", "can_complete": True,
        }}),
        _event({"type": "metrics", "data": {"round_texts": [
            "", "The report is now verified."
        ]}}),
        "data: [DONE]\n\n",
    ], gate=False))

    assert result == "The report is now verified."


def test_delta_after_final_response_supersedes_replacement(monkeypatch):
    result = asyncio.run(_run(monkeypatch, [
        _event({"type": "final_response", "content": "Earlier draft."}),
        _event({"delta": "Final answer."}),
        _event({"type": "metrics", "data": {"round_texts": ["Final answer."]}}),
        "data: [DONE]\n\n",
    ]))

    assert result == "Final answer."


def test_terminal_completion_failure_cannot_fall_back_to_grace_summary(monkeypatch):
    async def forbidden_grace(*args, **kwargs):
        pytest.fail("typed completion failure must not call a model fallback")

    monkeypatch.setattr("src.task_endpoint.task_llm_call_async", forbidden_grace)
    with pytest.raises(RuntimeError, match="did not complete: missing fetch evidence"):
        asyncio.run(_run(monkeypatch, [
            _event({"delta": "I did not fetch the URL."}),
            _event({"type": "completion_decision", "data": {
                "status": "unverified", "can_complete": False,
                "reason": "missing fetch evidence",
            }}),
            _event({"type": "metrics", "data": {"round_texts": ["I did not fetch the URL."]}}),
            "data: [DONE]\n\n",
        ], gate=False))


def test_provider_error_cannot_be_converted_to_successful_summary(monkeypatch):
    with pytest.raises(RuntimeError, match="provider failed"):
        asyncio.run(_run(monkeypatch, [
            "event: error\ndata: {\"error\":\"provider failed\"}\n\n",
            "data: [DONE]\n\n",
        ], gate=False))


def test_agent_terminal_failure_is_not_saved_as_successful_result(monkeypatch):
    with pytest.raises(RuntimeError, match="completion_unverified"):
        asyncio.run(_run(monkeypatch, [
            _event({"delta": "The task is complete."}),
            _event({"type": "agent_terminal", "status": "failed",
                    "reason": "completion_unverified"}),
        ], gate=False))


def test_tool_evidence_is_bounded_fallback_but_empty_stream_errors(monkeypatch):
    evidence = asyncio.run(_run(monkeypatch, [
        _event({"type": "tool_output", "tool": "web_fetch", "output": "HTTP 200; 2 releases"}),
        _event({"type": "metrics", "data": {"round_texts": []}}),
        "data: [DONE]\n\n",
    ], gate=False))
    assert evidence == "Tool output (no terminal answer):\n[web_fetch] HTTP 200; 2 releases"

    with pytest.raises(RuntimeError, match="no terminal answer or tool evidence"):
        asyncio.run(_run(monkeypatch, ["data: [DONE]\n\n"], gate=False))


def test_failed_tool_receipt_cannot_be_evidence_only_success(monkeypatch):
    with pytest.raises(RuntimeError, match="no terminal answer or tool evidence"):
        asyncio.run(_run(monkeypatch, [
            _event({"type": "tool_output", "tool": "web_fetch", "output": "HTTP 503",
                    "exit_code": 1, "success": False}),
            _event({"type": "metrics", "data": {"round_texts": []}}),
            "data: [DONE]\n\n",
        ], gate=False))

    with pytest.raises(RuntimeError, match="no terminal answer or tool evidence"):
        asyncio.run(_run(monkeypatch, [
            _event({"type": "tool_output", "tool": "web_fetch", "output": "blocked",
                    "exit_code": 0, "blocked": True}),
            _event({"type": "metrics", "data": {"round_texts": []}}),
            "data: [DONE]\n\n",
        ], gate=False))


def test_approval_pause_keeps_existing_safe_outcome(monkeypatch):
    from src import tool_approvals

    monkeypatch.setattr(tool_approvals.tool_approval_store, "consume", lambda *a, **kw: None)
    result = asyncio.run(_run(monkeypatch, [
        _event({"type": "tool_output", "tool": "web_fetch", "output": "approval required",
                "ask_user": {"kind": "tool_approval", "approval_id": "approval-1"}}),
    ], gate=False))

    assert result.startswith("Scheduled task paused safely:")
    assert "That action was not executed" in result


def test_explicit_ajax_read_denial_without_receipt_is_task_error(monkeypatch):
    task = _ajax_task()
    with pytest.raises(RuntimeError, match="requested URL was not successfully fetched"):
        asyncio.run(_run(monkeypatch, [
            _event({"delta": "I can't access external sites from this environment."}),
            "data: [DONE]\n\n",
        ], task=task, gate=True))


def test_explicit_ajax_read_accepts_matching_successful_tool_receipt(monkeypatch):
    task = _ajax_task()
    receipt = {
        "type": "tool_output", "tool": "web_fetch",
        "command": "{\"url\":\"https://DATA.PEWDiEPIE.com/\"}",
        "output": "HTTP 200; latest release: 42", "exit_code": 0,
    }
    result = asyncio.run(_run(monkeypatch, [
        _event(receipt),
        _event({"delta": "The latest release is 42."}),
        _event({"type": "metrics", "data": {"round_texts": ["The latest release is 42."]}}),
        "data: [DONE]\n\n",
    ], task=task, gate=True))

    assert result == "The latest release is 42."


def test_explicit_ajax_read_accepts_matching_terminal_metrics_receipt(monkeypatch):
    task = _ajax_task()
    receipt = {"tool": "web_fetch", "command": "https://data.pewdiepie.com/",
               "output": "HTTP 200; release: 42", "exit_code": 0}
    result = asyncio.run(_run(monkeypatch, [
        _event({"delta": "The latest release is 42."}),
        _event({"type": "metrics", "data": {
            "round_texts": ["The latest release is 42."],
            "tool_events": [receipt],
        }}),
        "data: [DONE]\n\n",
    ], task=task, gate=True))

    assert result == "The latest release is 42."


@pytest.mark.parametrize("receipt", [
    {"tool": "web_fetch", "command": "https://example.org/", "exit_code": 0},
    {"tool": "web_fetch", "command": "https://data.pewdiepie.com/", "exit_code": 1},
    {"tool": "web_fetch", "command": "https://data.pewdiepie.com/"},
    {"tool": "web_fetch", "command": "https://data.pewdiepie.com/",
     "exit_code": 0, "success": False},
])
def test_explicit_ajax_read_rejects_wrong_failed_or_unknown_receipts(monkeypatch, receipt):
    task = _ajax_task()
    with pytest.raises(RuntimeError, match="requested URL was not successfully fetched"):
        asyncio.run(_run(monkeypatch, [
            _event({"type": "tool_output", **receipt, "output": "Claimed fetch."}),
            _event({"delta": "The latest release is 42."}),
            _event({"type": "metrics", "data": {"round_texts": ["The latest release is 42."]}}),
            "data: [DONE]\n\n",
        ], task=task, gate=True))


@pytest.mark.parametrize("authorized,disabled", [(False, None), (True, {"web_fetch"})])
def test_explicit_ajax_read_preflight_fails_closed_without_model_call(monkeypatch, authorized, disabled):
    task = _ajax_task() if authorized else _task(_AJAX_PROMPT)
    called = False

    async def should_not_start(*args, **kwargs):
        nonlocal called
        called = True
        yield "data: [DONE]\n\n"

    monkeypatch.setattr("src.agent_loop.stream_agent_loop", should_not_start)
    monkeypatch.setattr("src.task_endpoint.resolve_task_candidates", lambda **kwargs: [])
    from src.task_scheduler import TaskScheduler
    with pytest.raises(PermissionError, match="Review and save this task"):
        asyncio.run(TaskScheduler(session_manager=None)._run_agent_loop(
            "http://ep/v1", "model", task, "s", disabled_tools=disabled))
    assert called is False

