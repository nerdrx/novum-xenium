"""Run the real sessions.js ownership regression against a loopback fixture."""

import json
import shutil
import subprocess
from pathlib import Path

import pytest


_HELPER = Path(__file__).parent / "helpers" / "test_session_list_load_ownership.cjs"


@pytest.mark.skipif(shutil.which("node") is None, reason="Node.js is required")
def test_session_list_load_ownership():
    result = subprocess.run(
        [shutil.which("node"), str(_HELPER)],
        capture_output=True,
        text=True,
        timeout=45,
        check=False,
    )
    assert result.returncode == 0, result.stderr or result.stdout
    payload = json.loads(result.stdout.splitlines()[-1])
    assert payload["pass"] is True
    assert payload["supersededCallerAdoptsLatestFailure"] is True
    assert payload["staleSuccessAfterLatestFailureIgnored"] is True
