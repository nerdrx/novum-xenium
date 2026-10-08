"""Default Novum Xenium branding is scoped, usable, and branded across entry points."""

import os
from pathlib import Path
import shutil
import subprocess

import pytest


_ROOT = Path(__file__).resolve().parents[1]
_THEME = (_ROOT / "static/js/theme.js").read_text(encoding="utf-8")
_INDEX = (_ROOT / "static/index.html").read_text(encoding="utf-8")
_MANIFEST = (_ROOT / "static/manifest.json").read_text(encoding="utf-8")


def test_default_brand_and_theme_keep_internal_storage_key():
    assert "const DEFAULT_THEME = 'novum-xenium';" in _THEME
    assert "const LS_KEY = 'odysseus-theme';" in _THEME
    assert "'novum-xenium': 'none'" in _THEME
    assert "const DEFAULT_FONT = 'sans';" in _THEME
    assert "const LEGACY_DEFAULT_FONT = 'mono';" in _THEME
    assert "opts.font !== _defaultFontForTheme(name)" in _THEME
    assert "opts.font || _defaultFontForTheme(slug)" in _THEME
    assert "const _initFont = (saved && saved.font) || _defaultFontForTheme(_initTheme);" in _THEME
    assert "Novum Xenium" in _INDEX
    assert "odysseus-theme" in _INDEX
    assert '"name": "Novum Xenium"' in _MANIFEST
    assert '"short_name": "Novum Xenium"' in _MANIFEST


@pytest.mark.skipif(not shutil.which("node"), reason="node binary not on PATH")
def test_default_brand_has_no_mobile_or_desktop_overflow(tmp_path):
    helper = _ROOT / "tests/helpers/test_novum_xenium_branding_ui.cjs"
    playwright = os.environ.get("PLAYWRIGHT_PACKAGE")
    browser = os.environ.get("BROWSER_EXECUTABLE")
    if not playwright or not browser:
        pytest.skip("Set PLAYWRIGHT_PACKAGE and BROWSER_EXECUTABLE for browser checks")
    env = os.environ.copy()
    env.update({
        "PLAYWRIGHT_PACKAGE": str(playwright),
        "BROWSER_EXECUTABLE": str(browser),
        "NOVUM_SCREENSHOT_DIR": str(tmp_path),
    })
    proc = subprocess.run(
        ["node", str(helper)], capture_output=True, text=True, timeout=30, env=env,
    )
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert "PASS: Novum Xenium defaults" in proc.stdout
    assert (tmp_path / "novum-xenium-desktop.png").is_file()
    assert (tmp_path / "novum-xenium-mobile.png").is_file()
