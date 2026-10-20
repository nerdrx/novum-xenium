"""Opt-in synthetic browser checks for sequential Compare Stop ownership."""
import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest


def test_compare_sequential_stop_does_not_advance_old_round():
    if not shutil.which("node"):
        pytest.skip("node binary not on PATH")
    playwright = os.environ.get("PLAYWRIGHT_PACKAGE")
    browser = os.environ.get("BROWSER_EXECUTABLE")
    if not playwright or not browser:
        pytest.skip("Set PLAYWRIGHT_PACKAGE and BROWSER_EXECUTABLE for browser checks")
    root = Path(__file__).resolve().parents[1]
    helper = root / "tests/helpers/test_compare_sequential_stop_ui.cjs"
    env = os.environ.copy()
    env.update({"PLAYWRIGHT_PACKAGE": playwright, "BROWSER_EXECUTABLE": browser,
                "NOVUM_REPO_ROOT": str(root)})
    result = subprocess.run(["node", str(helper)], cwd=root, env=env,
                            capture_output=True, text=True, timeout=90)
    assert result.returncode == 0, result.stdout + result.stderr
    summary = json.loads(result.stdout.strip().splitlines()[-1])
    assert summary["pass"] is True
    assert set(summary["cases"]) == {"sequentialPositive", "parallelPositive", "sequentialStop"}
