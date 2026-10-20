"""Actual-module browser proof for stale email draft activation ownership."""

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[1]


@pytest.mark.skipif(not shutil.which("node"), reason="node binary not on PATH")
def test_email_draft_open_ownership_loopback():
    playwright = os.environ.get("PLAYWRIGHT_PACKAGE")
    browser = os.environ.get("BROWSER_EXECUTABLE")
    if not playwright or not browser:
        pytest.skip("Set PLAYWRIGHT_PACKAGE and BROWSER_EXECUTABLE for browser checks")
    env = os.environ.copy()
    env.update({"PLAYWRIGHT_PACKAGE": playwright, "BROWSER_EXECUTABLE": browser})
    result = subprocess.run(
        ["node", "tests/helpers/test_email_draft_open_ownership_ui.cjs"],
        capture_output=True,
        text=True,
        timeout=90,
        cwd=_ROOT,
        env=env,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    payload = json.loads(result.stdout.strip().splitlines()[-1])
    assert payload["pass"] is True
    assert payload["externalRequests"] == 0
    cases = payload["results"]
    assert cases["staleReadError"]["posts"] == 0
    assert cases["stalePost"]["localRecoveryPreserved"] is True
    assert cases["accountABA"]["currentDoc"] is None
    assert cases["inboxCallerABA"]["currentDoc"] is None
    assert cases["newerDraft"]["currentDoc"] == "fixture-doc-1"
    assert cases["staleJson"]["currentDoc"] is None
    assert cases["stalePostError"]["staleErrorShown"] is False
    assert cases["staleAnimationFrame"]["localRecoveryPreserved"] is True
    assert cases["sameContext"]["localRecoveryCleared"] is True
