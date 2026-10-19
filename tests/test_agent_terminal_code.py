"""An illustrative code fence is an answer, not a second tool invocation."""
import json

import src.agent_loop as loop
from tests.runtime_evidence_helpers import authoritative_executor
from test_agent_rounds_exhausted import _collect, _patch_common, _types


def test_native_tool_answer_keeps_python_example_in_terminal_metrics(monkeypatch, tmp_path):
    _patch_common(monkeypatch)
    monkeypatch.setattr(loop, "blocked_tools_for_owner", lambda owner: set())
    monkeypatch.setattr(loop, "_is_qwen38_tool_router", lambda model: True)
    monkeypatch.setattr(loop, "_configured_model_tool_surface", lambda *args, **kwargs: "full")
    answer = "The source defines:\n\n```python\nRAM_GUARD_CAN_DISABLE = True\n```"
    executed = []

    @authoritative_executor
    async def execute(block, **kwargs):
        executed.append(block.tool_type)
        return "read_file", {"output": "RAM_GUARD_CAN_DISABLE = True", "exit_code": 0}

    async def stream(candidates, messages, **kwargs):
        request = await kwargs["candidate_request_factory"](0, *candidates[0])
        if not executed:
            assert any(s.get("function", {}).get("name") == "read_file"
                       for s in request["kwargs"].get("tools", []))
            event = {"type": "tool_calls", "calls": [{"id": "read-source",
                     "name": "read_file", "arguments": json.dumps({"path": "manager.py"})}]}
        else:
            event = {"delta": answer}
        yield "data: " + json.dumps(event) + "\n\n"
        yield "data: [DONE]\n\n"

    monkeypatch.setattr(loop, "execute_tool_block", execute)
    monkeypatch.setattr(loop, "stream_llm_with_fallback", stream)
    events = _types(_collect(loop.stream_agent_loop(
        "http://x/v1", "gpt-4o", [{"role": "user", "content": "Read manager.py and quote the constant."}],
        workspace=str(tmp_path), relevant_tools={"read_file"}, max_rounds=3,
    )))
    assert executed == ["read_file"]
    metrics = next(e["data"] for e in events if e.get("type") == "metrics")
    assert answer in metrics["round_texts"]
