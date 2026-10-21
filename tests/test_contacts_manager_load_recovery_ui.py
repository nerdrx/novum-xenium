"""Opt-in actual-module browser coverage for Contacts Manager list recovery."""
import json
import os
from pathlib import Path
import shutil
import subprocess

import pytest

ROOT = Path(__file__).resolve().parents[1]


@pytest.mark.skipif(not shutil.which("node"), reason="node binary not on PATH")
def test_contacts_manager_load_recovery_ui():
    playwright = os.environ.get("PLAYWRIGHT_PACKAGE")
    browser = os.environ.get("BROWSER_EXECUTABLE")
    if not playwright or not browser:
        pytest.skip("Set PLAYWRIGHT_PACKAGE and BROWSER_EXECUTABLE for browser checks")
    env = os.environ.copy()
    env.update({"PLAYWRIGHT_PACKAGE": playwright, "BROWSER_EXECUTABLE": browser})
    result = subprocess.run(
        ["node", "tests/helpers/contacts_manager_load_recovery.cjs"],
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
    cases = payload["cases"]
    for name in ("http503", "network", "null", "malformed"):
        assert cases[name]["ui"]["warning"] is True
        assert cases[name]["ui"]["retry"] is True
        assert cases[name]["ui"]["retryBounds"]["width"] >= 44
        assert cases[name]["ui"]["retryBounds"]["height"] >= 44
        assert cases[name]["retryRecovered"] is True
    assert cases["empty"]["ui"]["text"] == "No contacts yet."
    assert cases["empty"]["ui"]["retry"] is False
    failure = cases["priorRows503"]["afterFailure"]
    assert cases["priorRows503"]["editorPreserved"] is True
    assert cases["priorRows503"]["draft"] == "Mira Unsaved Editor Draft"
    assert failure["rows"]
    assert failure["warning"] is True
    assert "Showing previous results" in failure["text"]
    assert cases["priorRows503"]["afterRetry"]["warning"] is False
    retry = cases["priorRows503"]["retryState"]
    assert cases["priorRows503"]["bodyCompletionObserved"] is True
    assert cases["priorRows503"]["twoAnimationFramesObserved"] is True
    assert cases["priorRows503"]["whileRetryHeld"]["editorVisible"] is True
    assert cases["priorRows503"]["whileRetryHeld"]["draft"] == "Mira Unsaved Editor Draft"
    assert retry["warning"] is False
    assert retry["uid"] == "fixture-contact"
    assert retry["oldRowDisconnected"] is True
    assert retry["editorVisible"] is True
    assert retry["draft"] == "Mira Edited During Retry"
    assert retry["renderedName"] == "Mira Fixture"
    for name in ("stalledFetch", "stalledJson"):
        assert cases[name]["requestAborted"] is True
        assert cases[name]["retryRecovered"] is True
    assert cases["olderRefreshAfterSave"]["staleOverwrite"] is False
    reopened = cases["heldOldListAfterReopen"]
    assert reopened["managerBCountPreserved"] is True
    assert reopened["before"]["count"] == reopened["after"]["count"] == "(2/2)"
    assert reopened["query"] == "Manager B"
    assert len(reopened["visibleRows"]) == 2
