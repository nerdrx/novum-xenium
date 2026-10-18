import os
from pathlib import Path
import shutil
import subprocess

import pytest


ROOT = Path(__file__).resolve().parents[1]


@pytest.mark.skipif(not shutil.which("node"), reason="node binary not on PATH")
def test_ai_defaults_accessibility_ui():
    playwright = os.environ.get("PLAYWRIGHT_PACKAGE")
    browser = os.environ.get("BROWSER_EXECUTABLE")
    if not playwright or not browser or not Path(playwright).exists():
        pytest.skip("Set PLAYWRIGHT_PACKAGE and BROWSER_EXECUTABLE for browser checks")
    env = os.environ.copy()
    env.update({"PLAYWRIGHT_PACKAGE": playwright, "BROWSER_EXECUTABLE": browser})
    proc = subprocess.run(
        ["node", str(ROOT / "tests/helpers/test_ai_defaults_accessibility_ui.cjs")],
        capture_output=True,
        text=True,
        timeout=45,
        env=env,
    )
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert "PASS AI Defaults labels and touch targets" in proc.stdout
