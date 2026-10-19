import os
import subprocess
import shutil

import pytest
from pathlib import Path


@pytest.mark.skipif(not shutil.which("node"), reason="node binary not on PATH")
def test_chat_default_chat_deadline_ui():
    if not os.environ.get("PLAYWRIGHT_PACKAGE") or not os.environ.get("BROWSER_EXECUTABLE"):
        pytest.skip("Set PLAYWRIGHT_PACKAGE and BROWSER_EXECUTABLE for browser checks")
    root = Path(__file__).resolve().parents[1]
    subprocess.run(
        ["node", str(root / "tests/helpers/test_chat_default_chat_deadline_ui.cjs")],
        cwd=root,
        env=os.environ.copy(),
        check=True,
        timeout=60,
    )
