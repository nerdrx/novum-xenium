"""Keyboard and touch-target regression for the synthetic mobile Email library."""

import os
from pathlib import Path
import shutil
import subprocess

import pytest


_ROOT = Path(__file__).resolve().parents[1]


@pytest.mark.skipif(not shutil.which("node"), reason="node binary not on PATH")
def test_email_library_keyboard_open_and_mobile_targets(tmp_path):
    playwright = os.environ.get("PLAYWRIGHT_PACKAGE")
    browser = os.environ.get("BROWSER_EXECUTABLE")
    if not playwright or not browser:
        pytest.skip("Set PLAYWRIGHT_PACKAGE and BROWSER_EXECUTABLE for browser checks")
    env = os.environ.copy()
    env.update({
        "PLAYWRIGHT_PACKAGE": playwright,
        "BROWSER_EXECUTABLE": browser,
        "EVIDENCE_DIR": os.environ.get("EVIDENCE_DIR", str(tmp_path)),
    })
    result = subprocess.run(
        ["node", "tests/helpers/test_email_library_mobile_accessibility_ui.cjs"],
        capture_output=True,
        text=True,
        timeout=60,
        cwd=_ROOT,
        env=env,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    for viewport in ("320x844", "390x844", "430x844", "600x320-landscape"):
        assert f"PASS {viewport}" in result.stdout
    assert "PASS keyboard Enter/Space, select mode, child action, and mobile targets" in result.stdout
