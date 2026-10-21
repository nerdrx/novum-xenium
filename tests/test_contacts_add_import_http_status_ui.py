"""Opt-in actual Settings module coverage for contact Add and Import recovery."""
import json
import os
from pathlib import Path
import shutil
import subprocess

import pytest

ROOT = Path(__file__).resolve().parents[1]


@pytest.mark.skipif(not shutil.which("node"), reason="node binary not on PATH")
def test_contacts_add_import_http_status_ui():
    playwright = os.environ.get("PLAYWRIGHT_PACKAGE")
    browser = os.environ.get("BROWSER_EXECUTABLE")
    if not playwright or not browser:
        pytest.skip("Set PLAYWRIGHT_PACKAGE and BROWSER_EXECUTABLE for browser checks")
    env = os.environ.copy()
    env.update({"PLAYWRIGHT_PACKAGE": playwright, "BROWSER_EXECUTABLE": browser})
    result = subprocess.run(
        ["node", "tests/helpers/contacts_add_import_recovery_ui.cjs"],
        capture_output=True,
        text=True,
        timeout=90,
        cwd=ROOT,
        env=env,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    proof = json.loads(result.stdout)
    assert proof["pass"] is True
    assert proof["pageErrors"] == []
    assert proof["externalRequests"] == []
    cases = proof["cases"]
    for name in ("add503", "addFalseBody", "addNetworkFailure"):
        assert cases[name]["draftRetained"] is True
        assert cases[name]["noRefresh"] is True
    assert cases["add503Retry"]["saved"] is True
    assert cases["addFalseBodyRetry"]["saved"] is True
    assert cases["addSuccess"]["draftCleared"] is True
    assert cases["addHeldNewDraft"]["draftName"] == "Newer user draft"
    assert cases["addHeldNewDraft"]["draftEmail"] == "keep@example.invalid"
    assert cases["addHeldEditRestore"]["draftName"] == "Same restored value"
    assert cases["addHeldEditRestore"]["draftEmail"] == "restore@example.invalid"
    assert cases["addHeldDraftRetry"]["cleared"] is True
    assert cases["import503"]["toasts"] == ["Import failed (HTTP 503)"]
    assert cases["importNull"]["toasts"] == ["Invalid import response"]
    assert cases["importMalformed"]["toasts"] == ["Invalid import response"]
    assert cases["importPartial"]["toasts"] == ["Imported 1/2 (1 failed)"]
    assert cases["importDuplicates"]["toasts"] == ["Imported 0/2"]
    assert cases["importMixedPartialFail"]["toasts"] == ["Imported 1/1; Import failed (HTTP 503)"]
    assert cases["importSuccess"]["toasts"] == ["Imported 1/1"]
