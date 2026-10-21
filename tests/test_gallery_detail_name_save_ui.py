"""Enter and blur save the Gallery detail name through one request."""

import os
from pathlib import Path
import shutil
import subprocess

import pytest


_ROOT = Path(__file__).resolve().parents[1]


@pytest.mark.skipif(not shutil.which("node"), reason="node binary not on PATH")
def test_gallery_detail_name_enter_blur_and_retry():
    playwright = os.environ.get("PLAYWRIGHT_PACKAGE")
    browser = os.environ.get("BROWSER_EXECUTABLE")
    if not playwright or not browser:
        pytest.skip("Set PLAYWRIGHT_PACKAGE and BROWSER_EXECUTABLE for browser checks")
    env = os.environ.copy()
    env.update({"PLAYWRIGHT_PACKAGE": playwright, "BROWSER_EXECUTABLE": browser})
    result = subprocess.run(
        ["node", "tests/helpers/test_gallery_detail_name_save_ui.cjs"],
        capture_output=True,
        text=True,
        timeout=45,
        cwd=_ROOT,
        env=env,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert '"pass": true' in result.stdout
