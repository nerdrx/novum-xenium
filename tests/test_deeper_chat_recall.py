"""Exact transcript reads stay bounded, scoped and untrusted through agent rounds."""
import asyncio
import json
from datetime import datetime

import pytest
import src.agent_loop as loop
import src.session_search as transcripts
from src.tools.search import do_search_chats
from src.tool_parsing import ToolBlock, parse_tool_blocks
from src.tool_schemas import function_call_to_tool_block
from src.tool_capabilities import ToolRunSecurityContext
from test_session_search import _db, _add_session, _add_message


@pytest.fixture
def saved_chat(monkeypatch):
    db = _db()
    body = "project milestone\n" + "a" * 4100 + "\nEXACT_DETAIL_AFTER_EXCERPT\nsecond line 🐾"
    _add_session(db, "past-chat", owner="alice", name="Project [notes]")
    _add_message(db, "past-chat", "saved-message", "assistant", body, datetime(2026, 10, 7))
    db.commit()
    # Use production queries with a real database, without touching personal data.
    monkeypatch.setattr(transcripts, "SessionLocal", lambda: db)
    yield body
    db.close()


@pytest.mark.asyncio
async def test_native_and_text_calls_open_exact_pages(saved_chat, monkeypatch):
    import src.tool_execution as execution
    from src.tool_execution import execute_tool_block
    # Interactive admin permission is separate from the database owner scope.
    monkeypatch.setattr(execution, "_owner_is_admin", lambda owner: True)
    hit = function_call_to_tool_block("search_chats", '{"query":"project milestone"}')
    _, found = await execute_tool_block(hit, owner="alice", security_context=ToolRunSecurityContext())
    assert "saved-message" in found["results"]
    assert "EXACT_DETAIL_AFTER_EXCERPT" not in found["results"]
    args = {"message_id": "saved-message", "offset": 4000}
    text = '<tool_call>' + json.dumps({"name": "search_chats", "arguments": args}) + '</tool_call>'
    block = parse_tool_blocks(text)[0]
    assert json.loads(block.content) == args
    _, page = await execute_tool_block(ToolBlock("search_chats", json.dumps(args, indent=2)), owner="alice", security_context=ToolRunSecurityContext())
    assert page["results"].endswith(saved_chat[4000:])
    assert "#session-past-chat" in page["results"]
    assert "End of saved message" in page["results"]
    assert page["untrusted_content"] is True
    _, denied = await execute_tool_block(block, owner="bob", security_context=ToolRunSecurityContext())
    assert "not found" in denied["results"]
    assert "EXACT_DETAIL" not in denied["results"]
    _, disabled = await execute_tool_block(block, owner="alice", disabled_tools={"search_chats"}, security_context=ToolRunSecurityContext())
    assert disabled["exit_code"] == 1


def test_exact_reads_keep_existing_approval_and_delegated_gates():
    args = '{"message_id":"saved-message"}'
    assert ToolRunSecurityContext().decision_for("search_chats", args).allowed
    assert not ToolRunSecurityContext(external_untrusted_context_seen=True).decision_for("search_chats", args).allowed
    assert not ToolRunSecurityContext(delegated_credential=True, approval_mode="full").decision_for("search_chats", args).allowed


@pytest.mark.asyncio
@pytest.mark.parametrize("args", [
    {}, {"query": "x", "message_id": "saved-message"},
    {"message_id": "saved-message", "owner": "alice"},
    {"message_id": "saved-message", "session_id": "past-chat"},
    {"message_id": "saved-message", "offset": -1},
    {"message_id": "saved-message", "offset": True},
    {"message_id": "saved-message", "offset": "4000"},
    {"message_id": 3}, {"message_id": "x" * 129},
    {"query": "x", "offset": 2},
])
async def test_invalid_native_arguments_fail_closed(args, saved_chat):
    block = function_call_to_tool_block("search_chats", json.dumps(args))
    result = await do_search_chats(block.content, owner="bob")
    assert result["exit_code"] == 1
    assert "EXACT_DETAIL" not in str(result)


def test_search_open_continue_in_real_agent_loop(saved_chat, monkeypatch, tmp_path):
    import src.tool_result_store as store
    monkeypatch.setattr(store, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(loop, "get_setting", lambda key, default=None: default)
    monkeypatch.setattr(loop, "get_mcp_manager", lambda: None)
    monkeypatch.setattr(loop, "blocked_tools_for_owner", lambda owner: set())
    monkeypatch.setattr(loop, "_agent_route_tool_mode", lambda *a, **k: (True, False, False))
    monkeypatch.setattr(loop, "_build_system_prompt", lambda messages, *a, **k: (list(messages), []))
    requests = []

    async def execute(block, **kwargs):
        assert kwargs["owner"] == "alice"
        return "chat recall", await do_search_chats(block.content, owner=kwargs["owner"])

    async def stream(candidates, messages, **kwargs):
        request = await kwargs["candidate_request_factory"](0, *candidates[0])
        shaped = request["messages"]
        requests.append(shaped)
        assert any(m["role"] == "user" and "Find our project milestone" in m["content"] for m in shaped)
        schema = next(s["function"] for s in request["kwargs"]["tools"] if s["function"]["name"] == "search_chats")
        assert "message_id" in schema["parameters"]["properties"]
        if len(requests) > 1:
            result = next(m for m in reversed(shaped) if m["role"] == "tool")
            assert result["metadata"]["trusted"] is False
            if len(requests) == 2:
                assert "saved-message" in result["content"]
                assert "EXACT_DETAIL_AFTER_EXCERPT" not in result["content"]
            if len(requests) == 3:
                assert '"offset": 4000' in result["content"]
            if len(requests) == 4:
                assert "EXACT_DETAIL_AFTER_EXCERPT" in result["content"]
                yield 'data: {"delta":"Found the saved detail."}\n\n'
                yield "data: [DONE]\n\n"
                return
        args = [{"query": "project milestone"}, {"message_id": "saved-message"},
                {"message_id": "saved-message", "offset": 4000}][len(requests) - 1]
        calls = [{"id": f"recall-{len(requests)}", "name": "search_chats", "arguments": json.dumps(args)}]
        yield "data: " + json.dumps({"type": "tool_calls", "calls": calls}) + "\n\n"
        yield "data: [DONE]\n\n"

    monkeypatch.setattr(loop, "execute_tool_block", execute)
    monkeypatch.setattr(loop, "stream_llm_with_fallback", stream)

    async def run():
        return [event async for event in loop.stream_agent_loop(
            "https://local.test/v1", "qwen3-test", [{"role": "user", "content": "Find our project milestone."}],
            owner="alice", session_id="current-chat", relevant_tools={"search_chats"},
            max_rounds=4, _is_teacher_run=True, approval_mode="full",
        )]

    events = asyncio.run(run())
    assert len(requests) == 4
    assert any("Found the saved detail" in event for event in events)
