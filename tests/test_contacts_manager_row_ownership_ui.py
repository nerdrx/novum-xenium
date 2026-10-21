"""Actual Settings module coverage for row actions across manager replacement."""
import json
import os
from pathlib import Path
import shutil
import subprocess

import pytest

ROOT = Path(__file__).resolve().parents[1]


@pytest.mark.skipif(not shutil.which("node"), reason="node binary not on PATH")
def test_contacts_manager_row_ownership_ui():
    playwright = os.environ.get("PLAYWRIGHT_PACKAGE")
    browser = os.environ.get("BROWSER_EXECUTABLE")
    if not playwright or not browser:
        pytest.skip("Set PLAYWRIGHT_PACKAGE and BROWSER_EXECUTABLE for browser checks")
    env = os.environ.copy()
    env.update({"PLAYWRIGHT_PACKAGE": playwright, "BROWSER_EXECUTABLE": browser})
    result = subprocess.run(
        ["node", "tests/helpers/contact_row_ownership_ui.cjs"],
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
    assert payload["cases"]["ownedSaveControls"]["failedDraftRetained"] is True
    assert payload["cases"]["ownedSaveControls"]["savedName"] == "A draft retained"
    assert payload["cases"]["ownedSaveControls"]["editorClosedAfterSave"] is True
    assert payload["cases"]["sameManagerSaveDrafts"]["listRefreshCompleted"] is True
    assert payload["cases"]["sameManagerSaveDrafts"]["aNewerDraftPreserved"] is True
    assert payload["cases"]["sameManagerSaveDrafts"]["bLatestDraftPreserved"] is True
    assert payload["cases"]["sameManagerSaveDrafts"]["focusAndSelectionPreserved"] is True
    assert payload["cases"]["sameManagerSaveDrafts"]["submittedA"] == "Fixture A accepted"
    assert payload["cases"]["sameManagerSaveDrafts"]["savedA"] == "Fixture A accepted"
    assert payload["cases"]["sameManagerSaveDrafts"]["after"]["serverA"] == "Fixture A accepted"
    assert payload["cases"]["addSameFormNewDraft"]["newerDraftRetained"] is True
    assert payload["cases"]["addSameFormNewDraft"]["acceptedName"] == "First accepted Add"
    assert payload["cases"]["staleAddAfterReopen"]["draftPreserved"] is True
    assert payload["cases"]["staleAddAfterReopen"]["refreshIssued"] is False
    assert payload["cases"]["staleAddAfterReopen"]["addedContactPresent"] is True
    assert payload["cases"]["staleImportAfterReopen"]["draftPreserved"] is True
    assert payload["cases"]["staleImportAfterReopen"]["refreshIssued"] is False
    assert payload["cases"]["staleImportAfterReopen"]["importedContactPresent"] is True
    assert payload["cases"]["staleSaveAfterReopen"]["draftPreserved"] is True
    assert payload["cases"]["staleSaveAfterReopen"]["staleRefreshIssued"] is False
    assert payload["cases"]["confirmAcceptedAfterOwnerLost"]["deleteRequests"] == 0
    assert payload["cases"]["staleDeleteAfterReopen"]["draftPreserved"] is True
    assert payload["cases"]["staleDeleteAfterReopen"]["staleRefreshIssued"] is False
    assert payload["cases"]["ownedDeleteControl"]["deletedA"] is True
