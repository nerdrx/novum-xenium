"""Opt-in UI coverage for voice cleanup when entering Compare."""
import json
import os
from pathlib import Path
import shutil
import subprocess

import pytest

ROOT = Path(__file__).resolve().parents[1]


@pytest.mark.skipif(not shutil.which("node"), reason="node binary not on PATH")
def test_compare_voice_transition_ui():
    playwright = os.environ.get("PLAYWRIGHT_PACKAGE")
    browser = os.environ.get("BROWSER_EXECUTABLE")
    if not playwright or not browser:
        pytest.skip("Set PLAYWRIGHT_PACKAGE and BROWSER_EXECUTABLE for browser checks")
    env = os.environ.copy()
    env.update({
        "SOURCE_ROOT": str(ROOT),
        "PLAYWRIGHT_PACKAGE": playwright,
        "BROWSER_EXECUTABLE": browser,
    })
    result = subprocess.run(
        ["node", str(ROOT / "tests/helpers/test_compare_voice_transition_ui.cjs")],
        capture_output=True,
        text=True,
        timeout=120,
        cwd=ROOT,
        env=env,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    evidence = json.loads(result.stdout)
    assert evidence["pass"] is True
    assert evidence["externalRequests"] == []
    assert evidence["unexpectedPageErrors"] == []
