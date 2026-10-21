"""Opt-in actual-module browser checks for CardDAV form ownership and recovery."""
import json
import os
from pathlib import Path
import shutil
import subprocess

import pytest

ROOT = Path(__file__).resolve().parents[1]


@pytest.mark.skipif(not shutil.which("node"), reason="node binary not on PATH")
def test_carddav_form_ownership_ui():
    playwright = os.environ.get("PLAYWRIGHT_PACKAGE")
    browser = os.environ.get("BROWSER_EXECUTABLE")
    if not playwright or not browser:
        pytest.skip("Set PLAYWRIGHT_PACKAGE and BROWSER_EXECUTABLE for browser checks")
    env = os.environ.copy()
    env.update({"PLAYWRIGHT_PACKAGE": playwright, "BROWSER_EXECUTABLE": browser})
    result = subprocess.run(
        ["node", str(ROOT / "tests/helpers/test_carddav_form_ownership_ui.cjs")],
        capture_output=True,
        text=True,
        timeout=90,
        cwd=ROOT,
        env=env,
        check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    proof = json.loads(result.stdout)
    assert proof["pass"] is True
    assert proof["pageErrors"] == []
    assert proof["externalRequests"] == []
    assert proof["cases"]["saveHttp503"]["visibleMessage"] == "Save failed"
    for kind in ("false", "null", "missing"):
        assert proof["cases"][f"save200{kind}"]["message"] == "Save failed"
    assert proof["cases"]["normalSave"]["maskedSavedPasswordStillPresent"] is True
    assert proof["cases"]["emptyUrlDisable"]["body"]["carddav_url"] == ""
    assert proof["cases"]["emptyUrlDisable"]["body"]["carddav_username"] == "new-fixture-user"
    assert proof["cases"]["heldSaveSameFormEdit"]["message"] == "Saved; newer edits remain unsaved."
    assert proof["cases"]["heldSaveAfterSwitch"]["notificationsAfter"] == proof["cases"]["heldSaveAfterSwitch"]["notificationsBefore"] + 1
    assert proof["cases"]["heldPrefillPreservesEdits"]["saveDisabledUntilComplete"] is True
    assert proof["cases"]["cancelDuringPrefill"]["formHidden"] is True
    assert proof["cases"]["prefillDeadline"]["waitedMs"] == 15000
    assert proof["cases"]["prefillJsonDeadline"]["bodyPendingBeforeAbort"] is True
    for shape in ("missing", "null", "array", "wrongtype"):
        assert proof["cases"][f"invalidPrefill{shape}"]["message"] == "Could not load saved CardDAV settings."
