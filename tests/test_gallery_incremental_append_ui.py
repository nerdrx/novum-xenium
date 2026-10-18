import os
from pathlib import Path
import shutil
import subprocess

import pytest


@pytest.mark.skipif(not shutil.which("node"), reason="node binary not on PATH")
def test_gallery_load_more_preserves_existing_media_and_selection():
    if not all(os.environ.get(key) for key in ("PLAYWRIGHT_PACKAGE", "BROWSER_EXECUTABLE")):
        pytest.skip("Set PLAYWRIGHT_PACKAGE and BROWSER_EXECUTABLE for browser checks")
    root = Path(__file__).resolve().parents[1]
    result = subprocess.run(
        ["node", str(root / "tests/helpers/test_gallery_incremental_append_ui.cjs")],
        cwd=root, capture_output=True, text=True, timeout=60,
    )
    assert result.returncode == 0, result.stdout + result.stderr
