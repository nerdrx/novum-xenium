"""Keep the persona name and reasoning through real detached-stream replay."""

import os
import subprocess
from pathlib import Path
import pytest

_REPO = Path(__file__).resolve().parents[1]

def _run_case(name):
    if not os.environ.get("PLAYWRIGHT_PACKAGE") or not os.environ.get("BROWSER_EXECUTABLE"):
        pytest.skip("Set browser and Playwright paths for the production-module lifecycle check")
    result = subprocess.run(["node", "tests/helpers/test_chat_resume_lifecycle_ui.cjs", name],
                            cwd=_REPO, capture_output=True, text=True, timeout=45)
    assert result.returncode == 0, result.stdout + result.stderr
    assert f"PASS resume lifecycle {name}" in result.stdout

def test_resume_replays_persona_name_into_live_and_final_bubble():
    _run_case("persona")
