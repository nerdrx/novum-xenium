"""Incomplete tool arguments must not silently finish or partially execute."""
import json

import src.agent_loop as al
from test_agent_rounds_exhausted import _patch_common, _collect, _types


def _run(monkeypatch, recover):
    _patch_common(monkeypatch)
    executed = []
    requests = []

    async def execute(block, **kwargs):
        executed.append(block.tool_type)
        return block.tool_type, {"output": "saved", "exit_code": 0}

    async def stream(candidates, messages, **kwargs):
        requests.append(list(messages))
        if recover and len(requests) > 1:
            yield 'data: {"delta":"Recovered."}\n\n'
        else:
            yield 'data: ' + json.dumps({"type": "tool_calls", "calls": [
                {"id": "good", "name": "update_plan", "arguments": '{"plan":"work"}'},
                {"id": "bad", "name": "write_file", "arguments": '{"path":"style.css","content":"body {'},
            ]}) + '\n\n'
        yield 'data: [DONE]\n\n'

    monkeypatch.setattr(al, 'execute_tool_block', execute)
    monkeypatch.setattr(al, 'stream_llm_with_fallback', stream)
    events = _types(_collect(al.stream_agent_loop(
        'http://x/v1', 'm', [{'role': 'user', 'content': 'Write the app.'}],
        relevant_tools={'write_file', 'update_plan'}, max_rounds=6,
    )))
    return events, requests, executed


def test_invalid_batch_retries_without_executing_valid_siblings(monkeypatch):
    events, requests, executed = _run(monkeypatch, True)
    assert len(requests) == 2
    assert executed == []
    assert any('NONE of that batch was executed' in m.get('content', '') for m in requests[1])
    assert any(e.get('delta') == 'Recovered.' for e in events)


def test_invalid_calls_stop_with_explanation_after_two_retries(monkeypatch):
    events, requests, executed = _run(monkeypatch, False)
    assert len(requests) == 3
    assert executed == []
    assert any('Stopped because the model' in e.get('delta', '') for e in events)
