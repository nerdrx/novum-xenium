"""Actual Settings module loopback coverage for contact edit/delete failures."""
import json
import os
from pathlib import Path
import shutil
import subprocess

import pytest

ROOT = Path(__file__).resolve().parents[1]


@pytest.mark.skipif(not shutil.which("node"), reason="node binary not on PATH")
def test_contacts_manager_http_status_ui():
    playwright = os.environ.get("PLAYWRIGHT_PACKAGE")
    browser = os.environ.get("BROWSER_EXECUTABLE")
    if not playwright or not browser:
        pytest.skip("Set PLAYWRIGHT_PACKAGE and BROWSER_EXECUTABLE for browser checks")
    env = os.environ.copy()
    env.update({"PLAYWRIGHT_PACKAGE": playwright, "BROWSER_EXECUTABLE": browser})
    result = subprocess.run(
        ["node", "tests/helpers/contacts_status_ui.cjs"],
        capture_output=True,
        text=True,
        timeout=90,
        cwd=ROOT,
        env=env,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    payload = json.loads(result.stdout)
    assert payload["pass"] is True
    assert payload["pageErrors"] == []
    assert payload["externalRequests"] == []
    assert payload["cases"]["save503"]["draftRetained"] is True
    assert payload["cases"]["saveRetry"]["savedName"] == "Mira Unsaved Draft"
    assert payload["cases"]["saveFalseBody"]["draftRetained"] is True
    assert payload["cases"]["saveFalseBodyRetry"]["savedName"] == "Mira False-Body Draft"
    assert payload["cases"]["saveNullBody"]["draftRetained"] is True
    assert payload["cases"]["saveNetworkFailure"]["draftRetained"] is True
    assert payload["cases"]["delete403"]["contactStillPresent"] is True
    assert payload["cases"]["deleteFalseBody"]["contactRetained"] is True
    assert payload["cases"]["deleteMissingBody"]["contactRetained"] is True
    assert payload["cases"]["deleteNetworkFailure"]["contactStillPresent"] is True
    assert payload["cases"]["deleteSuccess"]["contactRemoved"] is True
