"""Fake DOM regression for prompt modal listener lifecycle."""
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]


@pytest.mark.skipif(not shutil.which("node"), reason="node binary not on PATH")
def test_prompt_modal_reopen_keeps_snapshot_and_listener_ownership():
    result = subprocess.run(
        ["node", "tests/helpers/test_preset_modal_listener_lifecycle.cjs"],
        cwd=ROOT, capture_output=True, text=True, timeout=20,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert "PASS: prompt modal listener lifecycle" in result.stdout
