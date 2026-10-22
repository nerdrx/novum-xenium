"""Opt-in actual-module browser regression for shared AI endpoint refresh deadline."""
import os
from pathlib import Path
import shutil
import subprocess

import pytest


@pytest.mark.skipif(not shutil.which("node"), reason="node binary not on PATH")
def test_ai_endpoint_refresh_deadline_ui():
    if not os.environ.get("PLAYWRIGHT_PACKAGE") or not os.environ.get("BROWSER_EXECUTABLE"):
        pytest.skip("Set PLAYWRIGHT_PACKAGE and BROWSER_EXECUTABLE for browser checks")
    root = Path(__file__).resolve().parents[1]
    result = subprocess.run(
        ["node", str(root / "tests/helpers/test_ai_endpoint_refresh_deadline_ui.cjs")],
        capture_output=True, text=True, timeout=90, cwd=root,
        env=os.environ.copy(),
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert '"mode": "ai-endpoint-refresh-deadline"' in result.stdout
