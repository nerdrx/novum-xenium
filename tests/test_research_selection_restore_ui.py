"""Opt-in actual-module loopback coverage for Deep Research settings ownership."""
import json
import os
from pathlib import Path
import shutil
import subprocess

import pytest


def test_research_settings_restore_respects_newer_user_intent():
    node = shutil.which("node")
    if not node or not os.environ.get("PLAYWRIGHT_PACKAGE") or not os.environ.get("BROWSER_EXECUTABLE"):
        pytest.skip("Set node, PLAYWRIGHT_PACKAGE, and BROWSER_EXECUTABLE for browser checks")

    root = Path(__file__).resolve().parents[1]
    result = subprocess.run(
        [node, str(root / "tests/helpers/test_research_selection_restore_ui.cjs")],
        cwd=root,
        env=os.environ.copy(),
        capture_output=True,
        text=True,
        timeout=90,
        check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    summary = json.loads(result.stdout.strip().splitlines()[-1])
    assert summary["pass"] is True
    assert {case["name"] for case in summary["results"]} == {
        "defaultRestore", "heldUserSelection", "heldResponseBody",
        "heldSelectionAba", "heldJobEdit", "heldEndpointLoadEdit",
        "heldEndpointLoadNewerJobEdit", "closeReopenDropsOldEndpointResponse",
        "queueEditedJobBeforeEndpointRelease",
        "endpointHttpFailureRestoresLocalSettings",
    }
