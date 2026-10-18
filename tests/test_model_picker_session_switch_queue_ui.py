"""Opt-in synthetic browser regression for per-session model-switch promises."""
import os
from pathlib import Path
import shutil
import subprocess

import pytest


@pytest.mark.skipif(not shutil.which("node"), reason="node binary not on PATH")
def test_model_picker_exposes_independent_pending_switch_by_session():
    if not os.environ.get("PLAYWRIGHT_PACKAGE") or not os.environ.get("BROWSER_EXECUTABLE"):
        pytest.skip("Set PLAYWRIGHT_PACKAGE and BROWSER_EXECUTABLE for browser checks")
    root = Path(__file__).resolve().parents[1]
    result = subprocess.run(
        ["node", str(root / "tests/helpers/test_model_picker_session_switch_queue_ui.cjs")],
        capture_output=True, text=True, timeout=45, cwd=root,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert '"mode": "per-session-model-switch-queue"' in result.stdout
