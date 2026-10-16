"""Headless regression for the mobile composer mode-toggle alignment."""
import os
from pathlib import Path
import shutil
import subprocess

import pytest


_ROOT = Path(__file__).resolve().parents[1]


@pytest.mark.skipif(not shutil.which("node"), reason="node binary not on PATH")
def test_mobile_composer_controls_align_at_phone_widths():
    playwright = os.environ.get("PLAYWRIGHT_PACKAGE")
    browser = os.environ.get("BROWSER_EXECUTABLE")
    if not playwright or not browser:
        pytest.skip("Set PLAYWRIGHT_PACKAGE and BROWSER_EXECUTABLE for browser checks")
    env = os.environ.copy()
    env.update({"PLAYWRIGHT_PACKAGE": playwright, "BROWSER_EXECUTABLE": browser})
    result = subprocess.run(
        ["node", "tests/helpers/test_mobile_composer_alignment_ui.cjs"],
        capture_output=True, text=True, timeout=60, cwd=_ROOT, env=env,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    for viewport in ("576x1280px", "390x844px", "320x844px", "600x320px"):
        assert f"PASS {viewport}" in result.stdout
