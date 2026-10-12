"""The independent verifier fails closed when it cannot establish completion."""

import pytest

from src.completion_verification import (
    build_completion_verification_prompt,
    compact_action_evidence,
    parse_completion_verification,
)


@pytest.mark.parametrize("raw", [
    "The checked requirements are complete.\nVERIFICATION: SUCCESS",
    "VERIFICATION: SUCCESS",
])
def test_only_explicit_final_success_passes(raw):
    assert parse_completion_verification(raw) == {"status": "passed", "issues": []}


def test_explicit_failure_preserves_each_unmet_requirement():
    assert parse_completion_verification(
        "VERIFICATION: FAIL: No real conversion was tested; GitHub repository was not created"
    ) == {
        "status": "failed",
        "issues": ["No real conversion was tested", "GitHub repository was not created"],
    }


@pytest.mark.parametrize("raw", [
    "",
    "The task is done.",
    "VERIFICATION: SUCCESS\nmore text after verdict",
    "VERIFICATION: FAIL:",
    "VERIFICATION: MAYBE",
    "verification: SUCCESS",
    "VERIFICATION: UNVERIFIED: No functional test evidence",
    "VERIFICATION: SUCCESS\nVERIFICATION: FAIL: unclear",
])
def test_missing_ambiguous_or_unverified_verdict_does_not_pass(raw):
    result = parse_completion_verification(raw)
    assert result["status"] == "unverified"
    assert result["issues"]


def test_prompt_requires_request_derived_functional_and_external_evidence():
    prompt = build_completion_verification_prompt(
        "Build the GUI, exercise one real conversion, and create the private GitHub repo.",
        "[bash] node --check src/app.js (exit 0)",
    )
    assert "every specific requirement" in prompt
    assert "syntax, lint, or build checks alone do not" in prompt
    assert "real input" in prompt
    assert "matching authorized tool" in prompt
    assert "untrusted tool data" in prompt
    assert "<user_request>" in prompt and "<actions_taken>" in prompt


def test_compaction_keeps_latest_validation_after_long_earlier_writes():
    events = [
        {"tool": "write_file", "command": "write large application source", "exit_code": 0,
         "output": "WROTE_SOURCE " + "x" * 9000},
        *[
            {"tool": "bash", "command": f"start service attempt {index}", "exit_code": 0,
             "output": "service log " + "y" * 1200}
            for index in range(12)
        ],
        {"tool": "bash", "command": "python -m pytest -q tests/test_app.py", "exit_code": 0,
         "output": "HEAD: test session\n" + "z" * 3000 + "\nTAIL: 4 passed"},
    ]

    snapshot = compact_action_evidence(events)

    assert len(snapshot) <= 8000
    assert "python -m pytest -q tests/test_app.py" in snapshot
    assert "exit_code=0" in snapshot
    assert "TAIL: 4 passed" in snapshot
    assert "Earlier action evidence omitted" in snapshot


def test_compaction_shows_selected_events_in_chronological_order_and_bounds_fields():
    events = [
        {"tool": "write_file", "command": "write " + "a" * 5000, "exit_code": 0,
         "output": "FIRST " + "b" * 5000 + " FIRST_TAIL"},
        {"tool": "bash", "command": "npm test", "exit_code": 0,
         "output": "SECOND " + "c" * 5000 + " SECOND_TAIL"},
        {"tool": "bash", "command": "printf final", "exit_code": 0,
         "output": "THIRD " + "d" * 5000 + " THIRD_TAIL"},
    ]

    snapshot = compact_action_evidence(events, limit=1200)

    assert len(snapshot) <= 1200
    positions = [snapshot.find(command) for command in ("write", "npm test", "printf final")]
    present = [position for position in positions if position >= 0]
    assert present == sorted(present)
    assert "THIRD_TAIL" in snapshot

@pytest.mark.parametrize(("response", "expected"), [
    ("Work appears complete.\nVERIFICATION: SUCCESS", []),
    ("VERIFICATION: SUCCESS\nextra", ["Unverified: Verifier returned no single final verdict."]),
    ("VERIFICATION: UNVERIFIED: no functional test output", ["Unverified: no functional test output"]),
    ("VERIFICATION: FAIL: conversion not tested", ["Failed: conversion not tested"]),
])
def test_verifier_subagent_never_treats_ambiguous_output_as_pass(monkeypatch, response, expected):
    import asyncio
    import src.agent_loop as agent_loop
    import src.llm_core

    async def fake_call(**_kwargs):
        return response

    monkeypatch.setattr(src.llm_core, "llm_call_async", fake_call)
    issues = asyncio.run(agent_loop._run_verifier_subagent(
        "Convert a real video", "[bash] ffmpeg test.mp4 (exit_code=0)",
        endpoint_url="http://localhost", model="test-model", headers={},
    ))
    assert issues == expected


def test_verifier_subagent_provider_error_is_unverified(monkeypatch):
    import asyncio
    import src.agent_loop as agent_loop
    import src.llm_core

    async def fail_call(**_kwargs):
        raise RuntimeError("offline")

    monkeypatch.setattr(src.llm_core, "llm_call_async", fail_call)
    issues = asyncio.run(agent_loop._run_verifier_subagent(
        "Convert a real video", "", endpoint_url="http://localhost",
        model="test-model", headers={},
    ))
    assert issues and issues[0].startswith("Unverified:")
