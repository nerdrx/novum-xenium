import json
from pathlib import Path

import pytest

from src.agent_tools.filesystem_tools import ApplyPatchTool
import src.agent_tools.filesystem_tools as filesystem_tools


@pytest.mark.asyncio
async def test_apply_patch_keeps_each_file_atomic_when_later_commit_fails(
    monkeypatch,
    tmp_path: Path,
):
    first = tmp_path / "first.txt"
    second = tmp_path / "second.txt"
    first.write_text("before first\n", encoding="utf-8")
    second.write_text("before second\n", encoding="utf-8")
    patch_text = """*** Begin Patch
*** Update File: first.txt
@@
-before first
+after first
*** Update File: second.txt
@@
-before second
+after second
*** End Patch"""

    import src.tool_execution as tool_execution

    monkeypatch.setattr(
        tool_execution,
        "_resolve_tool_path",
        lambda path: str(tmp_path / path),
    )
    original_write = filesystem_tools._write_mutation_target
    calls = 0

    def fail_during_second_install(*args, **kwargs):
        nonlocal calls
        calls += 1
        if calls == 2:
            raise OSError("simulated second-file commit failure")
        return original_write(*args, **kwargs)

    monkeypatch.setattr(filesystem_tools, "_write_mutation_target", fail_during_second_install)

    result = await ApplyPatchTool().execute(
        json.dumps({"patch": patch_text}),
        {},
    )

    assert result["exit_code"] == 1
    assert "simulated second-file commit failure" in result["error"]
    # Each replacement is atomic; a later file failure does not roll back an
    # earlier completed operation, so report that partial progress honestly.
    assert "earlier patch operations may be partial" in result["error"]
    assert first.read_text(encoding="utf-8") == "after first\n"
    assert second.read_text(encoding="utf-8") == "before second\n"
