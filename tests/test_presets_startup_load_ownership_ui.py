"""Actual-module browser regression for stale startup preset responses."""
import os
from pathlib import Path
import shutil
import subprocess

import pytest


ROOT = Path(__file__).resolve().parents[1]


@pytest.mark.skipif(not shutil.which("node"), reason="node binary not on PATH")
def test_stale_startup_presets_response_preserves_newer_custom_and_rejects_bad_shapes():
    if os.environ.get("GITHUB_ACTIONS") == "true":
        playwright = str(ROOT / "node_modules" / "playwright")
        assert Path(playwright).is_dir(), "Playwright should be installed by npm ci in CI"
        browser = None
    else:
        playwright = os.environ.get("PLAYWRIGHT_PACKAGE")
        browser = os.environ.get("BROWSER_EXECUTABLE")
        if not playwright or not browser:
            pytest.skip("Set PLAYWRIGHT_PACKAGE and BROWSER_EXECUTABLE for browser checks")

    env = os.environ.copy()
    env["PLAYWRIGHT_PACKAGE"] = playwright
    if browser:
        env["BROWSER_EXECUTABLE"] = browser
    else:
        env.pop("BROWSER_EXECUTABLE", None)
    result = subprocess.run(
        ["node", str(ROOT / "tests/helpers/test_presets_startup_load_ownership_ui.cjs")],
        capture_output=True, text=True, timeout=60, cwd=ROOT, env=env,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert '"pass":true' in result.stdout
