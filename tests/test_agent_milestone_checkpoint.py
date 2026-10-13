import json
import pytest
import src.agent_loop as al
from src.agent_tools import coding_tools
from test_agent_rounds_exhausted import _collect, _patch_common, _types


@pytest.mark.parametrize("save_plan", [True, False])
def test_first_write_waits_for_successful_checkpoint(monkeypatch, tmp_path, save_plan):
    _patch_common(monkeypatch)
    monkeypatch.setattr(al, "blocked_tools_for_owner", lambda owner: set())
    monkeypatch.setattr(al, "get_setting", lambda key, default=None: False if key == "agent_coding_grounding" else default)
    monkeypatch.setattr(coding_tools, "read_todos", lambda ctx: [])
    requests, executed = [], []
    todos = [{"content": "Implement parser; check quoted CSV", "status": "in_progress"},
             {"content": "Verify CLI; run error cases", "status": "pending"}]
    async def execute(block, **kwargs):
        executed.append(block.tool_type)
        return block.tool_type, {"exit_code": 0, "output": "ok", **({"todos": todos} if block.tool_type == "todowrite" else {})}
    async def stream(candidates, messages, **kwargs):
        req = await kwargs["candidate_request_factory"](0, *candidates[0])
        names = {t["function"]["name"] for t in (req["kwargs"]["tools"] or [])}
        requests.append(names)
        if save_plan and len(requests) == 1:
            tool, args = "todowrite", {"todos": todos}
        elif save_plan and len(requests) > 2:
            yield 'data: {"delta":"Finished."}\n\n'
            yield 'data: [DONE]\n\n'
            return
        else:
            tool, args = "write_file", {"path": "parser.py", "content": "pass"}
        yield 'data: ' + json.dumps({"type": "tool_calls", "calls": [{"id": str(len(requests)), "name": tool, "arguments": json.dumps(args)}]}) + '\n\n'
        yield 'data: [DONE]\n\n'
    monkeypatch.setattr(al, "execute_tool_block", execute)
    monkeypatch.setattr(al, "stream_llm_with_fallback", stream)
    events = _types(_collect(al.stream_agent_loop(
        'http://x/v1', 'gpt-4o', [{"role": "user", "content": "Build a Python CLI tool and add tests"}],
        workspace=str(tmp_path), owner="alice", session_id="checkpoint-test",
        approval_mode="full", relevant_tools={"todowrite", "write_file"}, max_rounds=4,
    )))
    assert "todowrite" in requests[0] and "write_file" not in requests[0]
    if save_plan:
        assert executed == ["todowrite", "write_file"]
        assert "write_file" in requests[1]
    else:
        assert executed == []
        assert len(requests) == 2
        assert any("did not save an actionable task checklist" in e.get("delta", "") for e in events)
