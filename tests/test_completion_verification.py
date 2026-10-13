"""The independent verifier fails closed when it cannot establish completion."""

import json

import pytest

from src.completion_verification import (
    _format_action_event,
    build_completion_verification_prompt,
    completion_verdict_needs_format_retry,
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


def test_only_structural_verdict_failures_qualify_for_format_retry():
    assert completion_verdict_needs_format_retry(
        parse_completion_verification("analysis only")
    )
    assert completion_verdict_needs_format_retry(
        parse_completion_verification("VERIFICATION: UNVERIFIED:")
    )
    assert not completion_verdict_needs_format_retry(
        parse_completion_verification("VERIFICATION: UNVERIFIED: UI behavior is untested")
    )
    assert not completion_verdict_needs_format_retry(
        parse_completion_verification("VERIFICATION: FAIL: UI test missing")
    )


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
    assert "A successful file write proves only that content was written" in prompt
    assert "A later retry failure applies only to that attempt" in prompt
    assert "This verifier has no tools" in prompt
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
    assert "All 14 recorded actions are represented" in snapshot
    assert "fields may be abbreviated" in snapshot


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


def test_compaction_preserves_distinct_early_file_writes_with_latest_checks():
    events = [
        {"tool": "write_file", "command": json.dumps({
            "path": "src/main.js", "content": "main source",
        }), "exit_code": 0, "output": "WROTE_MAIN"},
        {"tool": "write_file", "command": json.dumps({
            "path": "public/index.html", "content": "main UI",
        }), "exit_code": 0, "output": "WROTE_UI"},
        *[
            {"tool": "write_file", "command": json.dumps({
                "path": f"docs/generated-{i}.md", "content": "reference",
            }), "exit_code": 0, "output": f"WROTE_DOC_{i}"}
            for i in range(60)
        ],
        {"tool": "mcp__github__create_repository", "command": "create private repository",
         "exit_code": 0, "output": "EXTERNAL_ACTION: repository created"},
        *[
            {"tool": "read_file", "command": json.dumps({"path": f"docs/ref-{i}.md"}),
             "exit_code": 0, "output": "documentation " + "x" * 1200}
            for i in range(12)
        ],
        {"tool": "bash", "command": "npm test", "exit_code": 0,
         "output": "FUNCTIONAL_CHECK: 8 passed"},
    ]

    snapshot = compact_action_evidence(events)

    assert len(snapshot) <= 8000
    assert "src/main.js" in snapshot and "WROTE_MAIN" in snapshot
    assert "public/index.html" in snapshot and "WROTE_UI" in snapshot
    assert "FUNCTIONAL_CHECK: 8 passed" in snapshot
    assert "[63/76]" in snapshot
    assert "mcp__github__create_repository" in snapshot
    assert "EXTERNAL_ACTION: repository created" in snapshot
    assert "[76/76]" in snapshot


def test_compaction_uses_latest_write_status_per_target_path():
    path = "src/main.js"
    events = [
        {"tool": "write_file", "command": json.dumps({"path": path, "content": "first"}),
         "exit_code": 0, "output": "INITIAL_WRITE"},
        {"tool": "edit_file", "command": json.dumps({"path": path, "old_string": "x"}),
         "exit_code": 1, "output": "LATEST_WRITE_FAILED"},
        {"tool": "bash", "command": "npm test", "exit_code": 0, "output": "CHECK_RESULT"},
    ]

    snapshot = compact_action_evidence(events)

    assert "LATEST_WRITE_FAILED" in snapshot
    assert "INITIAL_WRITE" in snapshot
    assert "CHECK_RESULT" in snapshot


def test_actual_sized_history_keeps_early_success_with_later_retry_failure_and_push():
    events = [
        {"tool": "bash", "command": f"printf setup-{i}", "exit_code": 0,
         "output": f"setup result {i}"}
        for i in range(10)
    ]
    events.extend([
        {"tool": "bash",
         "command": 'cd /workspace/project && gh repo create nerdrx/nflix --private --description="Modern FFmpeg GUI"',
         "exit_code": 0, "output": "https://github.com/nerdrx/nflix"},
    ])
    events.extend(
        {"tool": "write_file", "command": json.dumps({"path": f"src/file-{i}.js", "content": "source"}),
         "exit_code": 0, "output": f"Wrote file {i}"}
        for i in range(18)
    )
    events.extend([
        {"tool": "bash", "command": 'cd /workspace/project && gh repo create nflix --private',
         "exit_code": 1, "output": "STDERR: GraphQL: Name already exists on this account (createRepository)"},
    ])
    events.extend(
        {"tool": "bash", "command": f"printf build-{i}", "exit_code": 0,
         "output": f"build result {i}"}
        for i in range(12)
    )
    events.append({
        "tool": "bash", "command": "cd /workspace/project && git push origin main",
        "exit_code": 0, "output": "To https://github.com/nerdrx/nflix.git\n * [new branch] main -> main",
    })
    assert len(events) == 43

    snapshot = compact_action_evidence(events, limit=8000)

    assert len(snapshot) <= 8000
    assert "[1/43]" in snapshot and "[43/43]" in snapshot
    assert "gh repo create nerdrx/nflix --private" in snapshot
    assert "exit_code=0" in snapshot and "https://github.com/nerdrx/nflix" in snapshot
    assert "GraphQL: Name already exists" in snapshot
    assert "git push origin main" in snapshot
    prompt = build_completion_verification_prompt("Create a private GitHub repository", snapshot)
    assert "Historical success does not prove current external state" in prompt
    assert "report conflicting attempts separately" in prompt


def test_compaction_preserves_failed_native_preview_alongside_later_cli_validation():
    events = [
        {"tool": "write_file", "command": json.dumps({"path": f"src/file-{i}.js", "content": "x"}),
         "exit_code": 0, "output": f"Wrote file {i}"}
        for i in range(70)
    ]
    events.append({
        "tool": "native_preview", "command": "Render Electron UI", "exit_code": 1,
        "output": "PREVIEW_FAILURE: no renderer; SyntaxError: Identifier __dirname already declared",
    })
    events.append({"tool": "bash", "command": "npm test", "exit_code": 0,
                   "output": "CLI_TESTS_PASSED: 12"})
    events.extend(
        {"tool": "read_file", "command": json.dumps({"path": f"docs/ref-{i}.md"}),
         "exit_code": 0, "output": "Read documentation " + "x" * 300}
        for i in range(110)
    )

    snapshot = compact_action_evidence(events, limit=2400)

    assert len(snapshot) <= 2400
    assert "native_preview" in snapshot
    assert "PREVIEW_FAILURE: no renderer" in snapshot
    assert "exit_code=1" in snapshot
    assert "npm test" in snapshot and "CLI_TESTS_PASSED: 12" in snapshot
    assert "Action summaries omitted" in snapshot


@pytest.mark.parametrize("limit", [64, 72, 96, 128])
def test_native_preview_event_formatter_respects_tight_budget(limit):
    formatted = _format_action_event({
        "tool": "native_preview", "command": "Run UI validation",
        "exit_code": 1, "output": "PREVIEW_FAILURE: no renderer; " + "SyntaxError " * 20,
    }, limit)

    assert len(formatted) <= limit
    assert "PREVIEW_FAILURE" in formatted


def test_compaction_labels_action_gaps_when_synopses_cannot_fit():
    events = [
        {"tool": "bash", "command": f"action-{i} " + "x" * 100, "exit_code": i % 2,
         "output": f"result-{i} " + "y" * 200}
        for i in range(400)
    ]

    snapshot = compact_action_evidence(events, limit=1000)

    assert len(snapshot) <= 1000
    assert "Action summaries omitted" in snapshot
    assert "[1/400]" in snapshot and "[400/400]" in snapshot


def test_shell_command_truncation_keeps_verbatim_head_and_tail_without_reconstruction():
    command = "cd '/workspace/my && path' && bash -lc 'first --mode=one && " + "x" * 500 + " || last --mode=two'"
    snapshot = compact_action_evidence([
        {"tool": "bash", "command": command, "exit_code": 0, "output": "done"},
    ], limit=600)

    assert "cd '/workspace/my && path' && bash -lc 'first --mode=one" in snapshot
    assert "|| last --mode=two'" in snapshot
    assert "middle omitted" in snapshot
    assert "<value>" not in snapshot


def test_write_path_containing_build_or_test_is_not_a_validation():
    events = [
        {"tool": "bash", "command": "npm test", "exit_code": 0,
         "output": "REAL_TEST_RESULT"},
        {"tool": "write_file", "command": json.dumps({
            "path": "public/build/test/index.js", "content": "source",
        }), "exit_code": 0, "output": "WRITE_RESULT"},
        {"tool": "read_file", "command": json.dumps({
            "path": "tests/test_app.py",
        }), "exit_code": 0, "output": "READ_RESULT"},
        *[
            {"tool": "read_file", "command": json.dumps({"path": f"docs/guide-{i}.md"}),
             "exit_code": 0, "output": "guide " + "x" * 900}
            for i in range(10)
        ],
    ]

    snapshot = compact_action_evidence(events, limit=1200)

    assert len(snapshot) <= 1200
    assert "REAL_TEST_RESULT" in snapshot

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


@pytest.mark.parametrize("retry_response, expected", [
    ("VERIFICATION: SUCCESS", []),
    ("VERIFICATION: SUCCESS\ntrailing text", [
        "Unverified: Verifier returned no single final verdict.",
    ]),
])
def test_verifier_retries_malformed_format_once_with_same_evidence(
    monkeypatch, retry_response, expected,
):
    import asyncio
    import src.agent_loop as agent_loop
    import src.llm_core

    calls = []
    responses = iter(["analysis without a verdict", retry_response])

    async def fake_call(**kwargs):
        calls.append(kwargs)
        return next(responses)

    monkeypatch.setattr(src.llm_core, "llm_call_async", fake_call)
    issues = asyncio.run(agent_loop._run_verifier_subagent(
        "Create the GUI", "[bash] npm test (exit_code=0)",
        endpoint_url="http://localhost", model="test-model", headers={"x-test": "1"},
        reasoning_mode="off",
    ))

    assert issues == expected
    assert len(calls) == 2
    assert calls[0]["url"] == calls[1]["url"] == "http://localhost"
    assert calls[0]["model"] == calls[1]["model"] == "test-model"
    assert calls[0]["headers"] == calls[1]["headers"] == {"x-test": "1"}
    assert calls[0]["reasoning_mode"] == calls[1]["reasoning_mode"] == "off"
    assert calls[0]["max_tokens"] == calls[1]["max_tokens"] == 2048
    assert "Create the GUI" in calls[0]["messages"][0]["content"]
    assert "[bash] npm test (exit_code=0)" in calls[1]["messages"][0]["content"]
    assert "Formatting retry" in calls[1]["messages"][0]["content"]


def test_verifier_length_retry_increases_budget_but_still_fails_closed(monkeypatch):
    import asyncio
    import src.agent_loop as agent_loop
    import src.llm_core

    calls = []

    async def truncated_call(**kwargs):
        calls.append(kwargs)
        kwargs["response_diagnostics"].update({
            "finish_reason": "length",
            "completion_tokens": kwargs["max_tokens"],
            "content_chars": 0,
        })
        return ""

    monkeypatch.setattr(src.llm_core, "llm_call_async", truncated_call)
    issues = asyncio.run(agent_loop._run_verifier_subagent(
        "Create the GUI", "same evidence", endpoint_url="http://localhost",
        model="test-model", headers={}, reasoning_mode="off",
    ))

    assert len(calls) == 2
    assert [call["max_tokens"] for call in calls] == [2048, 4096]
    assert all(call["model"] == "test-model" for call in calls)
    assert all(call["reasoning_mode"] == "off" for call in calls)
    assert "Formatting retry" in calls[1]["messages"][0]["content"]
    assert issues == ["Unverified: the completion reviewer reached its output limit without a verdict; "
                      "completed checks remain recorded, but independent review is unfinished."]


def test_valid_unverified_verdict_does_not_retry_format(monkeypatch):
    import asyncio
    import src.agent_loop as agent_loop
    import src.llm_core

    calls = []

    async def fake_call(**kwargs):
        calls.append(kwargs)
        return "VERIFICATION: UNVERIFIED: the GUI behavior was not exercised"

    monkeypatch.setattr(src.llm_core, "llm_call_async", fake_call)
    issues = asyncio.run(agent_loop._run_verifier_subagent(
        "Create the GUI", "[bash] npm test (exit_code=0)",
        endpoint_url="http://localhost", model="test-model", headers={},
    ))

    assert issues == ["Unverified: the GUI behavior was not exercised"]
    assert len(calls) == 1


def test_verifier_logs_only_bounded_response_metadata(monkeypatch, caplog):
    import asyncio
    import logging
    import src.agent_loop as agent_loop
    import src.llm_core

    async def fake_call(**kwargs):
        kwargs["response_diagnostics"].update({
            "finish_reason": "length",
            "completion_tokens": 2048,
            "content_chars": 0,
            "reasoning_chars": 777,
        })
        return "VERIFICATION: UNVERIFIED: missing real UI evidence"

    monkeypatch.setattr(src.llm_core, "llm_call_async", fake_call)
    caplog.set_level(logging.INFO, logger="src.agent_loop")
    issues = asyncio.run(agent_loop._run_verifier_subagent(
        "Create the GUI", "evidence", endpoint_url="http://localhost",
        model="test-model", headers={},
    ))

    assert issues == ["Unverified: missing real UI evidence"]
    assert "finish_reason=length" in caplog.text
    assert "completion_tokens=2048" in caplog.text
    assert "content_chars=0 reasoning_chars=777" in caplog.text
    assert "missing real UI evidence" not in caplog.text


def test_verifier_format_retry_provider_error_is_bounded(monkeypatch):
    import asyncio
    import src.agent_loop as agent_loop
    import src.llm_core

    calls = []

    async def fail_second_call(**kwargs):
        calls.append(kwargs)
        if len(calls) == 1:
            return "analysis without a verdict"
        raise RuntimeError("offline")

    monkeypatch.setattr(src.llm_core, "llm_call_async", fail_second_call)
    issues = asyncio.run(agent_loop._run_verifier_subagent(
        "Create the GUI", "same evidence", endpoint_url="http://localhost",
        model="test-model", headers={},
    ))

    assert issues == [
        "Unverified: the completion reviewer was unavailable; report checks and remaining uncertainty."
    ]
    assert len(calls) == 2
