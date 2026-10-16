from pathlib import Path
import re


_ROOT = Path(__file__).resolve().parents[1]


def test_new_app_shell_modules_are_precached_for_offline_imports():
    app_shell = (_ROOT / "static/js/settings.js").read_text(encoding="utf-8")
    service_worker = (_ROOT / "static/sw.js").read_text(encoding="utf-8")
    imported = re.findall(r"from\s+['\"](\./[^'\"]+\.mjs)['\"]", app_shell)
    assert "./settings/nativePush.mjs" in imported
    assert "'/static/js/settings/nativePush.mjs'" in service_worker
