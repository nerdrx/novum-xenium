import os
import subprocess
from pathlib import Path


def test_chat_predispatch_stop_ui():
    root = Path(__file__).resolve().parents[1]
    subprocess.run(
        ["node", str(root / "tests/helpers/test_chat_predispatch_stop_ui.cjs")],
        cwd=root,
        env=os.environ.copy(),
        check=True,
        timeout=45,
    )
