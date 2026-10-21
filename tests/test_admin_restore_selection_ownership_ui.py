"""Optional actual-module browser regression for restore preview ownership."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import pytest


def test_admin_restore_selection_ownership_ui():
    if not os.environ.get("PLAYWRIGHT_PACKAGE") or not os.environ.get("BROWSER_EXECUTABLE"):
        pytest.skip("Set PLAYWRIGHT_PACKAGE and BROWSER_EXECUTABLE for browser checks")
    if not shutil.which("node"):
        pytest.skip("Node is required for browser checks")
    helper = Path(__file__).parent / "helpers/test_admin_restore_selection_ownership_ui.cjs"
    result = subprocess.run(["node", str(helper)], capture_output=True, text=True, timeout=60, check=True)
    assert json.loads(result.stdout)["pass"] is True
