from pathlib import Path
import shutil
import subprocess

import pytest


_REPO = Path(__file__).resolve().parent.parent
_HELPER = _REPO / "tests" / "helpers" / "test_email_numeric_font.cjs"
_PLAYWRIGHT = _REPO / "desktop" / "node_modules" / "playwright"


@pytest.mark.skipif(
    shutil.which("node") is None or not _PLAYWRIGHT.exists(),
    reason="Node.js and desktop Playwright are required",
)
def test_email_numbers_use_text_presentation_and_explicit_emoji_stays_emoji():
    result = subprocess.run(
        ["node", str(_HELPER)],
        cwd=_REPO,
        capture_output=True,
        text=True,
        timeout=30,
    )
    if result.returncode == 77:
        pytest.skip(result.stderr.strip())
    assert result.returncode == 0, result.stderr
