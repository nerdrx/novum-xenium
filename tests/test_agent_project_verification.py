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
                      cancel_during_verification=False, verifier_issues=None):
    monkeypatch.setattr(agent_loop, "get_setting",
                        lambda key, default=None: True if key == "agent_verifier_subagent" and verifier_issues is not None else default,
                        raising=False)
    monkeypatch.setattr(agent_loop, "get_mcp_manager", lambda: None, raising=False)
    monkeypatch.setattr(agent_loop, "estimate_tokens", lambda *_a, **_k: 10, raising=False)
    monkeypatch.setattr(agent_loop, "blocked_tools_for_owner", lambda _owner: set())
    monkeypatch.setattr(agent_runs, "get_run_id", lambda _sid: "run-verification")
    writes = []

    async def execute(block, *args, **kwargs):
        writes.append(block)
        path, content = block.content.split("\n", 1)
        (Path(workspace) / path).write_text(content, encoding="utf-8")
        return block.tool_type, {"output": "file saved", "exit_code": 0}

    monkeypatch.setattr(agent_loop, "execute_tool_block", execute)
    llm_round = 0

    async def fake_provider(_candidates, _messages, **_kwargs):
        nonlocal llm_round
        llm_round += 1
        if llm_round == 1:
            yield "data: " + json.dumps({"type": "tool_calls", "calls": [{
                "id": "write-1", "name": "write_file",
                "arguments": json.dumps({"path": "result.txt", "content": "verified"}),
            }]}) + "\n\n"
        else:
            yield 'data: {"delta":"Work finished."}\n\n'
        yield "data: [DONE]\n\n"

    monkeypatch.setattr(agent_loop, "stream_llm_with_fallback", fake_provider)
    if verifier_issues is not None:
        async def review(*_args, **_kwargs):
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
            "http://fake/v1", "test-model", [{"role": "user", "content": "Write the result file"}],
            session_id="session-1", owner="alice", workspace=str(workspace),
            relevant_tools={"write_file"}, approval_mode="full",
            plan_mode=plan_mode, incognito=incognito,
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
    assert len(writes) == 1, events
    assert (Path(workspace) / "result.txt").read_text(encoding="utf-8") == "verified"
    return events, verified


@pytest.mark.parametrize("report,passed", [
    ({"managed": True, "configured": True, "complete": True,
      "results": [{"name": "tests", "required": True, "passed": True}]}, True),
    ({"managed": True, "configured": True, "complete": False,
      "results": [{"name": "tests", "required": True, "passed": False}]}, False),
])
def test_native_file_write_emits_required_verification_result(monkeypatch, tmp_path, report, passed):
    events, calls = _run_native_write(monkeypatch, tmp_path, report)
    assert calls == [("alice", str(tmp_path), "session-1", "run-verification")]
    event = next(event for event in events if event.get("type") == "verification")
    assert event["passed"] is passed
    assert event["status"] == ("passed" if passed else "unverified")
    tool_output = next(event for event in events if event.get("type") == "tool_output" and event.get("tool") == "verification")
    assert tool_output["exit_code"] == (0 if passed else 1)
    metrics = next(event["data"] for event in events if event.get("type") == "metrics")
    assert any(item.get("tool") == "verification" for item in metrics["tool_events"])


def test_incognito_turn_skips_project_gate(monkeypatch, tmp_path):
    events, calls = _run_native_write(monkeypatch, tmp_path,
                                      {"managed": True, "configured": True, "complete": True},
                                      incognito=True)
    assert calls == []
    assert not any(event.get("type") == "verification" for event in events)


def test_ordinary_workspace_remains_unverified_without_false_pass(monkeypatch, tmp_path):
    events, calls = _run_native_write(monkeypatch, tmp_path, None)
    assert calls == [("alice", str(tmp_path), "session-1", "run-verification")]
    assert not any(event.get("type") == "verification" for event in events)


def test_stop_cancellation_interrupts_the_verification_await(monkeypatch, tmp_path):
    events, calls = _run_native_write(monkeypatch, tmp_path, None,
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
    events, _calls = _run_native_write(
        monkeypatch, tmp_path, {"managed": True, "configured": True, "complete": True},
        verifier_issues=["Unverified: no functional test evidence"],
    )
    terminal = next(event for event in events if event.get("type") == "agent_terminal")
    assert terminal["status"] == "failed"
    assert terminal["reason"] == "completion_unverified"
    assert "no functional test evidence" in terminal["message"]


def test_completion_verifier_keeps_original_task_after_short_name_answer(monkeypatch, tmp_path):
    monkeypatch.setattr(
        agent_loop, "get_setting",
        lambda key, default=None: (
            True if key == "agent_verifier_subagent"
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
