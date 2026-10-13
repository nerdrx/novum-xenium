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
    needle = "EXACTIMPORTANTDETAIL"
    opening_detail = "Opening hours Monday-Friday 08:00-18:00, Saturday 08:00-12:30."
    raw = ("# Guide overview\n" + "Site navigation. " * 60 + opening_detail
           + " Start of page. " * 1000 + "\n## 13. Later design amendment\n"
           + "Use the updated palette.\n" + needle + "\n" + " End of page. " * 1000)

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
            assert len(result["content"]) < 2800
            assert opening_detail in result["content"]
            assert needle not in result["content"]
            assert "Untrusted source headings" in result["content"]
            assert "13. Later design amendment" in result["content"]
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


def test_large_result_that_exceeds_remaining_input_budget_is_archived(monkeypatch, tmp_path):
    import src.tool_result_store as store

    monkeypatch.setattr(store, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(
        loop, "get_setting",
        lambda key, default=None: 1400 if key == "agent_input_token_budget" else default,
    )
    monkeypatch.setattr(loop, "get_mcp_manager", lambda: None)
    monkeypatch.setattr(loop, "blocked_tools_for_owner", lambda owner: set())
    monkeypatch.setattr(loop, "_agent_route_tool_mode", lambda *args, **kwargs: (True, False, False))
    monkeypatch.setattr(loop, "_build_system_prompt", lambda messages, *args, **kwargs: (list(messages), []))
    monkeypatch.setattr("src.model_context.budget_context_for_model", lambda *args, **kwargs: 20000)
    requests = []
    needle = "EXACT_DETAIL_BURIED_IN_RESULT"
    padding = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega "
    raw = padding * 40 + needle + padding * 3

    async def execute(block, **kwargs):
        if block.tool_type == "web_fetch":
            return "fetch", {"output": raw, "exit_code": 0}
        assert block.tool_type == "context_search"
        return "search", await ContextSearchTool().execute(block.content, kwargs)

    async def stream(candidates, messages, **kwargs):
        request = await kwargs["candidate_request_factory"](0, *candidates[0])
        names = {item["function"]["name"] for item in request["kwargs"]["tools"]}
        requests.append(request["messages"])
        if len(requests) == 1:
            yield 'data: ' + json.dumps({"type": "tool_calls", "calls": [
                {"id": "fetch", "name": "web_fetch", "arguments": '{"url":"https://example.test"}'}
            ]}) + "\n\n"
        elif len(requests) == 2:
            result = next(m for m in reversed(request["messages"]) if m["role"] == "tool")
            assert "stored as" in result["content"], (
                "The fetch detail was truncated from the current request and no archive is available."
            )
            assert "context_search" in names
            result_id = re.search(r"stored as ([\w-]+)", result["content"]).group(1)
            calls = [{
                "id": "retrieve", "name": "context_search",
                "arguments": json.dumps({"query": needle, "result_id": result_id}),
            }]
            yield "data: " + json.dumps({"type": "tool_calls", "calls": calls}) + "\n\n"
        else:
            assert needle in next(m for m in reversed(request["messages"]) if m["role"] == "tool")["content"]
            yield 'data: {"delta":"Recovered exact detail."}\n\n'
        yield "data: [DONE]\n\n"

    monkeypatch.setattr(loop, "execute_tool_block", execute)
    monkeypatch.setattr(loop, "stream_llm_with_fallback", stream)

    async def run():
        return [event async for event in loop.stream_agent_loop(
            "https://local.test/v1", "gpt-6-luna",
            [{"role": "user", "content": "Find the exact detail."}],
            owner="alice", session_id="chat-small-budget", relevant_tools={"web_fetch"},
            max_tokens=512, max_rounds=3, _is_teacher_run=True,
        )]

    events = asyncio.run(run())
    assert len(requests) == 3
    assert any('"context_result_id"' in event for event in events)
    assert any("Recovered exact detail." in event for event in events)


def test_source_archive_preserves_literal_newlines_and_quotes_for_exact_chunks(monkeypatch, tmp_path):
    import src.tool_result_store as store

    monkeypatch.setattr(store, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(loop, "get_setting", lambda key, default=None: default)
    monkeypatch.setattr(loop, "get_mcp_manager", lambda: None)
    monkeypatch.setattr(loop, "blocked_tools_for_owner", lambda owner: set())
    monkeypatch.setattr(loop, "_agent_route_tool_mode", lambda *args, **kwargs: (True, False, False))
    monkeypatch.setattr(loop, "_build_system_prompt", lambda messages, *args, **kwargs: (list(messages), []))
    monkeypatch.setattr("src.model_context.budget_context_for_model", lambda *args, **kwargs: 20000)
    source = "start\n" + ("padding words here. " * 65) + 'const exact = "quoted";\nnextLine();\n' + ("end words. " * 650)
    exact = 'const exact = "quoted";\nnextLine();'
    requests = []

    async def execute(block, **kwargs):
        if block.tool_type == "context_search":
            return "search", await ContextSearchTool().execute(block.content, kwargs)
        return "read", {"output": source, "exit_code": 0}

    async def stream(candidates, messages, **kwargs):
        request = await kwargs["candidate_request_factory"](0, *candidates[0])
        requests.append(request["messages"])
        if len(requests) == 1:
            calls = [{"id": "read", "name": "read_file", "arguments": '{"path":"app.js"}'}]
        elif len(requests) == 2:
            tool = next(m for m in reversed(request["messages"]) if m["role"] == "tool")
            assert "stored as" in tool["content"]
            assert "const exact" not in tool["content"]
            result_id = re.search(r"stored as ([\w-]+)", tool["content"]).group(1)
            calls = [{"id": "find", "name": "context_search", "arguments": json.dumps({"query": "const exact", "result_id": result_id})}]
        elif len(requests) == 3:
            tool = next(m for m in reversed(request["messages"]) if m["role"] == "tool")
            chunk = re.search(r"\[(\S+) \| read_file \| chunk (\d+)\]", tool["content"])
            assert chunk, tool["content"]
            calls = [{"id": "chunk", "name": "context_search", "arguments": json.dumps({"query": "", "result_id": chunk.group(1), "offset": int(chunk.group(2))})}]
        else:
            tool = next(m for m in reversed(request["messages"]) if m["role"] == "tool")
            assert exact in tool["content"]
            assert r'\\n' not in tool["content"]
            assert tool["metadata"]["trusted"] is False
            yield 'data: {"delta":"Recovered exact source."}\n\n'
            yield "data: [DONE]\n\n"
            return
        yield "data: " + json.dumps({"type": "tool_calls", "calls": calls}) + "\n\n"
        yield "data: [DONE]\n\n"

    monkeypatch.setattr(loop, "execute_tool_block", execute)
    monkeypatch.setattr(loop, "stream_llm_with_fallback", stream)

    async def run():
        return [event async for event in loop.stream_agent_loop(
            "https://local.test/v1", "gpt-6-luna", [{"role": "user", "content": "Inspect the source."}],
            owner="alice", session_id="chat-source-exact", relevant_tools={"read_file"},
            max_tokens=512, max_rounds=4, _is_teacher_run=True,
        )]

    asyncio.run(run())
    assert len(requests) == 4


def test_subprocess_failure_archive_keeps_error_and_both_streams(monkeypatch, tmp_path):
    import src.tool_result_store as store

    monkeypatch.setattr(store, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(loop, "get_setting", lambda key, default=None: 1400 if key == "agent_input_token_budget" else default)
    monkeypatch.setattr(loop, "get_mcp_manager", lambda: None)
    monkeypatch.setattr(loop, "blocked_tools_for_owner", lambda owner: set())
    monkeypatch.setattr(loop, "_agent_route_tool_mode", lambda *args, **kwargs: (True, False, False))
    monkeypatch.setattr(loop, "_build_system_prompt", lambda messages, *args, **kwargs: (list(messages), []))
    monkeypatch.setattr("src.model_context.budget_context_for_model", lambda *args, **kwargs: 20000)
    failure = {
        "error": "python: timed out after 30s — process killed",
        "exit_code": 124,
        "stdout": "partial stdout\n" + ("stdout padding. " * 250),
        "stderr": "traceback line\n" + ("stderr padding. " * 250),
    }
    requests = []
    result_id_holder = []

    async def execute(block, **kwargs):
        if block.tool_type == "context_search":
            return "search", await ContextSearchTool().execute(block.content, kwargs)
        return "python", failure

    async def stream(candidates, messages, **kwargs):
        request = await kwargs["candidate_request_factory"](0, *candidates[0])
        requests.append(request["messages"])
        if len(requests) == 1:
            calls = [{"id": "python", "name": "python", "arguments": '{"code":"print(1)"}'}]
        elif len(requests) == 2:
            tool = next(m for m in reversed(request["messages"]) if m["role"] == "tool")
            assert "stored as" in tool["content"]
            result_id = re.search(r"stored as ([\w-]+)", tool["content"]).group(1)
            result_id_holder.append(result_id)
            calls = [{"id": "search-error", "name": "context_search", "arguments": json.dumps({"query": "timed out", "result_id": result_id})}]
        elif len(requests) == 3:
            tool = next(m for m in reversed(request["messages"]) if m["role"] == "tool")
            chunk = re.search(r"\[(\S+) \| python \| chunk (\d+)\]", tool["content"])
            assert chunk
            calls = [{"id": "read-error", "name": "context_search", "arguments": json.dumps({"query": "", "result_id": chunk.group(1), "offset": int(chunk.group(2))})}]
        elif len(requests) == 4:
            tool = next(m for m in reversed(request["messages"]) if m["role"] == "tool")
            for evidence in (failure["error"], "[stdout]", "partial stdout", "exit_code=124"):
                assert evidence in tool["content"]
            calls = [{"id": "search-stderr", "name": "context_search", "arguments": json.dumps({"query": "traceback", "result_id": result_id_holder[0]})}]
        elif len(requests) == 5:
            tool = next(m for m in reversed(request["messages"]) if m["role"] == "tool")
            chunk = re.search(r"\[(\S+) \| python \| chunk (\d+)\]", tool["content"])
            assert chunk
            calls = [{"id": "read-stderr", "name": "context_search", "arguments": json.dumps({"query": "", "result_id": chunk.group(1), "offset": int(chunk.group(2))})}]
        else:
            tool = next(m for m in reversed(request["messages"]) if m["role"] == "tool")
            for evidence in ("[stderr]", "traceback line"):
                assert evidence in tool["content"]
            yield 'data: {"delta":"Failure evidence retained."}\n\n'
            yield "data: [DONE]\n\n"
            return
        yield "data: " + json.dumps({"type": "tool_calls", "calls": calls}) + "\n\n"
        yield "data: [DONE]\n\n"

    monkeypatch.setattr(loop, "execute_tool_block", execute)
    monkeypatch.setattr(loop, "stream_llm_with_fallback", stream)

    async def run():
        return [event async for event in loop.stream_agent_loop(
            "https://local.test/v1", "gpt-6-luna", [{"role": "user", "content": "Inspect the timed out run."}],
            owner="alice", session_id="chat-python-failure", relevant_tools={"python"},
            max_tokens=512, max_rounds=6, _is_teacher_run=True,
        )]

    asyncio.run(run())
    assert len(requests) == 6


@pytest.mark.parametrize("low_budget", [False, True])
def test_skill_view_keeps_procedure_middle_when_fits_and_archives_when_budget_low(monkeypatch, tmp_path, low_budget):
    import src.tool_result_store as store

    monkeypatch.setattr(store, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(loop, "get_setting", lambda key, default=None: (3000 if low_budget else default) if key == "agent_input_token_budget" else default)
    monkeypatch.setattr(loop, "get_mcp_manager", lambda: None)
    monkeypatch.setattr(loop, "blocked_tools_for_owner", lambda owner: set())
    monkeypatch.setattr(loop, "_agent_route_tool_mode", lambda *args, **kwargs: (True, False, False))
    monkeypatch.setattr(loop, "_build_system_prompt", lambda messages, *args, **kwargs: (list(messages), []))
    monkeypatch.setattr("src.model_context.budget_context_for_model", lambda *args, **kwargs: 20000)
    middle = "MIDDLE_PROCEDURE_STEP_MUST_SURVIVE"
    skill = "# Procedure\n" + ("opening guidance. " * 280) + middle + "\n" + ("closing guidance. " * 280)
    requests = []

    async def execute(block, **kwargs):
        return "view", {"results": skill}

    async def stream(candidates, messages, **kwargs):
        request = await kwargs["candidate_request_factory"](0, *candidates[0])
        requests.append(request["messages"])
        if len(requests) == 1:
            calls = [{"id": "skill", "name": "manage_skills", "arguments": '{"action":"view","name":"ui-design"}'}]
        else:
            tool = next(m for m in reversed(request["messages"]) if m["role"] == "tool")
            if low_budget:
                assert "stored as" in tool["content"]
                assert middle not in tool["content"]
                assert tool["metadata"]["trusted"] is False
            else:
                assert middle in tool["content"]
                assert "stored as" not in tool["content"]
                assert tool["metadata"]["trusted"] is False
            yield 'data: {"delta":"Procedure received."}\n\n'
            yield "data: [DONE]\n\n"
            return
        yield "data: " + json.dumps({"type": "tool_calls", "calls": calls}) + "\n\n"
        yield "data: [DONE]\n\n"

    monkeypatch.setattr(loop, "execute_tool_block", execute)
    monkeypatch.setattr(loop, "stream_llm_with_fallback", stream)

    async def run():
        return [event async for event in loop.stream_agent_loop(
            "https://local.test/v1", "gpt-6-luna", [{"role": "user", "content": "Read the UI design procedure."}],
            owner="alice", session_id=f"chat-skill-{low_budget}", relevant_tools={"manage_skills"},
            max_tokens=512, max_rounds=2, _is_teacher_run=True,
        )]

    asyncio.run(run())
    assert len(requests) == 2


def test_same_round_tool_results_share_remaining_archive_budget(monkeypatch, tmp_path):
    import src.tool_result_store as store

    monkeypatch.setattr(store, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(
        loop, "get_setting",
        lambda key, default=None: 1400 if key == "agent_input_token_budget" else default,
    )
    monkeypatch.setattr(loop, "get_mcp_manager", lambda: None)
    monkeypatch.setattr(loop, "blocked_tools_for_owner", lambda owner: set())
    monkeypatch.setattr(loop, "_agent_route_tool_mode", lambda *args, **kwargs: (True, False, False))
    monkeypatch.setattr(loop, "_build_system_prompt", lambda messages, *args, **kwargs: (list(messages), []))
    monkeypatch.setattr("src.model_context.budget_context_for_model", lambda *args, **kwargs: 20000)
    padding = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau "
    # Each result remains below the legacy 6k-character archive threshold and
    # individually fits the input budget; the pair does not.
    first = padding * 30 + "FIRST_DETAIL" + padding * 2
    second = padding * 30 + "SECOND_DETAIL" + padding * 2
    requests = []

    async def execute(block, **kwargs):
        if block.tool_type == "context_search":
            return "search", await ContextSearchTool().execute(block.content, kwargs)
        path = block.content
        return "read", {"output": first if path.endswith("first.txt") else second, "exit_code": 0}

    async def stream(candidates, messages, **kwargs):
        request = await kwargs["candidate_request_factory"](0, *candidates[0])
        names = {item["function"]["name"] for item in request["kwargs"]["tools"]}
        requests.append(request["messages"])
        if len(requests) == 1:
            yield "data: " + json.dumps({"type": "tool_calls", "calls": [
                {"id": "first", "name": "read_file", "arguments": '{"path":"first.txt"}'},
                {"id": "second", "name": "read_file", "arguments": '{"path":"second.txt"}'},
            ]}) + "\n\n"
        elif len(requests) == 2:
            results = [m for m in request["messages"] if m["role"] == "tool"][-2:]
            assert "FIRST_DETAIL" in results[0]["content"]
            assert "stored as" in results[1]["content"]
            assert "context_search" in names
            result_id = re.search(r"stored as ([\w-]+)", results[1]["content"]).group(1)
            yield "data: " + json.dumps({"type": "tool_calls", "calls": [{
                "id": "retrieve", "name": "context_search",
                "arguments": json.dumps({"query": "SECOND_DETAIL", "result_id": result_id}),
            }]}) + "\n\n"
        else:
            assert "SECOND_DETAIL" in next(m for m in reversed(request["messages"]) if m["role"] == "tool")["content"]
            yield 'data: {"delta":"Recovered both details."}\n\n'
        yield "data: [DONE]\n\n"

    monkeypatch.setattr(loop, "execute_tool_block", execute)
    monkeypatch.setattr(loop, "stream_llm_with_fallback", stream)

    async def run():
        return [event async for event in loop.stream_agent_loop(
            "https://local.test/v1", "gpt-6-luna", [{"role": "user", "content": "Find both details."}],
            owner="alice", session_id="chat-multi-results", relevant_tools={"read_file"},
            max_tokens=512, max_rounds=3, _is_teacher_run=True,
        )]

    events = asyncio.run(run())
    assert len(requests) == 3, [event[:1000] for event in events[-5:]]
    assert any("Recovered both details." in event for event in events)


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
