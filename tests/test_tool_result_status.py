"""Keep returned tool errors consistent with persisted execution status."""
import asyncio

import pytest

from src.agent_runtime.authority import OperationGrant, RequestAuthority
from src.agent_tools import TOOL_HANDLERS, ToolBlock
from src.tool_capabilities import tool_result_is_successful
from src.tool_execution import NO_TOOL_SECURITY_CONTEXT, execute_tool_block


@pytest.mark.parametrize(
    ("result", "expected_exit_code"),
    [
        ({"error": "fixture failure"}, 1),
        ({"error": "fixture failure", "exit_code": 0}, 1),
        ({"error": "fixture failure", "exit_code": 7}, 7),
        ({"output": "fixture success", "exit_code": 0}, 0),
        ({"output": "fixture success"}, None),
        ({"error": "", "output": "empty error is not failure"}, None),
        ({"error": "fixture blocked", "blocked": True, "exit_code": 1}, 1),
        ({"error": "fixture approval", "approval_required": True, "exit_code": 1}, 1),
    ],
)
def test_registry_result_status_matches_tool_error(monkeypatch, result, expected_exit_code):
    async def handler(_content, _ctx):
        return dict(result)

    monkeypatch.setitem(TOOL_HANDLERS, "synthetic_status_probe", handler)
    authority = RequestAuthority(
        "status-probe", "fixture-owner", "fixture-session", "",
        grants=(OperationGrant("synthetic_status_probe"),),
    )
    description, actual = asyncio.run(execute_tool_block(
        ToolBlock("synthetic_status_probe", "{}"),
        owner="fixture-owner",
        session_id="fixture-session",
        security_context=NO_TOOL_SECURITY_CONTEXT,
        request_authority=authority,
    ))

    assert description.startswith("registry: synthetic_status_probe")
    assert actual.get("exit_code") == expected_exit_code
    assert actual.get("error") == result.get("error")
    if not result.get("error"):
        assert tool_result_is_successful(actual)


def test_request_authority_block_remains_failed_without_dispatch():
    description, result = asyncio.run(execute_tool_block(
        ToolBlock("synthetic_ungranted_probe", "{}"),
        owner="fixture-owner",
        session_id="fixture-session",
        security_context=NO_TOOL_SECURITY_CONTEXT,
        request_authority=RequestAuthority.empty(
            owner="fixture-owner", session_id="fixture-session", workspace=""),
    ))

    assert description.endswith(": BLOCKED")
    assert result["blocked"] is True
    assert result["exit_code"] == 1
