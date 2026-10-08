"""Browser regression for workspace skin and theme customization coexistence."""

import os
from pathlib import Path
import shutil
import subprocess

import pytest


_ROOT = Path(__file__).resolve().parents[1]


@pytest.mark.skipif(not shutil.which("node"), reason="node binary not on PATH")
def test_workspace_skin_preserves_customization_and_layout(tmp_path):
    helper = _ROOT / "tests/helpers/test_nx_workspace_skin_ui.cjs"
    playwright = os.environ.get("PLAYWRIGHT_PACKAGE")
    browser = os.environ.get("BROWSER_EXECUTABLE")
    if not playwright or not browser:
        pytest.skip("Set PLAYWRIGHT_PACKAGE and BROWSER_EXECUTABLE for browser checks")
    env = os.environ.copy()
    env.update({
        "PLAYWRIGHT_PACKAGE": str(playwright),
        "BROWSER_EXECUTABLE": str(browser),
        "NX_SKIN_SCREENSHOT_DIR": str(tmp_path),
    })
    proc = subprocess.run(
        ["node", str(helper)], capture_output=True, text=True, timeout=60, env=env,
    )
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert "PASS: NX workspace skin" in proc.stdout
    for screenshot in (
        "nx-skin-custom.png", "nx-skin-mobile.png",
        "nx-skin-welcome-desktop.png", "nx-skin-welcome-mobile.png",
        "nx-skin-settings-desktop.png", "nx-skin-settings-mobile.png",
        "nx-skin-theme-modal-desktop.png", "nx-skin-theme-modal-mobile.png",
    ):
        assert (tmp_path / screenshot).is_file(), f"missing screenshot: {screenshot}"
