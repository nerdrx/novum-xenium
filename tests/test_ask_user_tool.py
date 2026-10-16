"""`ask_user` — the agent poses a multiple-choice question to the user.

The tool is a pure UI-control marker: it does no I/O. `execute_tool_block`
returns an `ask_user` payload that the agent loop turns into an `ask_user` SSE
event and then ends the turn so the chat waits for the user's selection.
"""
import asyncio
import json

from src.agent_tools import ToolBlock, TOOL_TAGS  # noqa: E402  (import first to avoid circular)
from src.tool_execution import NO_TOOL_SECURITY_CONTEXT, execute_tool_block
from src.tool_index import ALWAYS_AVAILABLE, BUILTIN_TOOL_DESCRIPTIONS
from src.tool_security import is_public_blocked_tool
from tests.runtime_evidence_helpers import server_authorized_executor

execute_tool_block = server_authorized_executor(execute_tool_block)


def _run(content):
    return asyncio.run(execute_tool_block(
        ToolBlock("ask_user", content),
        security_context=NO_TOOL_SECURITY_CONTEXT,
    ))


def test_valid_question_returns_ask_user_payload():
    content = json.dumps({
        "question": "Which database should I use?",
        "options": [
            {"label": "PostgreSQL", "description": "Relational, ACID"},
            {"label": "SQLite", "description": "Zero-config, file-based"},
        ],
    })
    desc, result = _run(content)
    assert result.get("exit_code") == 0
    assert "error" not in result
    payload = result["ask_user"]
    assert payload["question"] == "Which database should I use?"
    assert [o["label"] for o in payload["options"]] == ["PostgreSQL", "SQLite"]
    assert payload["options"][0]["description"] == "Relational, ACID"
    assert payload["multi"] is False
    assert "PostgreSQL" in result["output"]


def test_multi_flag_is_carried():
    content = json.dumps({
        "question": "Which features?",
        "options": [{"label": "A"}, {"label": "B"}, {"label": "C"}],
        "multi": True,
    })
    _, result = _run(content)
    assert result["ask_user"]["multi"] is True
    assert len(result["ask_user"]["options"]) == 3


def test_string_options_are_accepted():
    content = json.dumps({"question": "Pick one", "options": ["Yes", "No"]})
    _, result = _run(content)
    labels = [o["label"] for o in result["ask_user"]["options"]]
    assert labels == ["Yes", "No"]


def test_options_are_capped_at_six():
    content = json.dumps({
        "question": "Pick",
        "options": [{"label": f"opt{i}"} for i in range(10)],
    })
    _, result = _run(content)
    assert len(result["ask_user"]["options"]) == 6


def test_fewer_than_two_options_is_rejected():
    content = json.dumps({"question": "Only one?", "options": [{"label": "A"}]})
    _, result = _run(content)
    assert "error" in result
    assert result.get("exit_code") == 1


def test_missing_question_is_rejected():
    content = json.dumps({"options": [{"label": "A"}, {"label": "B"}]})
    _, result = _run(content)
    assert "error" in result


def test_serializer_round_trips_structured_args():
    from src.tool_schemas import function_call_to_tool_block
    args = {"question": "Q?", "options": [{"label": "A"}, {"label": "B"}], "multi": True}
    block = function_call_to_tool_block("ask_user", json.dumps(args))
    assert block is not None
    assert block.tool_type == "ask_user"
    assert json.loads(block.content) == args


def test_serializer_keeps_unicode_readable_for_tool_trace():
    from src.tool_schemas import function_call_to_tool_block

    args = {
        "question": "¿Qué proyecto prefieres?",
        "options": [{"label": "Reseñas"}, {"label": "Clasificación"}],
    }
    block = function_call_to_tool_block("ask_user", json.dumps(args, ensure_ascii=False))
    assert "¿Qué proyecto prefieres?" in block.content
    assert "Reseñas" in block.content
    assert "\\u00" not in block.content


def test_registered_everywhere():
    # TOOL_TAGS gate (serializer rejects unknown tools)
    assert "ask_user" in TOOL_TAGS
    # Always reachable + has a retrieval description
    assert "ask_user" in ALWAYS_AVAILABLE
    assert "ask_user" in BUILTIN_TOOL_DESCRIPTIONS
    # Function schema present
    from src.tool_schemas import FUNCTION_TOOL_SCHEMAS
    names = {s["function"]["name"] for s in FUNCTION_TOOL_SCHEMAS}
    assert "ask_user" in names
    # Not admin/public-gated — any user can be asked
    assert is_public_blocked_tool("ask_user") is False


def test_ask_user_guidance_prefers_project_defaults_for_routine_choices():
    from src.agent_loop import _build_system_prompt
    from src.tool_schemas import FUNCTION_TOOL_SCHEMAS

    messages, _ = _build_system_prompt(
        messages=[{"role": "user", "content": "Fix the app."}],
        model="test-model", active_document=None, mcp_mgr=None,
        relevant_tools={"ask_user"}, suppress_local_context=True, suppress_skills=True,
    )
    prompt = "\n".join(str(message.get("content") or "") for message in messages)
    ask_user_schema = next(
        item["function"]["description"] for item in FUNCTION_TOOL_SCHEMAS
        if item["function"]["name"] == "ask_user"
    )

    from src.tool_index import BUILTIN_TOOL_DESCRIPTIONS

    for guidance in (prompt, ask_user_schema, BUILTIN_TOOL_DESCRIPTIONS["ask_user"]):
        assert "routine, reversible implementation choices" in guidance
        assert "follow its existing conventions" in guidance or "follow its conventions" in guidance
        assert "required approval" in guidance
        assert "required information is missing" in guidance
        assert "no reasonable default" in guidance
        assert "Do not ask permission to inspect files, run checks, or continue work the user already authorized" in guidance
        assert "dedicated approval flow" in guidance
        assert "confirm an assumption" not in guidance
