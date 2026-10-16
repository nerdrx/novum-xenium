"""Headless layout regression for the Persona Prompt dialog."""
import os
from pathlib import Path
import shutil
import subprocess

import pytest


_ROOT = Path(__file__).resolve().parents[1]


@pytest.mark.skipif(not shutil.which("node"), reason="node binary not on PATH")
def test_persona_modal_controls_align_at_desktop_and_mobile_widths():
    playwright = os.environ.get("PLAYWRIGHT_PACKAGE")
    browser = os.environ.get("BROWSER_EXECUTABLE")
    if not playwright or not browser:
        pytest.skip("Set PLAYWRIGHT_PACKAGE and BROWSER_EXECUTABLE for browser checks")
    env = os.environ.copy()
    env.update({"PLAYWRIGHT_PACKAGE": playwright, "BROWSER_EXECUTABLE": browser})
    result = subprocess.run(
        ["node", "tests/helpers/test_persona_modal_alignment_ui.cjs"],
        capture_output=True, text=True, timeout=60, cwd=_ROOT, env=env,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert "PASS 1280px" in result.stdout
    assert "PASS 390px" in result.stdout
