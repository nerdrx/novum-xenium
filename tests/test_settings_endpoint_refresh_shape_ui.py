"""Opt-in actual-module settings endpoint shape recovery check."""
import os
from pathlib import Path
import shutil
import subprocess

import pytest


def test_settings_endpoint_refresh_rejects_malformed_inventory():
    if not os.environ.get("PLAYWRIGHT_PACKAGE") or not os.environ.get("BROWSER_EXECUTABLE"):
        pytest.skip("Set PLAYWRIGHT_PACKAGE and BROWSER_EXECUTABLE for browser checks")
    root = Path(__file__).resolve().parents[1]
    result = subprocess.run(
        ["node", str(root / "tests/helpers/test_settings_endpoint_refresh_shape_ui.cjs")],
        capture_output=True, text=True, timeout=60, cwd=root,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert "PASS: malformed endpoint inventory preserves selections" in result.stdout
