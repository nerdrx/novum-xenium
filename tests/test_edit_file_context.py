"""Edit misses show bounded exact-line context without relaxing writes."""

import asyncio
import json

from src.tool_execution import _direct_fallback


def test_near_miss_returns_numbered_actual_source_and_leaves_file_unchanged(tmp_path):
    path = tmp_path / "converter.py"
    source = "def convert(path):\n    command = ['ffmpeg', '-i', path]\n    run(command)\n"
    path.write_text(source)
    old = (
        "def convert(path):\n"
        "    command = ['ffmpeg','-i', path]  # output option here\n"
        "    # expected separator\n"
        "    run(command)\n"
    )

    result = asyncio.run(_direct_fallback("edit_file", json.dumps({
        "path": str(path), "old_string": old, "new_string": "replacement",
    })))

    assert result["exit_code"] == 1
    assert "Nearby actual source (no edit was applied)" in result["error"]
    assert "1: def convert(path):" in result["error"]
    assert "2:     command = ['ffmpeg', '-i', path]" in result["error"]
    assert len(result["error"]) < 2000
    assert path.read_text() == source


def test_edit_miss_without_exact_useful_anchor_keeps_read_hint(tmp_path):
    path = tmp_path / "plain.txt"
    source = "alpha\nbeta\n"
    path.write_text(source)

    result = asyncio.run(_direct_fallback("edit_file", json.dumps({
        "path": str(path), "old_string": "completely unrelated context", "new_string": "x",
    })))

    assert result["exit_code"] == 1
    assert "Read the file and match it exactly" in result["error"]
    assert "Nearby actual source" not in result["error"]
    assert path.read_text() == source
