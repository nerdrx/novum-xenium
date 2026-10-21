"""Opt-in synthetic-browser coverage for archived Library mutation outcomes."""
import json
import os
from pathlib import Path
import shutil
import subprocess

import pytest


@pytest.mark.skipif(not shutil.which("node"), reason="node binary not on PATH")
def test_archive_mutations_report_failures_and_preserve_selection():
    if not os.environ.get("PLAYWRIGHT_PACKAGE") or not os.environ.get("BROWSER_EXECUTABLE"):
        pytest.skip("Set PLAYWRIGHT_PACKAGE and BROWSER_EXECUTABLE for browser checks")
    root = Path(__file__).resolve().parents[1]
    result = subprocess.run(
        ["node", str(root / "tests/helpers/test_document_library_archive_mutations_ui.cjs")],
        capture_output=True, text=True, timeout=120, cwd=root, env=os.environ.copy(),
    )
    assert result.returncode == 0, result.stdout + result.stderr
    evidence = json.loads(result.stdout.strip().splitlines()[-1])
    assert evidence["result"] == "confirmed"
    for control in (
        "archiveMutationFailuresVisible",
        "researchPreviewFailuresAndRetries",
        "partialBulkResultsPreserveFailedSelection",
        "successfulRetryRemovesRows",
        "chatDeleteKeepsSessionHelper",
        "heldConfirmTargetsSnapshotA",
        "newerSelectionSurvivesCompletion",
        "cancelDispatchesNoMutation",
    ):
        assert evidence[control] is True
    assert evidence["unmatched"] == []
    assert evidence["pageErrors"] == []
