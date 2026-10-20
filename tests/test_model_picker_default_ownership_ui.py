"""Opt-in actual-module default picker ownership and request deadline checks."""
import os
from pathlib import Path
import shutil
import subprocess

import pytest


@pytest.mark.skipif(not shutil.which("node"), reason="node binary not on PATH")
def test_default_picker_keeps_its_draft_and_recovers_after_timeout():
    if not os.environ.get("PLAYWRIGHT_PACKAGE") or not os.environ.get("BROWSER_EXECUTABLE"):
        pytest.skip("Set PLAYWRIGHT_PACKAGE and BROWSER_EXECUTABLE for browser checks")
    root = Path(__file__).resolve().parents[1]
    result = subprocess.run(
        ["node", str(root / "tests/helpers/test_model_picker_default_ownership_ui.cjs")],
        capture_output=True, text=True, timeout=45, cwd=root,
    )
    assert result.returncode == 0, result.stdout + result.stderr
