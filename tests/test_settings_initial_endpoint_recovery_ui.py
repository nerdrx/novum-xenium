"""Opt-in actual-app coverage for saved endpoint recovery after startup timeout."""
import json
import os
from pathlib import Path
import shutil
import subprocess

import pytest


@pytest.mark.skipif(not shutil.which("node"), reason="node binary not on PATH")
def test_settings_initial_endpoint_recovery_ui():
    if not os.environ.get("PLAYWRIGHT_PACKAGE") or not os.environ.get("BROWSER_EXECUTABLE"):
        pytest.skip("Set PLAYWRIGHT_PACKAGE and BROWSER_EXECUTABLE for browser checks")
    root = Path(__file__).resolve().parents[1]
    result = subprocess.run(
        ["node", str(root / "tests/helpers/test_settings_initial_endpoint_recovery_ui.cjs")],
        capture_output=True, text=True, timeout=180, cwd=root,
        env=os.environ.copy(),
    )
    assert result.returncode == 0, result.stdout + result.stderr
    report = json.loads(result.stdout)
    assert report.get("pass") is True, result.stdout
