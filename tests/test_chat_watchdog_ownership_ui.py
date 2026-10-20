import os
from pathlib import Path
import subprocess


def test_chat_watchdog_preserves_newer_stream_and_navigation():
    root = Path(__file__).resolve().parents[1]
    subprocess.run(
        ["node", str(root / "tests/helpers/test_chat_watchdog_ownership_ui.cjs")],
        cwd=root, env=os.environ.copy(), check=True, timeout=45,
    )
