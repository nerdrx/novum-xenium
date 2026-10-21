"""Actual Settings-module API form response-ownership browser regression."""

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]


@pytest.mark.skipif(not shutil.which("node"), reason="node binary not on PATH")
def test_api_form_response_ownership_loopback():
    playwright = os.environ.get("PLAYWRIGHT_PACKAGE")
    browser = os.environ.get("BROWSER_EXECUTABLE")
    if not playwright or not browser:
        pytest.skip("Set PLAYWRIGHT_PACKAGE and BROWSER_EXECUTABLE for browser checks")
    env = os.environ.copy()
    env.update({"PLAYWRIGHT_PACKAGE": playwright, "BROWSER_EXECUTABLE": browser})
    result = subprocess.run(
        ["node", "tests/helpers/test_api_form_response_ownership.cjs"],
        capture_output=True,
        text=True,
        timeout=60,
        cwd=ROOT,
        env=env,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    payload = json.loads(result.stdout)
    assert payload["pass"] is True
    assert payload["externalRequests"] == []
    assert payload["pageErrors"] == []
    assert payload["cases"]["normalApiTestAndSave"]["integrationChanges"] == 1
    held_test = payload["cases"]["heldApiTestThenCalDavB"]
    assert held_test["live"]["label"] == "B draft remains"
    assert held_test["live"]["url"] == "https://fixture.invalid/b-draft"
    assert held_test["newPageErrors"] == 0
    assert payload["cases"]["cancelledApiTestResponse"]["live"]["visible"] is False
    assert payload["cases"]["heldMalformedApiTestThenCalDavB"]["newPageErrors"] == 0
    saved = payload["cases"]["heldApiSaveThenCalDavB"]
    assert saved["live"]["label"] == "B draft remains"
    assert saved["live"]["url"] == "https://fixture.invalid/b-draft"
    assert saved["savedServerName"] == "API save in flight"
    assert saved["changes"] == 1
    assert saved["pageErrors"] == 0
    assert saved["listReadsAfter"] > saved["listReadsBefore"]
    assert saved["live"]["listHasSavedName"] is True
    refresh = payload["cases"]["acceptedSaveThenNullListRefresh"]
    assert refresh["savedServerName"] == "Accepted but list response null"
    assert refresh["live"]["message"] == "Saved"
    assert refresh["live"]["changes"] == 1
    assert "API integration saved" in refresh["live"]["toast"]
