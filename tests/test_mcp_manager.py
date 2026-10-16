import asyncio
from unittest.mock import patch

from src.mcp_manager import _format_mcp_connection_error, McpManager


def test_playwright_mcp_connection_error_includes_install_hint():
    msg = _format_mcp_connection_error(
        "Browser (Playwright)",
        "npx",
        ["-y", "@playwright/mcp@latest", "--headless"],
        RuntimeError("package not found"),
    )

    assert "package not found" in msg
    assert "Browser MCP could not start" in msg
    assert "npx -y @playwright/mcp@latest --version" in msg
    assert "restart Novum Xenium" in msg


def test_generic_mcp_connection_error_preserves_original_error():
    msg = _format_mcp_connection_error(
        "Custom MCP",
        "python",
        ["server.py"],
        RuntimeError("boom"),
    )

    assert msg == "boom"


def test_http_transport_routes_to_start_http_connect():
    mgr = McpManager()

    async def fake_start(server_id, name, url):
        return "ROUTED"

    with patch.object(McpManager, "_start_http_connect", side_effect=fake_start) as m:
        result = asyncio.run(mgr.connect_server("id1", "n", "http", url="https://x/mcp"))
    assert result == "ROUTED"
    m.assert_called_once()


def test_mcp_timeout_does_not_replay_and_releases_browser_lock():
    from unittest.mock import AsyncMock

    async def run():
        mgr = McpManager()
        mgr._sessions['builtin_browser'] = object()
        calls = 0

        async def stalled(*args):
            nonlocal calls
            calls += 1
            await asyncio.Event().wait()

        with patch('src.mcp_manager.MCP_TOOL_TIMEOUT_SECONDS', 0.01), patch.object(mgr, '_do_call', side_effect=stalled), patch.object(mgr, '_reconnect_builtin', new_callable=AsyncMock) as reconnect:
            result = await mgr.call_tool('mcp__builtin_browser__browser_navigate', {'url': 'https://example.com'})
            assert result['timed_out'] is True
            assert calls == 1
            assert not mgr._browser_call_lock.locked()
            reconnect.assert_not_called()
            async with mgr._browser_call_lock:
                result = await mgr.call_tool('mcp__builtin_browser__browser_navigate', {'url': 'https://example.com'})
                assert result['timed_out'] is True
                assert calls == 1
    asyncio.run(run())
