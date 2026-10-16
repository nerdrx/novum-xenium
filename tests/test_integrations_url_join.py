"""Tests for integration URL construction in execute_api_call.

Covers the trailing-slash regression from #5138: a bare "/" path must
resolve to the base URL itself, not base + "/". Discord webhook URLs
404 on the trailing-slash variant, so api_call against a
POST-to-base integration silently failed.
"""
import sys
import types
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
import src
from src import constants as _REAL_CONSTANTS
from tests.helpers.import_state import clear_module, preserve_import_state

# ---------------------------------------------------------------------------
# Import against temporary stubs without leaking them into the test session.
# ---------------------------------------------------------------------------
with preserve_import_state(
    "core", "core.atomic_io", "core.platform_compat", "src",
    "src.constants", "src.secret_storage", "src.integrations",
):
    atomic = types.ModuleType("core.atomic_io")
    atomic.atomic_write_json = lambda *a, **kw: None  # type: ignore
    platform_compat = types.ModuleType("core.platform_compat")
    platform_compat.safe_chmod = lambda *a, **kw: None  # type: ignore
    secret_storage = types.ModuleType("src.secret_storage")
    secret_storage.encrypt = lambda s: s  # type: ignore
    secret_storage.decrypt = lambda s: s  # type: ignore
    secret_storage.is_encrypted = lambda s: False  # type: ignore
    constants = types.ModuleType("src.constants")
    constants.DATA_DIR = "/tmp"  # type: ignore
    constants.INTEGRATIONS_FILE = "/tmp/integrations_test.json"  # type: ignore
    constants.SETTINGS_FILE = "/tmp/settings_test.json"  # type: ignore
    sys.modules.update({
        "core.atomic_io": atomic,
        "core.platform_compat": platform_compat,
        "src.secret_storage": secret_storage,
        "src.constants": constants,
    })
    clear_module("src.integrations")
    from src import integrations  # noqa: E402


# ---------------------------------------------------------------------------
# _join_integration_url unit tests
# ---------------------------------------------------------------------------

WEBHOOK_BASE = "https://discord.com/api/webhooks/123/tokentokentoken"


def test_temporary_import_stubs_restore_real_constants():
    assert sys.modules["src.constants"] is _REAL_CONSTANTS
    assert src.constants is _REAL_CONSTANTS


@pytest.mark.parametrize(
    "base,path,expected",
    [
        # Bare "/" (the minimum path execute_api_call accepts) must not
        # grow a trailing slash — Discord webhooks 404 on it (#5138).
        (WEBHOOK_BASE, "/", WEBHOOK_BASE),
        (WEBHOOK_BASE + "/", "/", WEBHOOK_BASE),
        (WEBHOOK_BASE, "", WEBHOOK_BASE),
        # Normal paths keep joining exactly as before.
        ("http://api.example.com", "/items", "http://api.example.com/items"),
        ("http://api.example.com/", "/items", "http://api.example.com/items"),
        ("http://host/base", "/v1/me", "http://host/base/v1/me"),
        # A deliberate trailing slash inside a non-empty path is preserved
        # (e.g. linkding's /api/tags/, Home Assistant's /api/).
        ("http://host", "/api/tags/", "http://host/api/tags/"),
        ("http://host", "/api/", "http://host/api/"),
    ],
)
def test_join_integration_url(base, path, expected):
    assert integrations._join_integration_url(base, path) == expected


# ---------------------------------------------------------------------------
# Behavioral test through execute_api_call
# ---------------------------------------------------------------------------

DISCORD_INTEGRATION = {
    "id": "discord_test",
    "name": "Discord Webhook",
    "enabled": True,
    "base_url": WEBHOOK_BASE,
    "auth_type": "none",
    "api_key": "",
    "auth_header": "",
    "auth_param": "",
    "description": "",
    "preset": "discord_webhook",
}


@pytest.mark.asyncio
async def test_api_call_root_path_has_no_trailing_slash(monkeypatch):
    mock_resp = MagicMock()
    mock_resp.status_code = 204
    mock_resp.headers = {"content-type": "text/plain"}
    mock_resp.text = ""

    mock_client = AsyncMock()
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=None)
    mock_client.request = AsyncMock(return_value=mock_resp)
    # Keep the real SSRF guard, but make its DNS dependency deterministic and
    # offline for this URL-joining test.
    monkeypatch.setattr("src.url_safety._default_resolver", lambda _host: ["8.8.8.8"])

    with (
        patch.object(integrations, "_find_integration", return_value=DISCORD_INTEGRATION),
        patch("src.url_safety._default_resolver", return_value=["93.184.216.34"]),
        patch("httpx.AsyncClient", return_value=mock_client),
    ):
        result = await integrations.execute_api_call(
            "discord_test", "POST", "/", body={"content": "test"}
        )

    assert result.get("exit_code") == 0
    requested_url = mock_client.request.call_args.args[1]
    assert requested_url == WEBHOOK_BASE
