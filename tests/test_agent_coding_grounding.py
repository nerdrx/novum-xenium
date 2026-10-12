"""Loop integration for research-first coding turns."""
import json

import src.agent_loop as al
from test_agent_rounds_exhausted import _collect, _patch_common, _types


def _call(name, args, call_id):
    return "data: " + json.dumps({"type": "tool_calls", "calls": [{
        "id": call_id, "name": name, "arguments": json.dumps(args),
    }]}) + "\n\n"


def _schemas(kwargs):
    return {
        schema.get("function", {}).get("name")
        for schema in (kwargs.get("tools") or [])
    }


def _run(monkeypatch, tmp_path, task_text, replies, tool_results, *, disabled_tools=None):
    _patch_common(monkeypatch)
    monkeypatch.setattr(al, "blocked_tools_for_owner", lambda _owner: set())
    monkeypatch.setenv("ODYSSEUS_RUN_CHECKPOINTS_DB", str(tmp_path / "runs.db"))
    requests, histories, executed = [], [], []

    async def stream(_candidates, _messages, **kwargs):
        factory = kwargs.get("candidate_request_factory")
        if factory:
            request = await factory(0, *_candidates[0])
            requests.append(_schemas(request.get("kwargs", {})))
            histories.append(list(request.get("messages") or []))
        else:
            requests.append(_schemas(kwargs))
            histories.append(list(_messages))
        reply = replies[len(requests) - 1]
        yield reply
        yield "data: [DONE]\n\n"

    async def execute(block, *args, **kwargs):
        executed.append(block.tool_type)
        return block.tool_type, tool_results[block.tool_type].pop(0)

    monkeypatch.setattr(al, "stream_llm_with_fallback", stream)
    monkeypatch.setattr(al, "execute_tool_block", execute)
    events = _types(_collect(al.stream_agent_loop(
        "http://x/v1", "gpt-4o", [{"role": "user", "content": task_text}],
        workspace="/workspace", approval_mode="full", max_rounds=len(replies) + 1,
        disabled_tools=disabled_tools or set(),
    )))
    return events, requests, histories, executed


def test_fetching_task_docs_opens_coding_tools(monkeypatch, tmp_path):
    url = "https://vendor.example/docs/api"
    events, requests, histories, executed = _run(
        monkeypatch,
        tmp_path,
        f"Build a GUI app using this framework; follow {url}.",
        [_call("web_fetch", {"url": url}, "fetch"),
         _call("write_file", {"path": "app.py", "content": "print('ok')"}, "write"),
         'data: {"delta":"Implemented and checked."}\n\n'],
        {"web_fetch": [{"output": "Official API documentation", "exit_code": 0}],
         "write_file": [{"output": "saved", "exit_code": 0}]},
    )
    assert "web_fetch" in requests[0]
    assert not ({"bash", "write_file"} & requests[0])
    assert {"bash", "write_file"} <= requests[1]
    assert executed == ["web_fetch", "write_file"]
    assert all(sum(bool(message.get("_coding_guidance")) for message in history) == 1
               for history in histories)
    assert any(event.get("type") == "coding_research"
               and event.get("status") == "sources_read" for event in events)


def test_hidden_write_before_fetch_is_blocked_without_execution(monkeypatch, tmp_path):
    url = "https://vendor.example/docs/api"
    events, requests, histories, executed = _run(
        monkeypatch,
        tmp_path,
        f"Build a GUI app using this framework; follow {url}.",
        [_call("write_file", {"path": "app.py", "content": "bad"}, "early-write"),
         _call("web_fetch", {"url": url}, "fetch"),
         'data: {"delta":"Ready."}\n\n'],
        {"web_fetch": [{"output": "Official API documentation", "exit_code": 0}]},
    )
    assert not ({"bash", "write_file"} & requests[0])
    assert executed == ["web_fetch"]
    assert any("RESEARCH FIRST" in json.dumps(history) for history in histories)


def test_two_failed_lookups_open_bounded_escape(monkeypatch, tmp_path):
    url = "https://vendor.example/docs/api"
    events, requests, _, executed = _run(
        monkeypatch,
        tmp_path,
        f"Build a GUI app using this framework; follow {url}.",
        [_call("web_fetch", {"url": url}, "fetch-1"),
         _call("web_fetch", {"url": url}, "fetch-2"),
         _call("write_file", {"path": "app.py", "content": "small experiment"}, "write"),
         'data: {"delta":"Finished with unavailable docs noted."}\n\n'],
        {"web_fetch": [
             {"error": "timeout", "exit_code": 1},
             {"error": "not found", "exit_code": 1},
         ], "write_file": [{"output": "saved", "exit_code": 0}]},
    )
    assert not ({"bash", "write_file"} & requests[0])
    assert not ({"bash", "write_file"} & requests[1])
    assert "write_file" in requests[2]
    assert executed == ["web_fetch", "web_fetch", "write_file"]
    assert any(event.get("type") == "coding_research"
               and event.get("status") == "sources_unavailable" for event in events)


def test_explicit_no_web_hides_search_and_fetch_during_research(monkeypatch, tmp_path):
    events, requests, _, executed = _run(
        monkeypatch,
        tmp_path,
        "Build a GUI app using the framework in this repo; do not use the web or internet.",
        [_call("read_file", {"path": "README.md"}, "read"),
         _call("write_file", {"path": "app.py", "content": "local"}, "write"),
         'data: {"delta":"Done."}\n\n'],
        {"read_file": [{"output": "Local framework documentation", "exit_code": 0}],
         "write_file": [{"output": "saved", "exit_code": 0}]},
    )
    assert not ({"web_search", "web_fetch", "bash", "write_file"} & requests[0])
    assert not any({"web_search", "web_fetch"} & schema for schema in requests)
    assert executed == ["read_file", "write_file"]
    assert any(event.get("type") == "coding_research"
               and event.get("status") == "sources_read" for event in events)
