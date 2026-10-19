"""Opt-in actual-module browser regression for fresh-chat destination ownership."""
import os
from pathlib import Path
import shutil
import subprocess

import pytest


@pytest.mark.skipif(not shutil.which("node"), reason="node binary not on PATH")
def test_fresh_chat_initialization_does_not_retarget_send(tmp_path):
    playwright = os.environ.get("PLAYWRIGHT_PACKAGE")
    browser = os.environ.get("BROWSER_EXECUTABLE")
    if not playwright or not browser:
        pytest.skip("Set PLAYWRIGHT_PACKAGE and BROWSER_EXECUTABLE for browser checks")
    root = Path(__file__).resolve().parents[1]
    env = os.environ.copy()
    env.update({
        "PLAYWRIGHT_PACKAGE": playwright,
        "BROWSER_EXECUTABLE": browser,
        "EVIDENCE_DIR": str(tmp_path),
    })
    result = subprocess.run(
        ["node", str(root / "tests/helpers/test_chat_fresh_init_destination_ui.cjs")],
        capture_output=True, text=True, timeout=90, cwd=root, env=env,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert '"pass": true' in result.stdout
    assert (tmp_path / "fresh-init-results.json").is_file()
