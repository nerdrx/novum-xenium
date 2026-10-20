"""Synthetic browser coverage for main-chat terminal tool-node ownership."""

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest


def test_mainchat_terminal_tool_cleanup_is_stream_owned():
    node = shutil.which("node")
    playwright = os.environ.get("PLAYWRIGHT_PACKAGE")
    browser = os.environ.get("BROWSER_EXECUTABLE")
    if not node or not playwright or not browser:
        pytest.skip("Set node, PLAYWRIGHT_PACKAGE, and BROWSER_EXECUTABLE for browser checks")

    root = Path(__file__).resolve().parents[1]
    helper = root / "tests/helpers/test_mainchat_terminal_tools_ui.cjs"
    result = subprocess.run(
        [node, str(helper)],
        cwd=root,
        env=os.environ.copy(),
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    summary = json.loads(result.stdout.strip().splitlines()[-1])
    assert summary["pass"] is True
    assert set(summary["results"]) == {
        "singleEof", "twoStartsEof", "normalReceipt", "ownedAWhileBRunning", "pendingApproval",
    }
