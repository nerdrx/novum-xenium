import os
from pathlib import Path
import subprocess

import pytest


def test_saved_vision_model_remains_visible_when_missing_from_inventory():
    if not os.environ.get("NOVUM_VISION_SAVED_MODEL_UI"):
        pytest.skip("Set NOVUM_VISION_SAVED_MODEL_UI=1 to run the synthetic browser proof")
    root = Path(__file__).resolve().parents[1]
    result = subprocess.run(
        ["node", str(root / "tests/helpers/test_vision_saved_model_display_ui.cjs")],
        capture_output=True, text=True, timeout=90, cwd=root,
        env={**os.environ, "SOURCE_ROOT": str(root)},
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert '"pass": true' in result.stdout, result.stdout
