"""Source-bound regression coverage for the document copy fallback result."""
import json
from pathlib import Path
import shutil
import subprocess

import pytest


ROOT = Path(__file__).resolve().parents[1]


@pytest.mark.skipif(not shutil.which("node"), reason="node binary not on PATH")
def test_document_copy_clipboard_fallback():
    result = subprocess.run(
        ["node", str(ROOT / "tests/helpers/test_document_copy_clipboard_fallback.cjs")],
        capture_output=True,
        text=True,
        timeout=10,
        cwd=ROOT,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    evidence = json.loads(result.stdout)
    assert evidence["pass"] is True
