"""Synthetic mobile composer input-event regression checks."""
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]


@pytest.mark.skipif(not shutil.which("node"), reason="node binary not on PATH")
def test_mobile_composer_input_events_preserve_paste_and_composition():
    result = subprocess.run(
        ["node", "tests/helpers/test_mobile_composer_input_events.cjs"],
        cwd=ROOT, capture_output=True, text=True, timeout=20,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert "PASS: mobile composer paste/drop/composition" in result.stdout
