"""Opt-in full-app check for page-only composer drafts."""
import json
import os
from pathlib import Path
import shutil
import subprocess

import pytest

ROOT = Path(__file__).resolve().parents[1]


@pytest.mark.skipif(not shutil.which("node"), reason="node binary not on PATH")
def test_anonymous_composer_draft_history_ui():
    playwright = os.environ.get("PLAYWRIGHT_PACKAGE")
    browser = os.environ.get("BROWSER_EXECUTABLE")
    if not playwright or not browser:
        pytest.skip("Set PLAYWRIGHT_PACKAGE and BROWSER_EXECUTABLE for browser checks")
    env = os.environ.copy()
    env.update({"PLAYWRIGHT_PACKAGE": playwright, "BROWSER_EXECUTABLE": browser})
    result = subprocess.run(
        ["node", str(ROOT / "tests/helpers/test_anonymous_composer_drafts_ui.cjs")],
        capture_output=True,
        text=True,
        timeout=120,
        cwd=ROOT,
        env=env,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    evidence = json.loads(result.stdout)
    assert evidence["pass"] is True
    assert evidence["pageErrors"] == []
    assert evidence["externalRequests"] == []
    assert evidence["cases"]["verifiedAnonymous"]["restored"]["localKeys"] == []
    assert evidence["cases"]["authUnavailableThenVerified"]["adopted"]["text"] == "draft A unavailable"
    assert evidence["cases"]["verifiedAnonymousIncognito"]["restored"]["text"] == "draft A anonymous-incognito"
    collision = evidence["cases"]["incognitoCollisionAndSwitchGuard"]
    assert collision["restoredAfterVerify"]["stored"] == '{"text":"pre-existing account draft"}'
    assert collision["switchedRestore"]["restored"] is False
    assert collision["switchedRestore"]["stored"] == collision["restoredAfterVerify"]["stored"]
