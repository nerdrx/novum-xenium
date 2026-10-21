"""Actual Settings module loopback test for integration removal feedback."""

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]


@pytest.mark.skipif(not shutil.which("node"), reason="node binary not on PATH")
def test_integration_removal_loopback():
    playwright = os.environ.get("PLAYWRIGHT_PACKAGE")
    browser = os.environ.get("BROWSER_EXECUTABLE")
    if not playwright or not browser:
        pytest.skip("Set PLAYWRIGHT_PACKAGE and BROWSER_EXECUTABLE for browser checks")
    env = os.environ.copy()
    env.update({"PLAYWRIGHT_PACKAGE": playwright, "BROWSER_EXECUTABLE": browser})
    result = subprocess.run(
        ["node", "tests/helpers/test_integration_removal_ui.cjs"],
        capture_output=True,
        text=True,
        timeout=90,
        cwd=ROOT,
        env=env,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    payload = json.loads(result.stdout)
    assert payload["pass"] is True
    assert payload["externalRequests"] == []
    assert payload["pageErrors"] == []
    assert payload["cases"]["http503"]["changes"] == 0
    assert payload["cases"]["http503"]["formVisible"] is True
    assert payload["cases"]["http503"]["toast"] == "Could not remove integration. Try again."
    assert payload["cases"]["networkFailure"]["attempts"] == 1
    assert payload["cases"]["networkFailure"]["serverDeletes"] == 0
    assert payload["cases"]["networkFailure"]["changes"] == 0
    assert payload["cases"]["confirmCanceled"]["deletions"] == 0
    assert payload["cases"]["success"]["changes"] == 1
    assert payload["cases"]["successAndNewerForm"]["formVisible"] is True
