"""Automatic working notes survive route rebuilds without becoming instructions."""
import json
import pytest
import src.agent_loop as al
from src.agent_tools import coding_tools
from test_agent_rounds_exhausted import _patch_common, _collect


def test_milestones_survive_trim_as_untrusted_data():
    from src.context_compactor import trim_for_context
    todos = [{"content": "convert file; check playable output", "status": "in_progress"}]
    messages = al._attach_milestones([
        {"role": "system", "content": "Follow permissions."},
        {"role": "assistant", "content": "old history " * 4000},
        {"role": "user", "content": "Continue conversion."},
    ], todos)
    trimmed = trim_for_context(messages, 1000, reserve_tokens=100)
    note = next(m for m in trimmed if m.get("metadata", {}).get("source") == "saved task milestones")
    assert note["role"] == "user"
    assert note["metadata"]["trusted"] is False
    assert json.dumps(todos) in note["content"]
    assert not any(m.get("metadata", {}).get("source") == "saved task milestones"
                   for m in al._strip_agent_injected_messages(messages))


@pytest.mark.parametrize("mode", ["normal", "incognito", "plan", "approved"])
def test_route_restores_current_list_and_respects_modes(monkeypatch, mode):
    _patch_common(monkeypatch)
    monkeypatch.setattr(al, "blocked_tools_for_owner", lambda owner: set())
    reads, requests = [], []
    def read(ctx):
        reads.append(ctx)
        return [{"content": "milestone version " + str(len(reads)), "status": "pending"}]
    monkeypatch.setattr(coding_tools, "read_todos", read)
    async def stream(candidates, messages, **kwargs):
        request = await kwargs["candidate_request_factory"](0, *candidates[0])
        requests.append(request["messages"])
        if len(requests) == 1:
            yield 'data: ' + json.dumps({"delta": '```update_plan\n{"plan":"working"}\n```'}) + '\n\n'
        else:
            yield 'data: {"delta":"Done."}\n\n'
        yield 'data: [DONE]\n\n'
    monkeypatch.setattr(al, "stream_llm_with_fallback", stream)
    _collect(al.stream_agent_loop(
        'http://x/v1', 'm', [{"role": "user", "content": "Build and test a converter"}],
        owner="alice", session_id="milestone-test", relevant_tools={"update_plan", "todowrite"},
        incognito=mode == "incognito", plan_mode=mode == "plan",
        approved_plan="- [ ] approved work" if mode == "approved" else None, max_rounds=2,
    ))
    if mode == "normal":
        assert len(reads) >= 2
        assert reads[0] == {"owner": "alice", "session_id": "milestone-test"}
        assert "milestone version 2" in str(requests[-1])
        assert "milestone version 1" not in str(requests[-1])
        assert any(al.AUTO_MILESTONE_DIRECTIVE in m.get("content", "") for m in requests[0])
    else:
        assert not reads


def test_default_coding_guidance_does_not_require_artificial_phase_milestones():
    directive = al.AUTO_MILESTONE_DIRECTIVE
    assert "default to one concrete change and a real test" in directive
    assert "within the same item, not separate milestones" in directive
    assert "distinct outcomes needing separate acceptance checks" in directive
    assert "For noncoding work" in directive
    assert "3-7" not in directive
    assert "existing permission rules still apply" in directive
