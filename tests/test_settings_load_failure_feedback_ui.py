import os
from pathlib import Path
import subprocess

import pytest


def test_settings_load_failures_preserve_owned_save_feedback():
    if not os.environ.get("NOVUM_SETTINGS_LOAD_FEEDBACK_UI"):
        pytest.skip("Set NOVUM_SETTINGS_LOAD_FEEDBACK_UI=1 to run the synthetic browser proof")
    root = Path(__file__).resolve().parents[1]
    result = subprocess.run(
        ["node", str(root / "tests/helpers/test_settings_load_failure_feedback_ui.cjs")],
        capture_output=True, text=True, timeout=90, cwd=root,
        env={**os.environ, "SOURCE_ROOT": str(root)},
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert '"pass": true' in result.stdout, result.stdout
