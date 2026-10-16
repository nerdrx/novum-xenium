"""Project verification is emitted after real native file-tool execution."""
from __future__ import annotations

import asyncio
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

import src.agent_loop as agent_loop
import src.agent_runs as agent_runs
from src import auth_helpers, group_chat_runner
from src.tool_approvals import ExactToolApproval, ToolApprovalStore
from src.tool_capabilities import capabilities_for_action
from routes import session_routes
from fastapi.responses import StreamingResponse


def _events(chunks):
    result = []
    for chunk in chunks:
        if chunk.startswith("data: ") and not chunk.startswith("data: [DONE]"):
            try:
                result.append(json.loads(chunk[6:]))
            except ValueError:
                pass
    return result


def _run_native_write(monkeypatch, workspace, verification, *, plan_mode=False, incognito=False,
                      cancel_during_verification=False, verifier_issues=None,
                      force_answer_after_recovery=False, coding_prompt=None,
                      scenario=None, exact_approval=None, review_calls=None):
    monkeypatch.setattr(agent_loop, "get_setting",
                        lambda key, default=None: (False if key == "agent_milestone_workflow" else
                                                   True if key == "agent_verifier_subagent" and verifier_issues is not None else default),
                        raising=False)
    monkeypatch.setattr(agent_loop, "get_mcp_manager", lambda: None, raising=False)
    monkeypatch.setattr(agent_loop, "estimate_tokens", lambda *_a, **_k: 10, raising=False)
    import src.model_context as model_context
    monkeypatch.setattr(model_context, "budget_context_for_model", lambda *_a, **_k: 128_000)
    monkeypatch.setattr(agent_loop, "blocked_tools_for_owner", lambda _owner: set())
    monkeypatch.setattr(agent_runs, "get_run_id", lambda _sid: "run-verification")
    writes = []

    async def execute(block, *args, **kwargs):
        if block.tool_type == "read_file":
            return block.tool_type, {"output": "Electron app setup and project structure", "exit_code": 0}
        if block.tool_type == "web_fetch":
            return block.tool_type, {"output": "Official GUI documentation", "exit_code": 0}
        if block.tool_type == "manage_skills":
            return block.tool_type, {"results": "Follow the reviewed GUI and visual verification procedures.", "exit_code": 0}
        if block.tool_type == "write_file":
            writes.append(block)
            try:
                args = json.loads(block.content)
                path, content = args["path"], args["content"]
            except (TypeError, ValueError, KeyError):
                path, content = block.content.split("\n", 1)
            (Path(workspace) / path).write_text(content, encoding="utf-8")
            return block.tool_type, {"output": "file saved", "exit_code": 0}
        raise AssertionError(f"Unexpected tool in verification test: {block.tool_type}")

    monkeypatch.setattr(agent_loop, "execute_tool_block", execute)
    llm_round = 0

    async def fake_provider(_candidates, _messages, **_kwargs):
        nonlocal llm_round
        llm_round += 1
        if scenario == "promise_then_write" and llm_round == 1:
            yield 'data: {"delta":"I will inspect the project files now."}\n\n'
        elif scenario == "promise_then_write" and llm_round == 2:
            yield "data: " + json.dumps({"type": "tool_calls", "calls": [{
                "id": "docs-first", "name": "web_fetch",
                "arguments": json.dumps({"url": "https://vendor.example/docs/gui"}),
            }]}) + "\n\n"
        elif scenario == "promise_then_write" and llm_round == 3:
            yield "data: " + json.dumps({"type": "tool_calls", "calls": [{
                "id": "view-ui-design", "name": "manage_skills",
                "arguments": json.dumps({"action": "view", "name": "ui-design"}),
            }]}) + "\n\n"
        elif scenario == "promise_then_write" and llm_round == 4:
            yield "data: " + json.dumps({"type": "tool_calls", "calls": [{
                "id": "view-visual-verification", "name": "manage_skills",
                "arguments": json.dumps({"action": "view", "name": "visual-verification"}),
            }]}) + "\n\n"
        elif scenario == "promise_then_write" and llm_round == 5:
            yield "data: " + json.dumps({"type": "tool_calls", "calls": [{
                "id": "read-after-nudge", "name": "read_file",
                "arguments": json.dumps({"path": "README.md"}),
            }]}) + "\n\n"
        elif scenario == "promise_then_write" and llm_round == 6:
            yield "data: " + json.dumps({"type": "tool_calls", "calls": [{
                "id": "write-after-nudge", "name": "write_file",
                "arguments": json.dumps({"path": "result.txt", "content": "verified"}),
            }]}) + "\n\n"
        elif scenario in ("read_then_fake", "read_then_write", "approval_resume") and llm_round == 1:
            yield "data: " + json.dumps({"type": "tool_calls", "calls": [{
                "id": "read-project", "name": "read_file",
                "arguments": json.dumps({"path": "README.md"}),
            }]}) + "\n\n"
        elif scenario == "read_then_write" and llm_round == 2:
            yield "data: " + json.dumps({"type": "tool_calls", "calls": [{
                "id": "write-result", "name": "write_file",
                "arguments": json.dumps({"path": "result.txt", "content": "verified"}),
            }]}) + "\n\n"
        elif scenario == "read_then_fake":
            yield 'data: {"delta":"Everything is ready. The fixes and tests are complete."}\n\n'
        elif llm_round == 1 or (force_answer_after_recovery and llm_round in (3, 4)):
            path = "result.txt" if llm_round == 1 else "repair.txt"
            content = "verified" if llm_round == 1 else "repaired"
            yield "data: " + json.dumps({"type": "tool_calls", "calls": [{
                "id": f"write-{llm_round}", "name": "write_file",
                "arguments": json.dumps({"path": path, "content": content}),
            }]}) + "\n\n"
        elif force_answer_after_recovery and llm_round in (2, 5):
            yield 'data: {"delta":"Everything is ready."}\n\n'
        else:
            yield 'data: {"delta":"Work finished."}\n\n'
        yield "data: [DONE]\n\n"

    monkeypatch.setattr(agent_loop, "stream_llm_with_fallback", fake_provider)
    if force_answer_after_recovery:
        runaway_checks = 0
        def detect_runaway(_calls):
            nonlocal runaway_checks
            runaway_checks += 1
            return "write_file" if runaway_checks == 3 else None
        monkeypatch.setattr(agent_loop, "_detect_runaway_call", detect_runaway)
    if verifier_issues is not None:
        async def review(*_args, **_kwargs):
            if review_calls is not None:
                review_calls.append(True)
            return list(verifier_issues)
        monkeypatch.setattr(agent_loop, "_run_verifier_subagent", review)
    import src.project_workflows as workflows
    verified = []
    verification_started = asyncio.Event()

    async def check(owner, path, *, session_id=None, run_id=None):
        verified.append((owner, path, session_id, run_id))
        if cancel_during_verification:
            verification_started.set()
            await asyncio.Event().wait()
        return verification

    monkeypatch.setattr(workflows, "run_workspace_verification", check)

    async def collect():
        return [chunk async for chunk in agent_loop.stream_agent_loop(
            "http://fake/v1", "test-model", [{"role": "user", "content": coding_prompt or "Write the result file"}],
            session_id="session-1", owner="alice", workspace=str(workspace),
                relevant_tools={"read_file", "write_file", "manage_skills", "web_fetch"}, approval_mode="full",
            plan_mode=plan_mode, incognito=incognito,
            exact_approval=exact_approval,
        )]

    async def collect_or_cancel():
        if not cancel_during_verification:
            return await collect()
        task = asyncio.create_task(collect())
        await verification_started.wait()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        return []

    events = _events(asyncio.run(collect_or_cancel()))
    expected_writes = 0 if scenario == "read_then_fake" else 1 if scenario in ("read_then_write", "approval_resume", "promise_then_write") else (2 if force_answer_after_recovery else 1)
    assert len(writes) == expected_writes, events
    if expected_writes:
        assert (Path(workspace) / "result.txt").read_text(encoding="utf-8") == "verified"
    return events, verified, writes


@pytest.mark.parametrize("report,passed", [
    ({"managed": True, "configured": True, "complete": True,
      "results": [{"name": "tests", "required": True, "passed": True}]}, True),
    ({"managed": True, "configured": True, "complete": False,
      "results": [{"name": "tests", "required": True, "passed": False}]}, False),
])
def test_native_file_write_emits_required_verification_result(monkeypatch, tmp_path, report, passed):
    events, calls, _writes = _run_native_write(monkeypatch, tmp_path, report)
    assert calls == [("alice", str(tmp_path), "session-1", "run-verification")]
    event = next(event for event in events if event.get("type") == "verification")
    assert event["passed"] is passed
    assert event["status"] == ("passed" if passed else "unverified")
    tool_output = next(event for event in events if event.get("type") == "tool_output" and event.get("tool") == "verification")
    assert tool_output["exit_code"] == (0 if passed else 1)
    metrics = next(event["data"] for event in events if event.get("type") == "metrics")
    assert any(item.get("tool") == "verification" for item in metrics["tool_events"])


def test_incognito_turn_skips_project_gate(monkeypatch, tmp_path):
    events, calls, _writes = _run_native_write(monkeypatch, tmp_path,
                                               {"managed": True, "configured": True, "complete": True},
                                               incognito=True)
    assert calls == []
    assert not any(event.get("type") == "verification" for event in events)


def test_ordinary_workspace_remains_unverified_without_false_pass(monkeypatch, tmp_path):
    events, calls, _writes = _run_native_write(monkeypatch, tmp_path, None)
    assert calls == [("alice", str(tmp_path), "session-1", "run-verification")]
    assert not any(event.get("type") == "verification" for event in events)


def test_stop_cancellation_interrupts_the_verification_await(monkeypatch, tmp_path):
    events, calls, _writes = _run_native_write(monkeypatch, tmp_path, None,
                                                cancel_during_verification=True)
    assert events == []
    assert calls == [("alice", str(tmp_path), "session-1", "run-verification")]


def _group_runner(monkeypatch, events):
    monkeypatch.setattr(auth_helpers, "storage_owner_for_request", lambda request: request.state.current_user)
    monkeypatch.setattr(session_routes, "_verify_session_owner", lambda *_args: None)
    monkeypatch.setattr(group_chat_runner.agent_runs, "is_active", lambda _sid: False)
    monkeypatch.setattr(group_chat_runner.agent_runs, "get_status", lambda _sid: "done")

    async def chat_stream(_request):
        async def body():
            for event in events:
                yield event
        return StreamingResponse(body(), headers={"X-Odysseus-Run-Id": "run-1"})

    sessions = SimpleNamespace(get_session=lambda _sid: SimpleNamespace(model="model-a"))
    runner = group_chat_runner.create_assignment_runner(chat_stream, sessions)
    context = {
        "request_scope": {"state": {"current_user": "alice"}, "headers": []},
        "models": {"participant": "model-a"},
    }
    return runner, context


def test_group_runner_fails_required_verification_and_marks_manual_unverified(monkeypatch):
    failing_report = json.dumps({"results": [{"name": "tests", "required": True, "passed": False}]})
    runner, context = _group_runner(monkeypatch, [
        'data: {"type":"verification","passed":false,"status":"unverified"}\n\n',
        "data: " + json.dumps({"type": "tool_output", "tool": "verification",
                               "exit_code": 1, "output": failing_report}) + "\n\n",
        "data: [DONE]\n\n",
    ])
    with pytest.raises(RuntimeError, match="Required project checks failed"):
        asyncio.run(runner("participant", "Implement", read_only=False, owner="alice", context=context))

    runner, context = _group_runner(monkeypatch, [
        'data: {"type":"verification","passed":false,"status":"unverified"}\n\n',
        "data: [DONE]\n\n",
    ])
    result = asyncio.run(runner("participant", "Implement", read_only=False, owner="alice", context=context))
    assert "human review required" in result

    runner, context = _group_runner(monkeypatch, ['data: [DONE]\n\n'])
    result = asyncio.run(runner("participant", "Implement", read_only=False, owner="alice", context=context))
    assert "human review required" in result


def test_unresolved_completion_verifier_emits_failed_terminal(monkeypatch, tmp_path):
    events, _calls, _writes = _run_native_write(
        monkeypatch, tmp_path, {"managed": True, "configured": True, "complete": True},
        verifier_issues=["Unverified: no functional test evidence"],
    )
    terminal = next((event for event in events if event.get("type") == "agent_terminal"), None)
    assert terminal is not None, events
    assert terminal["status"] == "failed"
    assert terminal["reason"] == "completion_unverified"
    assert "no functional test evidence" in terminal["message"]
    assert not any("Work finished." in event.get("delta", "") for event in events)
    metrics = next(event["data"] for event in events if event.get("type") == "metrics")
    assert "Work finished." not in " ".join(metrics.get("round_texts", []))
    assert "**Incomplete — completion not verified:**" in " ".join(metrics.get("round_texts", []))


def test_failed_review_remains_held_during_force_answer_round(monkeypatch, tmp_path):
    events, _calls, _writes = _run_native_write(
        monkeypatch, tmp_path, {"managed": True, "configured": True, "complete": True},
        verifier_issues=["Unverified: functional check missing"],
        force_answer_after_recovery=True,
    )
    terminal = next((event for event in events if event.get("type") == "agent_terminal"), None)
    assert terminal is not None, events
    deltas = "".join(event.get("delta", "") for event in events)
    metrics = next(event["data"] for event in events if event.get("type") == "metrics")
    assert terminal["status"] == "failed"
    assert "Everything is ready." not in deltas
    assert "Everything is ready." not in " ".join(metrics.get("round_texts", []))
    assert "Incomplete — completion not verified" in deltas


def test_substantive_repair_holds_read_only_fake_completion(monkeypatch, tmp_path):
    events, _calls, _writes = _run_native_write(
        monkeypatch, tmp_path,
        {"managed": True, "configured": True, "complete": True},
        verifier_issues=[], scenario="read_then_fake",
        coding_prompt="Repair the existing desktop GUI layout in this workspace.",
    )
    deltas = "".join(event.get("delta", "") for event in events)
    terminal = next(event for event in events if event.get("type") == "agent_terminal")
    metrics = next(event["data"] for event in events if event.get("type") == "metrics")
    assert terminal["status"] == "failed"
    assert terminal["reason"] == "completion_unverified"
    assert "Everything is ready" not in deltas
    assert "Everything is ready" not in " ".join(metrics.get("round_texts", []))
    assert "Incomplete — completion not verified" in deltas


def test_substantive_repair_releases_completion_only_after_review(monkeypatch, tmp_path):
    from services.memory.skills import SkillsManager
    skills = [
        {"name": name, "description": "Review this GUI task", "status": "published",
         "audit_verdict": "pass", "confidence": 1.0, "category": "design",
         "tags": ["gui"], "procedure": [], "requires_toolsets": []}
        for name in ("ui-design", "visual-verification")
    ]
    monkeypatch.setattr(SkillsManager, "load", lambda self, owner=None: skills)
    monkeypatch.setattr(
        SkillsManager, "get_relevant_skills",
        lambda self, query, **kwargs: skills,
    )
    reviews = []
    events, _calls, _writes = _run_native_write(
        monkeypatch, tmp_path,
        {"managed": True, "configured": True, "complete": True},
        verifier_issues=[], scenario="promise_then_write", review_calls=reviews,
        coding_prompt=("Repair the existing desktop GUI layout in this workspace using "
                       "https://vendor.example/docs/gui."),
    )
    deltas = "".join(event.get("delta", "") for event in events)
    assert len(reviews) == 1
    assert "Work finished." in deltas
    assert not any(event.get("type") == "agent_terminal" for event in events)


def test_substantive_repair_verifier_opt_out_keeps_normal_stream(monkeypatch, tmp_path):
    events, _calls, _writes = _run_native_write(
        monkeypatch, tmp_path, None, scenario="read_then_fake",
        coding_prompt="Repair the existing desktop GUI layout in this workspace.",
    )
    deltas = "".join(event.get("delta", "") for event in events)
    assert "Everything is ready. The fixes and tests are complete." in deltas
    assert not any(event.get("type") == "agent_terminal" for event in events)


def test_exact_approval_resume_still_requires_passing_review(monkeypatch, tmp_path):
    prompt = "Repair the existing desktop GUI layout in this workspace."
    content = json.dumps({"path": "result.txt", "content": "verified"})
    pending = ToolApprovalStore().create(
        owner="alice", session_id="session-1", origin_run_id="run-approved",
        tool_name="write_file", content=content, workspace=str(tmp_path),
        continuation_query=prompt, external_untrusted_context_seen=False,
        selected_tools=["read_file", "write_file"],
        capabilities=capabilities_for_action("write_file", content),
    )
    grant = ExactToolApproval(pending)
    reviews = []
    events, _calls, _writes = _run_native_write(
        monkeypatch, tmp_path,
        {"managed": True, "configured": True, "complete": True},
        verifier_issues=[], scenario="approval_resume", exact_approval=grant,
        review_calls=reviews, coding_prompt=prompt,
    )
    deltas = "".join(event.get("delta", "") for event in events)
    assert len(reviews) == 1
    assert "Work finished." in deltas
    assert not any(event.get("type") == "agent_terminal" for event in events)


def test_held_completion_requires_real_action_not_plan_update():
    assert agent_loop._completion_action_succeeded(
        "write_file", {"output": "saved", "exit_code": 0},
    )
    assert agent_loop._completion_action_succeeded(
        "bash", {"output": "tests passed", "exit_code": 0},
    )
    assert not agent_loop._completion_action_succeeded(
        "update_plan", {"output": "Plan updated", "exit_code": 0},
    )
    assert not agent_loop._completion_action_succeeded(
        "write_file", {"error": "blocked", "blocked": True, "exit_code": 1},
    )
    assert not agent_loop._completion_action_succeeded(
        "bash", {"approval_required": True, "exit_code": None},
    )


def test_completion_recovery_text_waits_for_tool_and_passing_review(monkeypatch, tmp_path):
    monkeypatch.setattr(agent_loop, "get_setting",
                        lambda key, default=None: True if key == "agent_verifier_subagent" else default,
                        raising=False)
    monkeypatch.setattr(agent_loop, "get_mcp_manager", lambda: None, raising=False)
    monkeypatch.setattr(agent_loop, "estimate_tokens", lambda *_a, **_k: 10, raising=False)
    monkeypatch.setattr(agent_loop, "blocked_tools_for_owner", lambda _owner: set())
    monkeypatch.setattr(agent_runs, "get_run_id", lambda _sid: "run-verification-recovery")
    writes = []

    async def execute(block, *args, **kwargs):
        writes.append(block)
        path, content = block.content.split("\n", 1)
        (Path(tmp_path) / path).write_text(content, encoding="utf-8")
        return block.tool_type, {"output": "file saved", "exit_code": 0}

    monkeypatch.setattr(agent_loop, "execute_tool_block", execute)
    provider_round = 0

    async def provider(_candidates, _messages, **_kwargs):
        nonlocal provider_round
        provider_round += 1
        if provider_round in (1, 3):
            progress = "Initial write starting.\n" if provider_round == 1 else "Repair action executed.\n"
            yield 'data: ' + json.dumps({"delta": progress}) + "\n\n"
            yield "data: " + json.dumps({"type": "tool_calls", "calls": [{
                "id": f"write-{provider_round}", "name": "write_file",
                "arguments": json.dumps({
                    "path": "result.txt" if provider_round == 1 else "repair.txt",
                    "content": "verified" if provider_round == 1 else "repaired",
                }),
            }]}) + "\n\n"
        elif provider_round == 2:
            yield 'data: {"delta":"Everything is ready."}\n\n'
        else:
            yield 'data: {"delta":"Verified complete."}\n\n'
        yield "data: [DONE]\n\n"

    monkeypatch.setattr(agent_loop, "stream_llm_with_fallback", provider)
    review_calls = 0

    async def review(*_args, **_kwargs):
        nonlocal review_calls
        review_calls += 1
        return ["Functional check missing"] if review_calls == 1 else []

    monkeypatch.setattr(agent_loop, "_run_verifier_subagent", review)
    import src.project_workflows as workflows
    async def check(*_args, **_kwargs):
        return {"managed": True, "configured": True, "complete": True}
    monkeypatch.setattr(workflows, "run_workspace_verification", check)

    events = _events(asyncio.run(_collect_agent(
        [{"role": "user", "content": "Write and verify the result file"}], tmp_path,
    )))
    deltas = "".join(event.get("delta", "") for event in events)
    assert len(writes) == 2
    assert "Everything is ready." not in deltas
    assert "Initial write starting." in deltas
    assert "Repair action executed." in deltas
    assert "Verified complete." in deltas
    assert not any(event.get("type") == "agent_terminal" for event in events)


def test_completion_verifier_keeps_original_task_after_short_name_answer(monkeypatch, tmp_path):
    monkeypatch.setattr(
        agent_loop, "get_setting",
        lambda key, default=None: (
            False if key == "agent_milestone_workflow"
            else True if key == "agent_verifier_subagent"
            else False if key == "agent_coding_grounding"
            else default
        ),
        raising=False,
    )
    monkeypatch.setattr(agent_loop, "get_mcp_manager", lambda: None, raising=False)
    monkeypatch.setattr(agent_loop, "estimate_tokens", lambda *_a, **_k: 10, raising=False)
    monkeypatch.setattr(agent_loop, "blocked_tools_for_owner", lambda _owner: set())
    monkeypatch.setattr(agent_runs, "get_run_id", lambda _sid: "run-original-task")
    original = (
        "Build a GUI that converts video with FFmpeg, preserves subtitles, "
        "lets me select the output folder, and shows conversion progress."
    )
    verifier_requests = []

    async def execute(block, *args, **kwargs):
        path, content = block.content.split("\n", 1)
        (Path(tmp_path) / path).write_text(content, encoding="utf-8")
        return block.tool_type, {"output": "file saved", "exit_code": 0}

    monkeypatch.setattr(agent_loop, "execute_tool_block", execute)

    provider_round = 0

    async def provider(_candidates, _messages, **_kwargs):
        nonlocal provider_round
        provider_round += 1
        if provider_round == 1:
            yield "data: " + json.dumps({"type": "tool_calls", "calls": [{
                "id": "write-original-task", "name": "write_file",
                "arguments": json.dumps({"path": "app.py", "content": "# implementation"}),
            }]}) + "\n\n"
        else:
            yield 'data: {"delta":"Work finished."}\n\n'
        yield "data: [DONE]\n\n"

    monkeypatch.setattr(agent_loop, "stream_llm_with_fallback", provider)

    async def review(instruction, _actions, **_kwargs):
        verifier_requests.append(instruction)
        return []

    monkeypatch.setattr(agent_loop, "_run_verifier_subagent", review)
    messages = [
        {"role": "user", "content": original},
        {"role": "assistant", "content": "What should the GUI be called?"},
        {"role": "user", "content": "Nova"},
    ]
    events = _events(asyncio.run(_collect_agent(messages, tmp_path)))
    assert len(verifier_requests) == 1
    assert original in verifier_requests[0]
    assert "Latest user instruction: Nova" in verifier_requests[0]
    assert (tmp_path / "app.py").read_text(encoding="utf-8") == "# implementation"
    assert not any(event.get("type") == "agent_terminal" for event in events)


async def _collect_agent(messages, workspace):
    return [chunk async for chunk in agent_loop.stream_agent_loop(
        "http://fake/v1", "test-model", messages,
        workspace=str(workspace), relevant_tools={"write_file"},
        approval_mode="full", max_rounds=4,
    )]
