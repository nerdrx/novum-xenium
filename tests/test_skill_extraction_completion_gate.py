import pytest

from routes.chat_helpers import skill_extraction_allowed


@pytest.mark.parametrize("event_type", [
    "ask_user", "agent_terminal", "budget_exceeded", "error",
    "intent_nudge_exhausted", "loop_breaker_triggered", "rounds_exhausted",
])
def test_incomplete_agent_runs_do_not_learn_skills(event_type):
    assert not skill_extraction_allowed(
        [{"type": event_type}], requested_agent=True,
        approval_continuation=False, workspace="/workspace",
    )


@pytest.mark.parametrize("workspace", ["/workspace", None, ""])
def test_coding_run_needs_a_passed_verification(workspace):
    events = [{"type": "tool_start", "tool": "write_file"}]
    assert not skill_extraction_allowed(
        events, requested_agent=True, approval_continuation=False,
        workspace=workspace,
    )
    assert skill_extraction_allowed(
        events + [{"type": "verification", "passed": True}],
        requested_agent=True, approval_continuation=False,
        workspace=workspace,
    )


def test_recovered_tool_error_does_not_block_later_verification():
    events = [
        {"type": "tool_start", "tool": "bash"},
        {"type": "tool_output", "error": "first attempt failed"},
        {"type": "verification", "passed": True},
    ]
    assert skill_extraction_allowed(
        events, requested_agent=True, approval_continuation=False,
        workspace="/workspace",
    )


def test_non_coding_completed_agent_run_can_learn():
    assert skill_extraction_allowed(
        [{"type": "tool_start", "tool": "web_search"}],
        requested_agent=True, approval_continuation=False,
        workspace="/workspace",
    )


def test_agent_mode_and_approval_continuation_remain_required():
    assert not skill_extraction_allowed(
        [], requested_agent=False, approval_continuation=False, workspace="",
    )
    assert not skill_extraction_allowed(
        [], requested_agent=True, approval_continuation=True, workspace="",
    )
