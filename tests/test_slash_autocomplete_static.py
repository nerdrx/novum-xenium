"""Static regressions for slash autocomplete command-group expansion."""

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest


_REPO = Path(__file__).resolve().parent.parent
_AC = (_REPO / "static" / "js" / "slashAutocomplete.js").read_text(encoding="utf-8")
_RECOVERY_HELPER = _REPO / "tests" / "helpers" / "test_slash_autocomplete_recovery.mjs"


def test_exact_parent_command_expands_subcommands_before_top_level_row_cap():
    assert "function _exactCommandGroupItems" in _AC
    assert "entry.token.toLowerCase().startsWith(prefix)" in _AC
    assert "items = groupItems.slice(0, MAX_VISIBLE);" in _AC


def test_setup_group_has_room_for_chatgpt_subscription_suggestion():
    assert "const MAX_VISIBLE = 14;" in _AC


def test_skill_autocomplete_recovers_after_transient_catalog_failure():
    if not shutil.which("node"):
        pytest.skip("node binary not on PATH")
    playwright = os.environ.get("PLAYWRIGHT_PACKAGE")
    browser = os.environ.get("BROWSER_EXECUTABLE")
    if not playwright or not browser:
        pytest.skip("Set PLAYWRIGHT_PACKAGE and BROWSER_EXECUTABLE for browser checks")
    env = os.environ.copy()
    env.update({"PLAYWRIGHT_PACKAGE": playwright, "BROWSER_EXECUTABLE": browser})
    proc = subprocess.run(
        ["node", str(_RECOVERY_HELPER)],
        capture_output=True,
        text=True,
        cwd=str(_REPO),
        timeout=20,
        env=env,
    )
    assert proc.returncode == 0, proc.stderr
    out = json.loads(proc.stdout.strip())
    assert out["results"]["httpFailureRetry"]["skillSuggestionRecovered"] is True
    assert out["results"]["httpFailureRetry"]["inFlightDeduped"] is True
    assert out["results"]["httpFailureRetry"]["dismissedPopupStayedClosed"] is True
    assert out["results"]["malformedJsonRetry"]["skillSuggestionRecovered"] is True
    assert out["results"]["emptySuccess"]["requestCount"] == 1
    assert out["results"]["emptySuccess"]["builtinPreserved"] is True
    assert out["loopbackOnly"] is True
