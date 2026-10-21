"""Opt-in actual-module browser coverage for gallery upload failures."""
import json
import os
from pathlib import Path
import shutil
import subprocess

import pytest

ROOT = Path(__file__).resolve().parents[1]


@pytest.mark.skipif(not shutil.which("node"), reason="node binary not on PATH")
def test_gallery_bulk_upload_errors_ui():
    playwright = os.environ.get("PLAYWRIGHT_PACKAGE")
    browser = os.environ.get("BROWSER_EXECUTABLE")
    if not playwright or not browser:
        pytest.skip("Set PLAYWRIGHT_PACKAGE and BROWSER_EXECUTABLE for browser checks")
    env = os.environ.copy()
    env.update({"PLAYWRIGHT_PACKAGE": playwright, "BROWSER_EXECUTABLE": browser, "SOURCE_ROOT": str(ROOT)})
    result = subprocess.run(
        ["node", str(ROOT / "tests/helpers/test_gallery_bulk_upload_errors_ui.cjs")],
        capture_output=True,
        text=True,
        timeout=90,
        cwd=ROOT,
        env=env,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    evidence = json.loads(result.stdout)
    assert evidence["pass"] is True
    assert evidence["pageErrors"] == []
    assert evidence["externalRequests"] == []
