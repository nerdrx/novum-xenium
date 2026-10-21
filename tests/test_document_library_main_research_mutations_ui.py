"""Opt-in synthetic-browser checks for Main Research mutation outcomes."""
import json
import os
from pathlib import Path
import shutil
import subprocess

import pytest


@pytest.mark.skipif(not shutil.which("node"), reason="node binary not on PATH")
def test_main_research_mutations_report_failures_and_preserve_current_selection():
    playwright = os.environ.get("PLAYWRIGHT_PACKAGE")
    browser = os.environ.get("BROWSER_EXECUTABLE")
    if not playwright or not browser:
        pytest.skip("Set PLAYWRIGHT_PACKAGE and BROWSER_EXECUTABLE for browser checks")
    root = Path(__file__).resolve().parents[1]
    env = os.environ.copy()
    env.update({"PLAYWRIGHT_PACKAGE": playwright, "BROWSER_EXECUTABLE": browser, "SOURCE_ROOT": str(root)})
    result = subprocess.run(
        ["node", str(root / "tests/helpers/test_document_library_main_research_mutations_ui.cjs")],
        capture_output=True, text=True, timeout=120, cwd=root, env=env,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    evidence = json.loads(result.stdout.strip().splitlines()[-1])
    assert evidence["result"] == "confirmed"
    for control in (
        "previewDeleteRetry", "previewArchiveRetry", "menuArchiveRetry", "menuDeleteRetry",
        "heldConfirmTargetsAAndPreservesB", "partialBulkDeletePreservesFailure",
        "heldResponsePreservesNewSelection",
        "partialBulkArchivePreservesFailure", "tidyPartial", "tidyKeepsEmptySelectMode",
        "heldCompletionKeepsReenteredEmptySelectMode", "cancelSendsNothing", "bulkSuccess",
    ):
        assert evidence[control] is True
    assert evidence["unexpected"] == []
    assert evidence["external"] == []
    assert evidence["pageErrors"] == []
