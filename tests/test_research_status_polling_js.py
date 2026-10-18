"""Exercise retry and terminal handling for research-status polling."""
import shutil
import subprocess
from pathlib import Path

import pytest


_REPO = Path(__file__).resolve().parents[1]


@pytest.mark.skipif(not shutil.which("node"), reason="node is not installed")
def test_research_status_polling_retries_transient_failures_and_clears_terminal_states():
    result = subprocess.run(
        ["node", "--test", "tests/researchStatusPolling.test.mjs"],
        capture_output=True,
        text=True,
        cwd=_REPO,
        timeout=30,
    )
    assert result.returncode == 0, result.stdout + result.stderr
