"""Image capability must survive tool retrieval and reach native API rounds."""
import asyncio
import json
from unittest.mock import MagicMock

import pytest
import src.agent_loop as al


@pytest.mark.parametrize("enabled,connected,disabled,plan_mode,expected", [
    (True, True, set(), False, True),
    (False, True, set(), False, False),
    (True, False, set(), False, False),
    (True, True, {"generate_image"}, False, False),
    (True, True, set(), True, False),
])
def test_retry_round_receives_real_image_schema(monkeypatch, enabled, connected, disabled, plan_mode, expected):
    manager = MagicMock()
    manager.get_server_status.return_value = {"status": "connected" if connected else "disconnected"}
    manager.get_all_openai_schemas.return_value = []  # builtin MCP servers export no native schemas
    manager.get_tool_descriptions_for_prompt.return_value = ""
    manager.plan_mode_blocked_mcp.return_value = ({"image_gen": {"generate_image"}}, {"mcp__image_gen__generate_image"})
    monkeypatch.setattr(al, "get_mcp_manager", lambda: manager)
    monkeypatch.setattr(al, "get_setting", lambda key, default=None: enabled if key == "image_gen_enabled" else default)
    monkeypatch.setattr(al, "_load_mcp_disabled_map", lambda: {})
    monkeypatch.setattr(al, "blocked_tools_for_owner", lambda owner: set())
    captured = []

    async def stream(_candidates, messages, **kwargs):
        captured.append(kwargs.get("tools") or [])
        yield 'data: {"delta":"Finished."}\n\n'
        yield 'data: [DONE]\n\n'

    monkeypatch.setattr(al, "stream_llm_with_fallback", stream)

    async def run():
        return [event async for event in al.stream_agent_loop(
            "https://api.openai.com/v1/chat/completions", "gpt-6-luna",
            [{"role": "user", "content": "Generate a chicken image"},
             {"role": "assistant", "content": "The image attempt failed."},
             {"role": "user", "content": "try again"}],
            relevant_tools={"ask_user"},  # simulate retrieval omitting the image tool
            disabled_tools=disabled, plan_mode=plan_mode,
            context_length=16384, max_rounds=1, owner="admin",
        )]

    asyncio.run(run())
    assert captured
    image_schemas = [s for s in captured[0] if s["function"]["name"] == "generate_image"]
    assert bool(image_schemas) is expected
    if expected:
        assert image_schemas[0]["function"]["parameters"]["required"] == ["prompt"]
