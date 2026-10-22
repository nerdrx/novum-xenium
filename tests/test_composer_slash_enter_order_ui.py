"""Opt-in full-app regression for slash completion and Enter ordering."""
import os
from pathlib import Path
import shutil
import subprocess

import pytest


@pytest.mark.skipif(not shutil.which("node"), reason="node binary not on PATH")
def test_composer_slash_enter_order_ui():
    playwright = os.environ.get("PLAYWRIGHT_PACKAGE")
    browser = os.environ.get("BROWSER_EXECUTABLE")
    if not playwright or not browser or not Path(playwright).exists():
        pytest.skip("Set PLAYWRIGHT_PACKAGE and BROWSER_EXECUTABLE for browser checks")
    root = Path(__file__).resolve().parents[1]
    env = os.environ.copy()
    env.update({
        "PLAYWRIGHT_PACKAGE": playwright,
        "BROWSER_EXECUTABLE": browser,
        "RUN_COMPOSITION_CONTROL": "1",
    })
    result = subprocess.run(
        ["node", str(root / "tests/helpers/test_composer_slash_enter_order_ui.cjs")],
        capture_output=True, text=True, timeout=90, cwd=root, env=env,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert '"scenario": "ghost-autocomplete-enter-control"' in result.stdout
