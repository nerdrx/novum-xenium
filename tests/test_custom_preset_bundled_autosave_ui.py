"""Browser regression for bundled custom-preset and reusable-template saves."""
import os
from pathlib import Path
import shutil
import subprocess

import pytest


ROOT = Path(__file__).resolve().parents[1]


@pytest.mark.skipif(not shutil.which("node"), reason="node binary not on PATH")
def test_bundled_template_autosave_keeps_confirmed_state_and_retry_identity():
    playwright = os.environ.get("PLAYWRIGHT_PACKAGE")
    browser = os.environ.get("BROWSER_EXECUTABLE")
    if os.environ.get("GITHUB_ACTIONS") == "true":
        playwright = playwright or str(ROOT / "node_modules" / "playwright")
    elif not playwright or not browser:
        pytest.skip("Set PLAYWRIGHT_PACKAGE and BROWSER_EXECUTABLE for browser checks")
    env = os.environ.copy()
    env["PLAYWRIGHT_PACKAGE"] = playwright
    if browser:
        env["BROWSER_EXECUTABLE"] = browser
    else:
        env.pop("BROWSER_EXECUTABLE", None)
    result = subprocess.run(
        ["node", str(ROOT / "tests/helpers/test_custom_preset_bundled_autosave_ui.cjs")],
        capture_output=True, text=True, timeout=90, cwd=ROOT, env=env,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert '"pass": true' in result.stdout
