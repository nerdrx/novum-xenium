"""Optional real-browser coverage for Notes keyboard focus and mobile layout."""
import os
import shutil
import subprocess

import pytest


@pytest.mark.skipif(not shutil.which("node"), reason="node binary not on PATH")
def test_notes_keyboard_accessibility_and_mobile_reachability():
    playwright = os.environ.get("PLAYWRIGHT_PACKAGE")
    browser = os.environ.get("BROWSER_EXECUTABLE")
    if not playwright or not browser:
        pytest.skip("Set PLAYWRIGHT_PACKAGE and BROWSER_EXECUTABLE for browser checks")
    env = os.environ.copy()
    env.update({"PLAYWRIGHT_PACKAGE": playwright, "BROWSER_EXECUTABLE": browser})
    result = subprocess.run(
        ["node", "tests/helpers/test_notes_keyboard_accessibility_ui.cjs"],
        capture_output=True, text=True, timeout=90, env=env,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert "PASS Notes keyboard open, focus return, save boundaries, and mobile reachability" in result.stdout
