"""Browser regression for stale session-history responses."""
import os
from pathlib import Path
import shutil
import subprocess

import pytest


@pytest.mark.skipif(not shutil.which("node"), reason="node binary not on PATH")
def test_session_history_pager_race_browser_suite():
    repo = Path(__file__).resolve().parents[1]
    playwright = os.environ.get("PLAYWRIGHT_PACKAGE")
    browser = os.environ.get("BROWSER_EXECUTABLE")
    if not playwright or not browser:
        pytest.skip("Set PLAYWRIGHT_PACKAGE and BROWSER_EXECUTABLE for browser checks")
    env = os.environ.copy()
    env.update({"PLAYWRIGHT_PACKAGE": playwright, "BROWSER_EXECUTABLE": browser})
    result = subprocess.run(
        ["node", "--test", "tests/historyPagerRace.test.mjs"],
        cwd=repo,
        env=env,
        capture_output=True,
        text=True,
        timeout=90,
    )
    assert result.returncode == 0, result.stdout + result.stderr
