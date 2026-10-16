"""Headless browser regression for safe Markdown video rendering."""
import os
from pathlib import Path
import shutil
import subprocess

import pytest


_ROOT = Path(__file__).resolve().parents[1]


@pytest.mark.skipif(not shutil.which("node"), reason="node binary not on PATH")
def test_markdown_video_load_click_and_sanitization():
    playwright = os.environ.get("PLAYWRIGHT_PACKAGE")
    browser = os.environ.get("BROWSER_EXECUTABLE")
    if not playwright or not browser:
        pytest.skip("Set PLAYWRIGHT_PACKAGE and BROWSER_EXECUTABLE for browser checks")
    env = os.environ.copy()
    env.update({"PLAYWRIGHT_PACKAGE": playwright, "BROWSER_EXECUTABLE": browser})
    result = subprocess.run(
        ["node", "tests/helpers/test_markdown_video_ui.cjs"],
        capture_output=True,
        text=True,
        timeout=45,
        cwd=_ROOT,
        env=env,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert "PASS markdown video load, click, and DOM sanitization" in result.stdout
