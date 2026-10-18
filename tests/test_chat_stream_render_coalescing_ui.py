"""Focused browser regression for streamed foreground render coalescing."""
import os
from pathlib import Path
import shutil
import subprocess

import pytest


_ROOT = Path(__file__).resolve().parents[1]


@pytest.mark.parametrize("scenario", [
    "burst", "terminal-before-frame", "rounds", "teacher-takeover", "stop", "switch",
    "rejected-terminal", "thinking",
])
def test_chat_stream_render_coalescing(scenario):
    playwright = os.environ.get("PLAYWRIGHT_PACKAGE")
    browser = os.environ.get("BROWSER_EXECUTABLE")
    if not shutil.which("node") or not playwright or not browser:
        pytest.skip("Set Node, PLAYWRIGHT_PACKAGE and BROWSER_EXECUTABLE for browser checks")
    env = os.environ.copy()
    env.update({"PLAYWRIGHT_PACKAGE": playwright, "BROWSER_EXECUTABLE": browser})
    result = subprocess.run(
        ["node", "tests/helpers/test_chat_stream_render_coalescing_ui.cjs", scenario],
        capture_output=True, text=True, timeout=60, cwd=_ROOT, env=env,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert "PASS" in result.stdout
