from src.tool_execution import format_tool_result


def test_read_formatter_marks_eof_and_paged_continuation_concisely():
    complete = format_tool_result("read_file", {
        "output": "const app = true;",
        "exit_code": 0,
        "read_metadata": {"start_line": 1, "reached_eof": True},
    })
    assert "Read status: end of file reached from line 1." in complete
    assert '"read_metadata"' not in complete

    paged = format_tool_result("read_file", {
        "output": "line 40\n... [more lines available; continue with offset=41]",
        "exit_code": 0,
        "read_metadata": {
            "start_line": 40, "reached_eof": False, "next_offset": 41,
        },
    })
    assert "Read status: more file content remains from line 40." in paged
    assert "Continue with offset=41." in paged


def test_read_formatter_never_claims_eof_for_partial_read():
    formatted = format_tool_result("read_file", {
        "output": "first lines\n... [truncated at 20000 chars; continue with offset=100]",
        "exit_code": 0,
        "read_metadata": {
            "start_line": 1, "reached_eof": False, "next_offset": 100,
        },
    })
    assert "Read status: more file content remains from line 1." in formatted
    assert "Continue with offset=100." in formatted
    assert "end of file reached" not in formatted


def test_read_formatter_treats_literal_truncation_phrase_as_file_content():
    formatted = format_tool_result("read_file", {
        "output": "documented phrase: truncated at 20000 chars",
        "exit_code": 0,
        "read_metadata": {"start_line": 1, "reached_eof": True},
    })
    assert "Read status: end of file reached from line 1." in formatted


def test_non_read_output_does_not_get_file_completeness_claim():
    formatted = format_tool_result("bash", {"output": "done", "exit_code": 0})
    assert "Read status:" not in formatted
