"""Run model picker save/recovery checks in a disposable browser fixture."""
import os
from pathlib import Path
import shutil
import subprocess

import pytest


ROOT = Path(__file__).resolve().parents[1]


def test_model_picker_save_recovery_ui():
    playwright = os.environ.get("PLAYWRIGHT_PACKAGE")
    browser = os.environ.get("BROWSER_EXECUTABLE")
    node = shutil.which("node")
    if not (playwright and browser and node):
        pytest.skip("Set Node, PLAYWRIGHT_PACKAGE and BROWSER_EXECUTABLE for browser checks")
    env = os.environ.copy()
    env.update({"PLAYWRIGHT_PACKAGE": playwright, "BROWSER_EXECUTABLE": browser})
    subprocess.run(
        [node, str(ROOT / "tests/helpers/test_model_picker_save_recovery_ui.cjs")],
        cwd=ROOT,
        env=env,
        check=True,
        timeout=90,
    )
