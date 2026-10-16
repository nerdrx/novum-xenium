"""Headless regression for live and historical chat speed metrics."""
import os
from pathlib import Path
import shutil
import subprocess

import pytest


_ROOT = Path(__file__).resolve().parents[1]


@pytest.mark.skipif(not shutil.which("node"), reason="node binary not on PATH")
def test_live_and_reopened_chat_show_computed_speed_without_overwriting_measured():
    playwright = os.environ.get("PLAYWRIGHT_PACKAGE")
    browser = os.environ.get("BROWSER_EXECUTABLE")
    if not playwright or not browser:
        pytest.skip("Set PLAYWRIGHT_PACKAGE and BROWSER_EXECUTABLE for browser checks")
    env = os.environ.copy()
    env.update({"PLAYWRIGHT_PACKAGE": playwright, "BROWSER_EXECUTABLE": browser})
    result = subprocess.run(
        ["node", "tests/helpers/test_chat_tps_display_ui.cjs"],
        capture_output=True, text=True, timeout=60, cwd=_ROOT, env=env,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert "PASS live and reopened TPS metrics" in result.stdout
