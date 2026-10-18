import os
from pathlib import Path
import shutil
import subprocess

import pytest


ROOT = Path(__file__).resolve().parents[1]


@pytest.mark.skipif(not shutil.which("node"), reason="node binary not on PATH")
def test_task_history_retry_empty_state_and_stale_responses():
    playwright = os.environ.get("PLAYWRIGHT_PACKAGE")
    browser = os.environ.get("BROWSER_EXECUTABLE")
    if not playwright or not browser or not Path(playwright).exists():
        pytest.skip("Playwright and Chromium are needed for this headless UI check")
    env = os.environ.copy()
    env.update({"PLAYWRIGHT_PACKAGE": playwright, "BROWSER_EXECUTABLE": browser})
    proc = subprocess.run(
        ["node", str(ROOT / "tests/helpers/test_task_history_retry_ui.cjs")],
        capture_output=True,
        text=True,
        timeout=45,
        env=env,
    )
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert "PASS: task history retry" in proc.stdout
