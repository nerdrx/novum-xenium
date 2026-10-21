"""Behavioral browser regression for pending Group persona availability."""
import os
from pathlib import Path
import shutil
import subprocess

import pytest


ROOT = Path(__file__).resolve().parents[1]


def _browser_environment():
    node = shutil.which("node")
    if not node:
        return None
    playwright = os.environ.get("PLAYWRIGHT_PACKAGE")
    browser = os.environ.get("BROWSER_EXECUTABLE")
    if os.environ.get("GITHUB_ACTIONS") == "true":
        local_playwright = ROOT / "node_modules" / "playwright"
        if not playwright and (local_playwright / "package.json").is_file():
            playwright = str(local_playwright)
        return (node, playwright, browser) if playwright else None
    return (node, playwright, browser) if playwright and browser else None


@pytest.mark.skipif(not shutil.which("node"), reason="node binary not on PATH")
def test_group_sees_pending_persona_without_optimistic_saved_template_mutation():
    browser_env = _browser_environment()
    if not browser_env:
        pytest.skip("Set PLAYWRIGHT_PACKAGE and BROWSER_EXECUTABLE, or run in configured CI")
    node, playwright, browser = browser_env
    env = os.environ.copy()
    env["PLAYWRIGHT_PACKAGE"] = playwright
    if browser:
        env["BROWSER_EXECUTABLE"] = browser
    else:
        env.pop("BROWSER_EXECUTABLE", None)
    result = subprocess.run(
        [node, "tests/helpers/test_group_character_dropdown_ui.cjs"],
        capture_output=True, text=True, timeout=60, cwd=ROOT, env=env,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert '"pass": true' in result.stdout
