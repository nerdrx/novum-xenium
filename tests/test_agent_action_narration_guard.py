"""Stop coding turns that stream action promises without making progress."""
import asyncio
import json

import src.agent_loop as al
from tests.test_agent_rounds_exhausted import _collect, _patch_common, _types


def _promises(count=14):
    return "\n\n".join(
        f"Now let me inspect file {i} and make the change. "
        + "I will write the server now. " * 10
        for i in range(count)
    )


def test_detector_is_narrow_to_long_unfenced_action_narration():
    assert al._looks_like_repeated_action_narration(_promises())
    assert not al._looks_like_repeated_action_narration(_promises()[:1000])
    assert not al._looks_like_repeated_action_narration("```python\n" + _promises(40))
    assert not al._looks_like_repeated_action_narration("\n\n".join(f"Step {i}: inspect." for i in range(20)))


def test_coding_narration_retries_once_then_fails_without_execution(monkeypatch):
    _patch_common(monkeypatch)
    monkeypatch.setattr(al, "blocked_tools_for_owner", lambda _owner: set(), raising=False)
    requests = []
    opened = []
    executed = []

    async def stream(candidates, messages, **kwargs):
        requests.append((list(candidates), list(messages)))
        opened.append(True)
        try:
            yield f'data: {json.dumps({"delta": _promises()})}\n\n'
            yield "data: [DONE]\n\n"
        finally:
            opened[-1] = False

    async def execute(block, *args, **kwargs):
        executed.append(block)
        return block.tool_type, {"output": "unexpected", "exit_code": 0}

    monkeypatch.setattr(al, "stream_llm_with_fallback", stream, raising=False)
    monkeypatch.setattr(al, "execute_tool_block", execute, raising=False)
    messages = [
        {"role": "assistant", "content": "Earlier verified work is preserved."},
        {"role": "user", "content": "Implement the GUI in src/server.py."},
    ]
    events = _types(_collect(al.stream_agent_loop(
        "http://x/v1", "qwen3.5:9b", messages,
        relevant_tools={"bash"}, workspace="/workspace", max_rounds=3,
    )))

    assert len(requests) == 2
    assert requests[1][0] == requests[0][0]
    assert any("Earlier verified work is preserved." in m.get("content", "") for m in requests[1][1])
    assert any("Read the existing relevant file first" in m.get("content", "") for m in requests[1][1])
    assert not any("Now let me inspect file" in m.get("content", "") for m in requests[1][1])
    assert opened == [False, False]
    assert executed == []
    terminal = next(e for e in events if e.get("type") == "agent_terminal")
    assert terminal["data"]["failed"] is True
    assert all("Now let me inspect" not in text for text in terminal["data"]["round_texts"])


def test_actual_native_tool_call_disables_narration_guard(monkeypatch):
    _patch_common(monkeypatch)
    monkeypatch.setattr(al, "blocked_tools_for_owner", lambda _owner: set(), raising=False)
    calls = []
    round_num = 0

    async def stream(_candidates, messages, **kwargs):
        nonlocal round_num
        round_num += 1
        if round_num == 1:
            yield 'data: ' + json.dumps({"type": "tool_calls", "calls": [
                {"id": "read-1", "name": "read_file", "arguments": json.dumps({"path": "src/server.py"})},
            ]}) + '\n\n'
            yield f'data: {json.dumps({"delta": _promises()})}\n\n'
        else:
            yield 'data: {"delta":"The file check is complete."}\n\n'
        yield "data: [DONE]\n\n"

    async def execute(block, *args, **kwargs):
        calls.append(block.tool_type)
        return block.tool_type, {"output": "file exists", "exit_code": 0}

    monkeypatch.setattr(al, "stream_llm_with_fallback", stream, raising=False)
    monkeypatch.setattr(al, "execute_tool_block", execute, raising=False)
    events = _types(_collect(al.stream_agent_loop(
        "http://x/v1", "gpt-6.1-sol",
        [{"role": "user", "content": "Implement the GUI in src/server.py."}],
        relevant_tools={"read_file"}, workspace="/workspace", max_rounds=4,
    )))

    assert calls == ["read_file"]
    assert not any(e.get("type") == "agent_terminal" for e in events)
    assert not any("Retrying once with the same model" in e.get("delta", "") for e in events)


def test_narration_failure_on_last_round_does_not_extend_round_cap(monkeypatch):
    _patch_common(monkeypatch)
    monkeypatch.setattr(al, "blocked_tools_for_owner", lambda _owner: set(), raising=False)
    requests = []

    async def stream(candidates, messages, **kwargs):
        requests.append(list(candidates))
        yield f'data: {json.dumps({"delta": _promises()})}\n\n'
        yield "data: [DONE]\n\n"

    monkeypatch.setattr(al, "stream_llm_with_fallback", stream, raising=False)
    events = _types(_collect(al.stream_agent_loop(
        "http://x/v1", "qwen3.5:9b",
        [{"role": "user", "content": "Implement the GUI in src/server.py."}],
        relevant_tools={"bash"}, workspace="/workspace", max_rounds=1,
    )))

    assert len(requests) == 1
    assert any(e.get("type") == "agent_terminal" for e in events)
    assert not any(e.get("type") == "rounds_exhausted" for e in events)
