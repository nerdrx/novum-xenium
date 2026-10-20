"""Production-module account reconciliation and send ownership regressions.

The normal CI job installs Playwright and Chromium before pytest. These tests
use only synthetic pages and requests; no application server or model is used.
"""
from pathlib import Path
import shutil
import subprocess

import pytest


@pytest.mark.skipif(not shutil.which("node"), reason="node binary not on PATH")
def test_account_reconciliation_preserves_drafts_and_send_ownership():
    root = Path(__file__).resolve().parents[1]
    result = subprocess.run(
        ["node", "--test", "tests/startupAuthPendingDraftRace.test.mjs", "tests/chatAuthSendOwnership.test.mjs"],
        cwd=root, capture_output=True, text=True, timeout=90,
    )
    assert result.returncode == 0, result.stdout + result.stderr
