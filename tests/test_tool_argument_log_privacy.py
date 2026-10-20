"""Argument diagnostics identify failures without copying user payloads."""

import json

import pytest

from src.tool_schemas import function_call_to_tool_block


@pytest.mark.parametrize(("name", "arguments", "category", "rejected"), [
    ("bash", '{"command":"SYNTHETIC_PRIVATE_MARKER', "Failed to parse", True),
    ("bash", json.dumps("SYNTHETIC_PRIVATE_MARKER"), "Non-object function", False),
    ("list_emails", json.dumps("SYNTHETIC_PRIVATE_MARKER"), "Non-object email", True),
    ("read_file", json.dumps({"path": "", "note": "SYNTHETIC_PRIVATE_MARKER"}),
     "Rejecting empty required", True),
])
def test_argument_diagnostics_do_not_log_payload(name, arguments, category, rejected, caplog):
    block = function_call_to_tool_block(name, arguments)

    assert (block is None) is rejected
    assert category in caplog.text
    assert name in caplog.text
    assert "SYNTHETIC_PRIVATE_MARKER" not in caplog.text
