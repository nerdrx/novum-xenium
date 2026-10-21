"""Opt-in actual-module browser coverage for integration-list load recovery."""
import json
import os
from pathlib import Path
import shutil
import subprocess

import pytest

ROOT = Path(__file__).resolve().parents[1]


def _run_helper(name: str, env: dict[str, str]) -> dict:
    result = subprocess.run(
        ["node", str(ROOT / "tests/helpers" / name)],
        capture_output=True,
        text=True,
        timeout=90,
        cwd=ROOT,
        env=env,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    return json.loads(result.stdout)


@pytest.mark.skipif(not shutil.which("node"), reason="node binary not on PATH")
def test_unified_integrations_load_recovery_ui():
    playwright = os.environ.get("PLAYWRIGHT_PACKAGE")
    browser = os.environ.get("BROWSER_EXECUTABLE")
    if not playwright or not browser:
        pytest.skip("Set PLAYWRIGHT_PACKAGE and BROWSER_EXECUTABLE for browser checks")
    env = os.environ.copy()
    env.update({"PLAYWRIGHT_PACKAGE": playwright, "BROWSER_EXECUTABLE": browser})

    recovery = _run_helper("test_unified_integrations_load_recovery.cjs", env)
    assert recovery["pass"] is True
    assert recovery["pageErrors"] == []
    assert recovery["externalRequests"] == []
    assert recovery["result"]["heldFetch"]["requestAborted"] is True
    assert recovery["result"]["heldJson"]["requestAborted"] is True

    race = _run_helper("test_unified_integrations_retry_save_race.cjs", env)
    assert race["pass"] is True
    assert race["race"]["oldRefreshOverwroteSavedName"] is False
    assert race["normalControl"]["cardVisible"] is True
    assert race["pageErrors"] == []
    assert race["externalRequests"] == []
