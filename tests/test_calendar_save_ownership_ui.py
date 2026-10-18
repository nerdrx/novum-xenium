import os
import shutil
import subprocess

import pytest


@pytest.mark.skipif(not shutil.which("node"), reason="node binary not on PATH")
def test_calendar_save_ownership_ui():
    playwright = os.environ.get("PLAYWRIGHT_PACKAGE")
    browser = os.environ.get("BROWSER_EXECUTABLE")
    if not playwright or not browser:
        pytest.skip("Set PLAYWRIGHT_PACKAGE and BROWSER_EXECUTABLE for browser checks")
    env = os.environ.copy()
    env.update({"PLAYWRIGHT_PACKAGE": playwright, "BROWSER_EXECUTABLE": browser})
    proc = subprocess.run(
        ["node", "tests/helpers/test_calendar_save_ownership_ui.cjs"],
        capture_output=True, text=True, timeout=90, env=env,
    )
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert "PASS Calendar save ownership" in proc.stdout
