import os
from pathlib import Path
import shutil
import subprocess

import pytest


ROOT = Path(__file__).resolve().parents[1]


@pytest.mark.skipif(not shutil.which("node"), reason="node binary not on PATH")
def test_calendar_sync_status_ui():
    playwright = os.environ.get("PLAYWRIGHT_PACKAGE")
    browser = os.environ.get("BROWSER_EXECUTABLE")
    if not playwright or not browser:
        pytest.skip("Set PLAYWRIGHT_PACKAGE and BROWSER_EXECUTABLE for browser checks")
    env = os.environ.copy()
    env.update({"NOVUM_CALENDAR_SYNC_STATUS_UI_PROOF": "1"})
    result = subprocess.run(
        ["node", str(ROOT / "tests/helpers/test_calendar_sync_status_ui.cjs")],
        capture_output=True,
        text=True,
        timeout=120,
        env=env,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert "PASS " in result.stdout
