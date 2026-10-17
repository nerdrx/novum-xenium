"""Exercise mobile streaming and deliberate drawer interactions in Chromium."""
import shutil
import subprocess
from pathlib import Path

import pytest


@pytest.mark.skipif(shutil.which("node") is None, reason="Node is unavailable")
def test_mobile_streaming_and_menu_interactions():
    root = Path(__file__).resolve().parents[1]
    result = subprocess.run(
        ["node", "tests/helpers/test_mobile_responsiveness_ui.cjs"],
        cwd=root, capture_output=True, text=True, timeout=90,
    )
    assert result.returncode == 0, result.stdout + result.stderr
