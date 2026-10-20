import os
import shutil
import subprocess
from pathlib import Path

import pytest


@pytest.mark.skipif(not shutil.which("node"), reason="node binary not on PATH")
def test_project_workflow_workspace_selection_callback_ui():
    playwright = os.environ.get("PLAYWRIGHT_PACKAGE")
    browser = os.environ.get("BROWSER_EXECUTABLE")
    if not playwright or not browser:
        pytest.skip("Set PLAYWRIGHT_PACKAGE and BROWSER_EXECUTABLE for browser checks")
    env = os.environ.copy()
    env.update({"PLAYWRIGHT_PACKAGE": playwright, "BROWSER_EXECUTABLE": browser})
    helper = Path(__file__).parent / "helpers" / "test_project_workflow_ui.cjs"
    proc = subprocess.run(["node", str(helper)], capture_output=True, text=True, timeout=60, env=env)
    assert proc.returncode == 0, proc.stdout + proc.stderr
