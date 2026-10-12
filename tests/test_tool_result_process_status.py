"""Process exit statuses should be explicit without changing their values."""

import os

import pytest

from src import tool_execution


@pytest.mark.skipif(os.name != "posix", reason="negative subprocess signal statuses are POSIX-specific")
def test_format_tool_result_explains_signal_termination_and_incomplete_shell():
    formatted = tool_execution.format_tool_result(
        "bash", {"output": "(no output)", "exit_code": -15}
    )

    assert "exit_code:** -15" in formatted
    assert "terminated by SIGTERM" in formatted
    assert "command did not finish" in formatted
    assert "trailing shell commands may not have run" in formatted


def test_format_tool_result_keeps_positive_exit_code_ordinary():
    formatted = tool_execution.format_tool_result(
        "bash", {"output": "failed", "exit_code": 7}
    )

    assert "exit_code:** 7" in formatted
    assert "terminated by" not in formatted


@pytest.mark.skipif(os.name != "posix", reason="invalid negative signal only relevant on POSIX")
def test_format_tool_result_does_not_label_unknown_negative_as_signal():
    formatted = tool_execution.format_tool_result(
        "bash", {"output": "failed", "exit_code": -999}
    )

    assert "exit_code:** -999" in formatted
    assert "terminated by" not in formatted


def test_format_tool_result_does_not_interpret_windows_negative_status_as_signal(monkeypatch):
    monkeypatch.setattr(tool_execution.os, "name", "nt")
    formatted = tool_execution.format_tool_result(
        "bash", {"output": "failed", "exit_code": -15}
    )

    assert "exit_code:** -15" in formatted
    assert "terminated by" not in formatted
