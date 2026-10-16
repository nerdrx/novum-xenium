"""Headless mobile regression for preserving active media during streaming."""

import os
import shutil
import subprocess

import pytest


@pytest.mark.skipif(not shutil.which("node"), reason="node binary not on PATH")
def test_streaming_keeps_mobile_media_playback_stable():
    playwright = os.environ.get("PLAYWRIGHT_PACKAGE")
    browser = os.environ.get("BROWSER_EXECUTABLE")
    if not playwright or not browser:
        pytest.skip("Set PLAYWRIGHT_PACKAGE and BROWSER_EXECUTABLE for browser checks")
    env = os.environ.copy()
    env.update({"PLAYWRIGHT_PACKAGE": playwright, "BROWSER_EXECUTABLE": browser})
    result = subprocess.run(
        ["node", "tests/helpers/test_streaming_media_mobile_ui.cjs"],
        capture_output=True, text=True, timeout=45, env=env,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert "PASS mobile streaming preserves active media" in result.stdout
