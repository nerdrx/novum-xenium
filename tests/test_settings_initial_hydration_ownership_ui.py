"""Opt-in actual-app proof for Settings initial hydration ownership."""
import os
from pathlib import Path
import subprocess

import pytest


def test_settings_initial_hydration_preserves_early_edits():
    if not os.environ.get("NOVUM_SETTINGS_HYDRATION_UI"):
        pytest.skip("Set NOVUM_SETTINGS_HYDRATION_UI=1 to run the synthetic browser proof")
    root = Path(__file__).resolve().parents[1]
    result = subprocess.run(
        ["node", str(root / "tests/helpers/test_settings_initial_hydration_ownership_ui.cjs")],
        capture_output=True, text=True, timeout=120, cwd=root,
        env={**os.environ, "SOURCE_ROOT": str(root)},
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert '"pass": true' in result.stdout, result.stdout
