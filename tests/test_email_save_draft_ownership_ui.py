"""Actual-module browser regression for async email Save Draft ownership."""

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[1]


@pytest.mark.skipif(not shutil.which("node"), reason="node binary not on PATH")
def test_email_save_draft_ownership_loopback():
    playwright = os.environ.get("PLAYWRIGHT_PACKAGE")
    browser = os.environ.get("BROWSER_EXECUTABLE")
    if not playwright or not browser:
        pytest.skip("Set PLAYWRIGHT_PACKAGE and BROWSER_EXECUTABLE for browser checks")
    env = os.environ.copy()
    env.update({"PLAYWRIGHT_PACKAGE": playwright, "BROWSER_EXECUTABLE": browser})
    result = subprocess.run(
        ["node", "tests/helpers/test_email_save_draft_ownership_ui.cjs"],
        capture_output=True,
        text=True,
        timeout=90,
        cwd=_ROOT,
        env=env,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    payload = json.loads(result.stdout.strip().splitlines()[-1])
    assert payload["pass"] is True
    assert payload["externalRequests"] == 0
    assert payload["cases"]["bAfterA"]["draft_uid"] is None
    assert payload["cases"]["aFollowup"]["draft_uid"] == "fixture-saved-0"
    assert payload["cases"]["cFollowup"]["draft_uid"] == "fixture-saved-3"
    assert payload["cases"]["eAfterDRemoved"]["draft_uid"] is None
    assert payload["cases"]["hAfterG"]["draft_uid"] is None
    assert payload["cases"]["gAfterJson"]["draft_uid"] == "fixture-saved-8"
