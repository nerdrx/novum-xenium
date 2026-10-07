"""Bulk tool data stays retrievable without occupying the full prompt."""
import asyncio
import json
import re
import threading

import pytest
import src.agent_loop as loop
from src.agent_tools.context_tools import ContextSearchTool
from src.tool_capabilities import ToolRunSecurityContext


def test_bulk_output_is_indexed_and_retrieved_in_real_agent_loop(monkeypatch, tmp_path):
    import src.tool_result_store as store
    monkeypatch.setattr(store, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(loop, "get_setting", lambda key, default=None: default)
    monkeypatch.setattr(loop, "get_mcp_manager", lambda: None)
    monkeypatch.setattr(loop, "blocked_tools_for_owner", lambda owner: set())
    monkeypatch.setattr(loop, "_agent_route_tool_mode", lambda *args, **kwargs: (True, False, False))
    monkeypatch.setattr(loop, "_build_system_prompt", lambda messages, *args, **kwargs: (list(messages), []))
    requests = []
    needle = "EXACT_IMPORTANT_DETAIL"
    raw = "Start of page. " * 1000 + needle + " End of page. " * 1000

    async def execute(block, **kwargs):
        if block.tool_type == "web_fetch":
            return "public page", {"output": raw, "exit_code": 0}
        assert block.tool_type == "context_search"
        return "context search", await ContextSearchTool().execute(block.content, kwargs)

    async def stream(candidates, messages, **kwargs):
        request = await kwargs["candidate_request_factory"](0, *candidates[0])
        shaped = request["messages"]
        requests.append(shaped)
        tools = {schema["function"]["name"] for schema in request["kwargs"]["tools"]}
        assert "context_search" in tools
        if len(requests) == 1:
            calls = [{"id": "fetch", "name": "web_fetch", "arguments": '{"url":"https://github.com/nerdrx"}'}]
        elif len(requests) == 2:
            result = next(m for m in reversed(shaped) if m["role"] == "tool")
            assert len(result["content"]) < 1600
            assert needle not in result["content"]
            assert result["metadata"]["trusted"] is False
            result_id = re.search(r"stored as ([\w-]+)", result["content"]).group(1)
            calls = [{"id": "retrieve", "name": "context_search", "arguments": json.dumps({"query": needle, "result_id": result_id})}]
        else:
            result = next(m for m in reversed(shaped) if m["role"] == "tool")
            assert needle in result["content"]
            assert result["metadata"]["trusted"] is False
            yield 'data: {"delta":"Found the exact detail."}\n\n'
            yield "data: [DONE]\n\n"
            return
        yield "data: " + json.dumps({"type": "tool_calls", "calls": calls}) + "\n\n"
        yield "data: [DONE]\n\n"

    monkeypatch.setattr(loop, "execute_tool_block", execute)
    monkeypatch.setattr(loop, "stream_llm_with_fallback", stream)

    async def run():
        return [event async for event in loop.stream_agent_loop(
            "https://local.test/v1", "qwen3-test", [{"role": "user", "content": "Find the important detail."}],
            owner="alice", session_id="chat-a", relevant_tools={"web_fetch"},
            max_rounds=3, _is_teacher_run=True,
        )]

    events = asyncio.run(run())
    assert len(requests) == 3
    assert any('"context_result_id"' in event for event in events)
    assert not any('"kind": "tool_approval"' in event for event in events)


@pytest.mark.asyncio
async def test_search_arguments_cannot_choose_another_scope(tmp_path, monkeypatch):
    import src.tool_result_store as store
    monkeypatch.setattr(store, "DATA_DIR", str(tmp_path))
    store.archive_result("bob", "secret-chat", "read_file", "private secret")
    tool = ContextSearchTool()
    for args in [{"query": "private", "owner": "bob"}, {"query": "private", "session_id": "secret-chat"}]:
        assert (await tool.execute(json.dumps(args), {"owner": "alice", "session_id": "chat-a"}))["exit_code"] == 1
    result = await tool.execute('{"query":"private"}', {"owner": "alice", "session_id": "chat-a"})
    assert "private secret" not in result["output"]


@pytest.mark.asyncio
async def test_deleted_session_waits_for_archive_worker_before_reuse(tmp_path, monkeypatch):
    import src.tool_result_store as store
    from src import agent_runs

    monkeypatch.setattr(store, "DATA_DIR", str(tmp_path))
    started = threading.Event()
    finish = threading.Event()
    session_id = "delete-during-archive"

    def slow_archive(*args):
        started.set()
        assert finish.wait(5)
        return store.archive_result(*args)

    async def stream():
        result_id = await loop._archive_result_until_worker_finishes(
            slow_archive, "alice", session_id, "fetch", "deleted content",
        )
        yield result_id

    run = agent_runs.start(session_id, stream(), owner="alice", persist=False)
    try:
        assert await asyncio.to_thread(started.wait, 2)
        assert agent_runs.fence_deleted_session(session_id, "alice")
        with pytest.raises(ValueError, match="still draining"):
            agent_runs.ensure_session_reusable(session_id)
        assert not run.task.done()
        await asyncio.sleep(0)
        assert agent_runs.stop(session_id, run.run_id)
        assert not run.task.done()

        finish.set()
        await asyncio.wait_for(run.task, 2)
        assert store.results_fenced("alice", session_id)
        with pytest.raises(ValueError, match="still draining"):
            agent_runs.ensure_session_reusable(session_id)
        store.delete_results("alice", session_id)
        agent_runs.complete_session_deletion("alice", session_id)
        assert store.get_result_stats("alice", session_id) == {"count": 0, "bytes": 0}
        assert not store.results_fenced("alice", session_id)
        agent_runs.ensure_session_reusable(session_id)
    finally:
        finish.set()
        if not run.task.done():
            run.task.cancel()
            await asyncio.gather(run.task, return_exceptions=True)
        if run.evict_task and not run.evict_task.done():
            run.evict_task.cancel()
        agent_runs._RUNS.pop(session_id, None)


@pytest.mark.asyncio
async def test_delete_fence_blocks_queued_start_until_cleanup(tmp_path, monkeypatch):
    import src.tool_result_store as store
    from src import agent_runs

    monkeypatch.setattr(store, "DATA_DIR", str(tmp_path))
    session_id = "delete-before-start"

    async def stream():
        yield "unexpected"

    assert agent_runs.fence_deleted_session(session_id, "alice")
    with pytest.raises(ValueError, match="being deleted"):
        agent_runs.start(session_id, stream(), owner="alice", persist=False)
    store.delete_results("alice", session_id)
    agent_runs.complete_session_deletion("alice", session_id)
    run = agent_runs.start(session_id, stream(), owner="alice", persist=False)
    try:
        await asyncio.wait_for(run.task, 2)
    finally:
        if run.evict_task and not run.evict_task.done():
            run.evict_task.cancel()
        agent_runs._RUNS.pop(session_id, None)


def test_context_retrieval_keeps_untrusted_action_gate():
    run = ToolRunSecurityContext(external_untrusted_context_seen=True)
    assert run.decision_for("context_search", '{"query":"detail"}').allowed
    assert not run.decision_for("bash", "cat private").allowed
    assert not ToolRunSecurityContext(delegated_credential=True).decision_for("context_search").allowed
