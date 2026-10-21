"""Opt-in synthetic-browser coverage for Main Research collection loading."""
import json
import os
from pathlib import Path
import shutil
import subprocess

import pytest


@pytest.mark.skipif(not shutil.which("node"), reason="node binary not on PATH")
def test_main_research_load_preserves_cache_and_recovers():
    playwright = os.environ.get("PLAYWRIGHT_PACKAGE")
    browser = os.environ.get("BROWSER_EXECUTABLE")
    if not playwright or not browser:
        pytest.skip("Set PLAYWRIGHT_PACKAGE and BROWSER_EXECUTABLE for browser checks")
    root = Path(__file__).resolve().parents[1]
    env = os.environ.copy()
    env.update({"PLAYWRIGHT_PACKAGE": playwright, "BROWSER_EXECUTABLE": browser, "SOURCE_ROOT": str(root)})
    result = subprocess.run(
        ["node", str(root / "tests/helpers/test_document_library_research_load_recovery_ui.cjs")],
        capture_output=True, text=True, timeout=120, cwd=root, env=env,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    evidence = json.loads(result.stdout.strip().splitlines()[-1])
    assert evidence["pass"] is True
    for control in (
        "normalWrappedSuccess", "malformedKeepsLastGoodAndShowsAccessibleRetry", "retryRecovers",
        "http503PreservesCache", "validEmptyRemainsEmptyControl", "legacyBareArrayStillLoads",
        "lateOldLoadCannotOverwriteNewerSameGrid", "detachedOldLoadCannotPaintReopenedGrid",
        "heldJsonDeadlineAbortsNativeRequestAndPreservesCache",
        "staleEarlyReturnAbortsUnreadBodyAndKeepsNewOwnerUI",
        "http503EarlyFailureAbortsUnreadBodyAndKeepsCache",
    ):
        assert evidence["result"][control] is True
    assert evidence["external"] == []
    assert evidence["unexpected"] == []
    assert evidence["pageErrors"] == []
