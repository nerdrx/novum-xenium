"""Actual Settings module browser regression for CalDAV form ownership."""

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]


@pytest.mark.skipif(not shutil.which("node"), reason="node binary not on PATH")
def test_caldav_form_ownership_loopback():
    playwright = os.environ.get("PLAYWRIGHT_PACKAGE")
    browser = os.environ.get("BROWSER_EXECUTABLE")
    if not playwright or not browser:
        pytest.skip("Set PLAYWRIGHT_PACKAGE and BROWSER_EXECUTABLE for browser checks")
    env = os.environ.copy()
    env.update({"PLAYWRIGHT_PACKAGE": playwright, "BROWSER_EXECUTABLE": browser})
    result = subprocess.run(
        ["node", "tests/helpers/test_caldav_form_ownership_ui.cjs"],
        capture_output=True,
        text=True,
        timeout=90,
        cwd=ROOT,
        env=env,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    payload = json.loads(result.stdout.strip().splitlines()[-1])
    assert payload["pass"] is True
    assert payload["externalRequests"] == []
    assert payload["pageErrors"] == []
    assert payload["cases"]["changedFieldsPreserved"]["observed"] == "no save; edited values preserved; retest requested"
    assert payload["cases"]["heldTestAReopenB"]["currentMessage"] == ""
    assert payload["cases"]["heldSaveAReopenB"]["saveRequests"] == 0
    assert payload["cases"]["heldSaveAReopenB"]["currentLabel"] == "B draft stays"
    assert payload["cases"]["heldSaveSettingsHidden"]["savesWhileHidden"] == 0
    assert payload["cases"]["cancelWhilePrefillHeld"]["observed"] == "cancel hid the form; late prefill ignored"
    assert payload["cases"]["editDuringActualSave"]["disabledWhileSaving"] is True
    assert payload["cases"]["saveACompletesAfterReopenB"]["accountReadsAfter"] > payload["cases"]["saveACompletesAfterReopenB"]["accountReadsBefore"]
    assert payload["cases"]["saveACompletesAfterReopenB"]["integrationEventsAfter"] == payload["cases"]["saveACompletesAfterReopenB"]["integrationEventsBefore"] + 1
    assert payload["cases"]["saveACompletesAfterReopenB"]["currentLabel"] == "B remains open"
    assert payload["cases"]["caldavSaveThenApiSelection"]["savesAfterTest"] == 0
    assert payload["cases"]["caldavSaveThenApiSelection"]["visible"] is True
    assert payload["cases"]["heldSaveSettingsHiddenDuringPut"]["messageAfterReturn"] == ""
    assert payload["cases"]["nullTestResponse"]["message"] == "Invalid response from server"
    assert payload["cases"]["standaloneTestAfterEdit"]["observed"] == "changed fields preserved; stale success suppressed"
    assert payload["cases"]["sameFormTypingDuringEditLookup"]["observed"] == "typed fields preserved"
    assert payload["cases"]["failedPrefillEmptyUsernameBlocked"]["testRequests"] == 0
    assert payload["cases"]["failedPrefillEmptyUsernameBlocked"]["saves"] == 0
    assert payload["cases"]["failedPrefillEmptyUsernameBlocked"]["prefillStatus"] == 503
    assert payload["cases"]["manuallyClearedUrlAndUsernameBlocked"]["testRequests"] == 0
    assert payload["cases"]["manuallyClearedUrlAndUsernameBlocked"]["saves"] == 0
    assert payload["cases"]["newAccountBlankPasswordBlocked"]["testRequests"] == 0
    assert payload["cases"]["newAccountBlankPasswordBlocked"]["saves"] == 0
    assert payload["cases"]["explicitSavedEditBlankPassword"]["test"]["account_id"] == "fixture-account-a"
    assert payload["cases"]["explicitSavedEditBlankPassword"]["test"]["password"] == ""
    assert payload["cases"]["normalTestSave"]["observed"] == "tested and saved same values"
