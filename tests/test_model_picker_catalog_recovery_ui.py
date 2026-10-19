"""Opt-in actual-module browser coverage for provider catalog recovery."""
import os
from pathlib import Path
import shutil
import subprocess

import pytest


@pytest.mark.skipif(not shutil.which("node"), reason="node binary not on PATH")
def test_model_picker_catalog_failure_and_recovery_ui():
    if not os.environ.get("PLAYWRIGHT_PACKAGE") or not os.environ.get("BROWSER_EXECUTABLE"):
        pytest.skip("Set PLAYWRIGHT_PACKAGE and BROWSER_EXECUTABLE for browser checks")
    root = Path(__file__).resolve().parents[1]
    result = subprocess.run(
        ["node", str(root / "tests/helpers/test_model_picker_catalog_recovery_ui.cjs")],
        capture_output=True, text=True, timeout=90, cwd=root,
        env=os.environ.copy(),
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert '"mode": "model-catalog-failure-recovery"' in result.stdout
