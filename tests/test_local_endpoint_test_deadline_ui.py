"""Opt-in actual-module browser regression for local endpoint Test deadlines."""
import os
from pathlib import Path
import shutil
import subprocess

import pytest


@pytest.mark.skipif(not shutil.which("node"), reason="node binary not on PATH")
def test_local_endpoint_test_deadline_ui():
    if not os.environ.get("PLAYWRIGHT_PACKAGE") or not os.environ.get("BROWSER_EXECUTABLE"):
        pytest.skip("Set PLAYWRIGHT_PACKAGE and BROWSER_EXECUTABLE for browser checks")
    root = Path(__file__).resolve().parents[1]
    result = subprocess.run(
        ["node", str(root / "tests/helpers/test_local_endpoint_test_deadline_ui.cjs")],
        capture_output=True, text=True, timeout=90, cwd=root, env=os.environ.copy(),
    )
    assert result.returncode == 0, result.stdout + result.stderr
    for control in (
        "headersTimeout", "bodyTimeout", "successTimerCleared", "retrySuccess",
        "staleDraftTimeoutSuppressed", "loopbackOnly",
    ):
        assert f'"{control}":true' in result.stdout
