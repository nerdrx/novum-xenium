"""Opt-in synthetic browser coverage for attachment retry drafts."""
import os
from pathlib import Path
import shutil
import subprocess

import pytest


@pytest.mark.skipif(not shutil.which("node"), reason="node binary not on PATH")
def test_chat_upload_retry_prompt_ui():
    if not os.environ.get("PLAYWRIGHT_PACKAGE") or not os.environ.get("BROWSER_EXECUTABLE"):
        pytest.skip("Set PLAYWRIGHT_PACKAGE and BROWSER_EXECUTABLE for browser checks")
    root = Path(__file__).resolve().parents[1]
    result = subprocess.run(
        ["node", str(root / "tests/helpers/test_chat_upload_retry_prompt_ui.cjs")],
        capture_output=True, text=True, timeout=90, cwd=root,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert "PASS synthetic upload retry prompt" in result.stdout
