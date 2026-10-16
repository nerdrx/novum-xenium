"""Headless regressions for mobile chat visibility and section preferences."""

import os
from pathlib import Path
import shutil
import subprocess

import pytest


_REPO = Path(__file__).resolve().parents[1]


@pytest.mark.skipif(not shutil.which("node"), reason="node binary not on PATH")
def test_mobile_lists_all_chats_and_respects_collapse_choices():
    playwright = os.environ.get("PLAYWRIGHT_PACKAGE")
    browser = os.environ.get("BROWSER_EXECUTABLE")
    if not playwright or not browser:
        pytest.skip("Set PLAYWRIGHT_PACKAGE and BROWSER_EXECUTABLE for browser checks")
    env = os.environ.copy()
    env.update({"PLAYWRIGHT_PACKAGE": playwright, "BROWSER_EXECUTABLE": browser})
    proc = subprocess.run(
        ["node", str(_REPO / "tests/helpers/test_mobile_all_chats_ui.cjs")],
        capture_output=True, text=True, timeout=60, env=env,
    )
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert "PASS: mobile all-chat visibility and section preferences" in proc.stdout
