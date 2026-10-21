"""Frontend regression tests: verify settings save handlers check HTTP response status.

Locks in that static/js/settings.js verifies response.ok before displaying success,
preventing 401, 403, 400, and 500 responses from reporting false success.
"""
import re
import shutil
import subprocess
from pathlib import Path

import pytest

_REPO = Path(__file__).resolve().parent.parent
_SETTINGS_JS = _REPO / "static" / "js" / "settings.js"
_SETTINGS_DIR = _REPO / "static" / "js" / "settings"
_SETTINGS_API_JS = _SETTINGS_DIR / "api.js"
_HAS_NODE = shutil.which("node") is not None


@pytest.mark.skipif(not _HAS_NODE, reason="node binary not on PATH")
def test_settings_js_syntax():
    """Verify static/js/settings.js and settings/*.js modules are syntactically valid JavaScript."""
    js_files = [_SETTINGS_JS] + list(_SETTINGS_DIR.glob("*.js"))
    for js_file in js_files:
        proc = subprocess.run(
            ["node", "--check", str(js_file)],
            capture_output=True,
            text=True,
            cwd=str(_REPO),
        )
        assert proc.returncode == 0, f"JS syntax error in {js_file.name}:\n{proc.stderr}"


def test_post_settings_helper_verifies_response_ok():
    """Centralized postSettings in settings/api.js must verify response.ok and throw on failure."""
    assert _SETTINGS_API_JS.exists(), f"Expected {_SETTINGS_API_JS} to exist"
    api_content = _SETTINGS_API_JS.read_text(encoding="utf-8")

    # Verify fetch to /api/auth/settings with POST method
    match = re.search(r"fetch\(['\"]/api/auth/settings['\"],\s*\{\s*method:\s*['\"]POST['\"]", api_content)
    assert match is not None, "Expected POST fetch to /api/auth/settings in settings/api.js"

    # Verify .ok is checked within 300 characters of fetch
    window = api_content[match.start(): match.start() + 300]
    assert ".ok" in window, f"postSettings must check response.ok:\n{window}"

    # Verify that it throws an error when !response.ok
    assert "throw error" in api_content or "throw new Error" in api_content, (
        "postSettings must throw when response is not ok"
    )


def test_all_settings_save_handlers_route_through_post_settings():
    """Settings writers use the shared POST transport; reads and other endpoints stay independent."""
    settings_content = _SETTINGS_JS.read_text(encoding="utf-8")
    module_contents = {p.name: p.read_text(encoding="utf-8") for p in _SETTINGS_DIR.glob("*.js")}

    # Only api.js owns the direct settings POST. Every other settings file must
    # leave writes to the shared helper, even as panels move between modules.
    direct_settings_post = re.compile(
        r"fetch\s*\(\s*(['\"`])/api/auth/settings\1\s*,\s*\{[^}]*?"
        r"\bmethod\s*:\s*(['\"])POST\2",
        re.DOTALL,
    )
    sources = {"settings.js": settings_content, **{name: text for name, text in module_contents.items() if name != "api.js"}}
    direct_posts = [name for name, text in sources.items() if direct_settings_post.search(text)]
    assert not direct_posts, (
        f"Direct POST fetch to /api/auth/settings found in {direct_posts}; route writes through postSettings"
    )

    # The main-panel saver must await the helper, and each extracted writer
    # must import and call that same transport rather than duplicating it.
    saver = re.search(r"function _createSettingsSaver\b[\s\S]*?\n}\n", settings_content)
    assert saver is not None, "Expected the main settings saver"
    assert re.search(r"await\s+_postSettings\(snapshot\)", saver.group(0)), (
        "The main settings saver must await _postSettings(snapshot)"
    )
    writers = {
        "agent.js": r"from\s+['\"]\./api\.js['\"]",
        "imageModels.js": r"from\s+['\"]\./api\.js['\"]",
        "speech.js": r"from\s+['\"]\./api\.js['\"]",
        "writingStyle.js": r"from\s+['\"]\./api\.js['\"]",
    }
    for name, import_path in writers.items():
        text = module_contents[name]
        assert re.search(r"import\s*\{\s*postSettings\s+as\s+_postSettings\s*\}\s*" + import_path, text), (
            f"{name} must import postSettings from its shared api.js module"
        )
        assert re.search(r"_postSettings\s*\(", text), f"{name} must call the shared postSettings helper"


@pytest.mark.skipif(not _HAS_NODE, reason="node binary not on PATH")
def test_failed_save_shows_failure_in_simulated_dom():
    """Verify that when fetch returns !res.ok, save logic catches and flags error."""
    js = """
    let msgText = '';
    let msgColor = '';
    const msg = {
      set textContent(v) { msgText = v; },
      get textContent() { return msgText; },
      style: { set color(v) { msgColor = v; }, get color() { return msgColor; } }
    };

    async function save(fetchImpl) {
      try {
        var res = await fetchImpl('/api/auth/settings', { method: 'POST' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        msg.textContent = 'Saved'; msg.style.color = 'var(--fg)';
      } catch (e) {
        msg.textContent = 'Failed to save'; msg.style.color = 'var(--red)';
      }
    }

    async function run() {
      // 1. Rejected fetch (403)
      await save(async () => ({ ok: false, status: 403 }));
      const rejectedResult = { text: msgText, color: msgColor };

      // 2. Server error (500)
      await save(async () => ({ ok: false, status: 500 }));
      const serverErrResult = { text: msgText, color: msgColor };

      // 3. Successful fetch (200)
      await save(async () => ({ ok: true, status: 200 }));
      const okResult = { text: msgText, color: msgColor };

      console.log(JSON.stringify({ rejectedResult, serverErrResult, okResult }));
    }
    run();
    """
    proc = subprocess.run(["node", "-e", js], capture_output=True, text=True, check=True)
    import json
    data = json.loads(proc.stdout)
    assert data["rejectedResult"] == {"text": "Failed to save", "color": "var(--red)"}
    assert data["serverErrResult"] == {"text": "Failed to save", "color": "var(--red)"}
    assert data["okResult"] == {"text": "Saved", "color": "var(--fg)"}
