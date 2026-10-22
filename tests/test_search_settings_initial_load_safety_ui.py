"""Opt-in actual-app regression for Search settings load failure safety."""
import os
from pathlib import Path
import shutil
import subprocess

import pytest


ROOT = Path(__file__).resolve().parents[1]


@pytest.mark.skipif(not shutil.which("node"), reason="node binary not on PATH")
def test_search_settings_initial_load_safety_ui():
    playwright = os.environ.get("PLAYWRIGHT_PACKAGE")
    browser = os.environ.get("BROWSER_EXECUTABLE")
    if not playwright or not browser or not Path(playwright).exists():
        pytest.skip("Set PLAYWRIGHT_PACKAGE and BROWSER_EXECUTABLE for browser checks")
    env = os.environ.copy()
    env.update({"PLAYWRIGHT_PACKAGE": playwright, "BROWSER_EXECUTABLE": browser})
    proc = subprocess.run(
        ["node", str(ROOT / "tests/helpers/test_search_settings_initial_load_safety_ui.cjs")],
        capture_output=True,
        text=True,
        timeout=120,
        cwd=ROOT,
        env=env,
    )
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert '"pass": true' in proc.stdout
