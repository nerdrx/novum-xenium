"""Opt-in actual-module browser regression for Continue ownership during send preflight."""
import os
from pathlib import Path
import shutil
import subprocess

import pytest


@pytest.mark.skipif(not shutil.which("node"), reason="node binary not on PATH")
def test_continue_during_preflight_preserves_send_ownership():
    playwright = os.environ.get("PLAYWRIGHT_PACKAGE")
    browser = os.environ.get("BROWSER_EXECUTABLE")
    if not playwright or not browser:
        pytest.skip("Set PLAYWRIGHT_PACKAGE and BROWSER_EXECUTABLE for browser checks")
    root = Path(__file__).resolve().parents[1]
    env = os.environ.copy()
    env.update({"PLAYWRIGHT_PACKAGE": playwright, "BROWSER_EXECUTABLE": browser})
    result = subprocess.run(
        ["node", str(root / "tests/helpers/test_chat_continue_preflight_ownership_ui.cjs")],
        capture_output=True, text=True, timeout=90, cwd=root, env=env,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert '"pass": true' in result.stdout
