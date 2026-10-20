"""Actual-module loopback proof for account-scoped email draft UIDs."""

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[1]


@pytest.mark.skipif(not shutil.which("node"), reason="node binary not on PATH")
def test_email_draft_account_scope_loopback():
    playwright = os.environ.get("PLAYWRIGHT_PACKAGE")
    browser = os.environ.get("BROWSER_EXECUTABLE")
    if not playwright or not browser:
        pytest.skip("Set PLAYWRIGHT_PACKAGE and BROWSER_EXECUTABLE for browser checks")
    env = os.environ.copy()
    env.update({"PLAYWRIGHT_PACKAGE": playwright, "BROWSER_EXECUTABLE": browser})
    result = subprocess.run(
        ["node", "tests/helpers/test_email_draft_account_scope_ui.cjs"],
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
    assert payload["manualSave"]["afterSwitchToB"]["draft_account_id"] == "acct-A"
    assert payload["sendPreflight"]["accountBRecoveryDraft"]["draft_account_id"] == "acct-A"
    assert payload["sendPreflight"]["accountBSend"]["account_id"] == "acct-B"
    assert payload["sendPreflight"]["accountBSend"]["draft_account_id"] == "acct-IMAP"
    assert payload["sendPreflight"]["accountBSend"]["draft_mailbox_scope"] == "scope-acct-IMAP"
