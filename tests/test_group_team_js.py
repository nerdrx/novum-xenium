"""Exercise the real Group Team controller in Node without network calls."""
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]


@pytest.mark.parametrize("scenario", ["prompts", "persistence", "ownership", "stop", "save-fail", "save-order", "load-race"])
def test_group_team_controller(scenario):
    if not shutil.which("node"):
        pytest.skip("node is not installed")
    result = subprocess.run(
        ["node", "--experimental-default-type=module", "tests/helpers/test_group_team.js", scenario],
        text=True, capture_output=True, cwd=ROOT, timeout=15,
    )
    assert result.returncode == 0, result.stderr
