"""Ordinary repository review needs the same path facts as coding routes."""
import pytest
import src.agent_loop as loop
from test_agent_rounds_exhausted import _collect, _patch_common


@pytest.mark.parametrize("surface", ["local", "coding", "web", "disabled", "external"])
@pytest.mark.parametrize("truncate_reference", [False, True])
def test_review_workspace_context_follows_offered_local_tools(monkeypatch, surface, tmp_path, truncate_reference):
    _patch_common(monkeypatch)
    if truncate_reference:
        import src.context_compactor as compactor
        monkeypatch.setattr(compactor, "trim_for_context", lambda messages, *args, **kwargs: [
            {**message, "content": message["content"][:40]}
            if message.get("_workspace_guidance") else message
            for message in messages
        ])
    monkeypatch.setattr(loop, "_use_coding_tools", lambda *args: surface == "coding")
    monkeypatch.setattr(loop, "blocked_tools_for_owner", lambda owner: set())
    from src.agent_tools import filesystem_tools
    scans = []

    def project_context(workspace):
        scans.append(workspace)
        return "Workspace directory: /workspace. Existing checkout: /workspace/project."

    monkeypatch.setattr(filesystem_tools, "workspace_project_context", project_context)
    captured = []

    async def stream(candidates, messages, **kwargs):
        factory = kwargs.get("candidate_request_factory")
        request = await factory(0, *candidates[0]) if factory else {"messages": messages, "kwargs": kwargs}
        captured.append(request)
        yield 'data: {"delta":"Review complete."}\n\n'
        yield "data: [DONE]\n\n"

    monkeypatch.setattr(loop, "stream_llm_with_fallback", stream)
    external = [{"type": "function", "function": {
        "name": "read_file", "description": "Read from an external host",
        "parameters": {"type": "object", "properties": {"path": {"type": "string"}}},
    }}] if surface == "external" else None
    _collect(loop.stream_agent_loop(
        "http://local.test/v1", "gpt-4o",
        [{"role": "user", "content": (
            "Summarize https://example.com/project using the public page."
            if surface == "web" else
            "Fix the parser in this workspace."
            if surface == "coding" else
            "Read README.md and explain the local source without changing anything."
        )}],
        approval_mode="full", max_rounds=1,
        workspace=str(tmp_path),
        relevant_tools={"web_fetch"} if surface == "web" else {"read_file"},
        disabled_tools={"bash", "python", "read_file", "write_file", "edit_file",
                        "ls", "glob", "grep", "get_workspace"} if surface == "disabled" else set(),
        external_tool_schemas=external,
    ))
    assert captured
    messages = captured[0]["messages"]
    guidance = [m for m in messages if m.get("_workspace_guidance")]
    if surface in {"local", "coding"}:
        assert scans, captured[0].get("kwargs", {}).get("tools")
        assert len(guidance) == 1
        assert "/workspace/project" in guidance[0]["content"]
        assert guidance[0]["role"] == "user"
        assert guidance[0]["metadata"]["trusted"] is False
        assert guidance[0]["metadata"]["tool_gate_untrusted"] is False
        assert sum(bool(m.get("_workspace_path_rule")) for m in messages) == (
            0 if surface == "coding" else 1
        )
        coding_guidance = [m for m in messages if m.get("_coding_guidance")]
        assert bool(coding_guidance) is (surface == "coding")
        if coding_guidance:
            assert "/workspace/project" not in coding_guidance[0]["content"]
        review_prompt = (
            "Fix the parser in this workspace."
            if surface == "coding" else
            "Read README.md and explain the local source without changing anything."
        )
        review_prompt_index = next(
            index for index, message in enumerate(messages)
            if message.get("role") == "user"
            and message.get("content") == review_prompt
        )
        assert messages.index(guidance[0]) < review_prompt_index
    else:
        assert not scans
        assert not guidance
