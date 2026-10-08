import asyncio
import base64
import os
import tempfile
from types import SimpleNamespace

from src.mcp_manager import McpManager, _browser_preview


def _text(value):
    return SimpleNamespace(type="text", text=value)


def _image(data=b"preview", mime="image/jpeg"):
    encoded = base64.b64encode(data).decode("ascii")
    return SimpleNamespace(type="image", data=encoded, mimeType=mime)


class _Session:
    def __init__(self, fail_screenshot=False, delay=0, file_only=False):
        self.calls = []
        self.fail_screenshot = fail_screenshot
        self.delay = delay
        self.file_only = file_only

    async def call_tool(self, name, arguments):
        self.calls.append((name, arguments))
        if self.delay:
            await asyncio.sleep(self.delay)
        if name == "browser_take_screenshot":
            if self.fail_screenshot:
                raise RuntimeError("screenshot unavailable")
            if self.file_only:
                with open(arguments["filename"], "wb") as image_file:
                    image_file.write(b"file-preview")
                return SimpleNamespace(content=[_text("Screenshot saved")], isError=False)
            return SimpleNamespace(content=[_image()], isError=False)
        return SimpleNamespace(
            content=[_text("Page URL: https://example.test/path\nPage Title: Example")],
            isError=False,
        )


def _manager(session):
    manager = McpManager()
    manager._sessions["builtin_browser"] = session
    manager._tools["builtin_browser"] = [{
        "name": "browser_take_screenshot",
        "input_schema": {"type": "object", "properties": {
            "type": {"type": "string", "enum": ["png", "jpeg"]},
            "filename": {"type": "string"},
            "scale": {"type": "string", "enum": ["css", "device"]},
        }},
    }]
    return manager


def test_browser_action_returns_preview_from_same_session():
    async def run():
        session = _Session()
        result = await _manager(session).call_tool(
            "mcp__builtin_browser__browser_navigate", {"url": "https://example.test/path"}
        )
        assert [name for name, _ in session.calls] == ["browser_navigate", "browser_take_screenshot"]
        screenshot_args = session.calls[1][1]
        assert screenshot_args["type"] == "jpeg"
        assert screenshot_args["scale"] == "css"
        assert os.path.isabs(screenshot_args["filename"])
        assert screenshot_args["filename"].endswith("/novum-browser-preview.jpeg")
        assert result["stdout"].startswith("Page URL:")
        assert result["browser_preview"] == {
            "state": "updated",
            "action": "browser_navigate",
            "url": "https://example.test/path",
            "title": "Example",
            "screenshot": f"data:image/jpeg;base64,{base64.b64encode(b'preview').decode()}"
        }
        assert "images" not in result

    asyncio.run(run())


def test_browser_actions_and_preview_captures_serialize():
    async def run():
        session = _Session(delay=0.01)
        manager = _manager(session)
        await asyncio.gather(
            manager.call_tool("mcp__builtin_browser__browser_click", {}),
            manager.call_tool("mcp__builtin_browser__browser_scroll", {}),
        )
        names = [name for name, _ in session.calls]
        assert names[0] in {"browser_click", "browser_scroll"}
        assert names[1] == "browser_take_screenshot"
        assert names[2] in {"browser_click", "browser_scroll"} - {names[0]}
        assert names[3] == "browser_take_screenshot"

    asyncio.run(run())


def test_preview_failure_does_not_fail_browser_action():
    async def run():
        result = await _manager(_Session(fail_screenshot=True)).call_tool(
            "mcp__builtin_browser__browser_click", {}
        )
        assert result["exit_code"] == 0
        assert result["stdout"].startswith("Page URL:")
        assert result["browser_preview"]["state"] == "unavailable"
        assert "screenshot" not in result["browser_preview"]

    asyncio.run(run())


def test_nonbrowser_tool_is_unchanged():
    async def run():
        session = _Session()
        manager = McpManager()
        manager._sessions["other"] = session
        result = await manager.call_tool("mcp__other__read", {})
        assert result["stdout"].startswith("Page URL:")
        assert "browser_preview" not in result
        assert [name for name, _ in session.calls] == ["read"]

    asyncio.run(run())


def test_explicit_screenshot_populates_preview_without_second_capture():
    async def run():
        session = _Session()
        result = await _manager(session).call_tool("mcp__builtin_browser__browser_take_screenshot", {})
        assert [name for name, _ in session.calls] == ["browser_take_screenshot"]
        assert result["browser_preview"]["state"] == "updated"
        assert result["browser_preview"]["action"] == "browser_take_screenshot"
        assert len(result["images"]) == 1

    asyncio.run(run())


def test_file_only_screenshot_result_uses_private_fixed_file_and_cleans_up():
    async def run():
        session = _Session(file_only=True)
        manager = _manager(session)
        result = await manager.call_tool("mcp__builtin_browser__browser_click", {})
        filename = session.calls[1][1]["filename"]
        assert filename.endswith("/novum-browser-preview.jpeg")
        assert result["browser_preview"]["state"] == "updated"
        assert result["browser_preview"]["screenshot"].endswith(
            base64.b64encode(b"file-preview").decode("ascii")
        )
        assert os.path.exists(filename)
        await manager.disconnect_all()
        assert not os.path.exists(filename)

    asyncio.run(run())


def test_readonly_close_and_tab_listing_skip_automatic_preview():
    async def run():
        session = _Session()
        manager = _manager(session)
        await manager.call_tool("mcp__builtin_browser__browser_snapshot", {})
        await manager.call_tool("mcp__builtin_browser__browser_close", {})
        await manager.call_tool("mcp__builtin_browser__browser_tabs", {"action": "list"})
        assert [name for name, _ in session.calls] == [
            "browser_snapshot", "browser_close", "browser_tabs"
        ]

        await manager.call_tool("mcp__builtin_browser__browser_tabs", {"action": "select", "id": "2"})
        assert [name for name, _ in session.calls][-2:] == ["browser_tabs", "browser_take_screenshot"]

    asyncio.run(run())


def test_disabled_screenshot_tool_skips_capture():
    async def run():
        session = _Session()
        manager = _manager(session)
        manager._tools["builtin_browser"][0]["is_disabled"] = True
        result = await manager.call_tool("mcp__builtin_browser__browser_click", {})
        assert [name for name, _ in session.calls] == ["browser_click"]
        assert result["browser_preview"]["state"] == "unavailable"

    asyncio.run(run())


def test_browser_connect_configures_private_allowed_output_directory():
    async def run():
        manager = McpManager()
        captured = {}

        async def fake_connect(server_id, name, command, args, env):
            captured["args"] = args
            return True

        manager._connect_stdio = fake_connect
        assert await manager.connect_server(
            "builtin_browser", "Browser", "stdio", command="playwright", args=["--headless"]
        )
        args = captured["args"]
        output_dir = args[args.index("--output-dir") + 1]
        assert os.path.isabs(output_dir)
        assert os.path.isdir(output_dir)
        assert manager._browser_preview_tempdir.name == output_dir
        await manager.disconnect_all()
        assert not os.path.exists(output_dir)

        with tempfile.TemporaryDirectory() as parent:
            explicit = os.path.join(parent, "browser-output")
            manager = McpManager()
            captured.clear()
            manager._connect_stdio = fake_connect
            await manager.connect_server(
                "builtin_browser", "Browser", "stdio", command="playwright",
                args=[f"--output-dir={explicit}"],
            )
            assert captured["args"] == [f"--output-dir={explicit}"]
            private_dir = manager._browser_preview_tempdir.name
            assert os.path.dirname(private_dir) == os.path.realpath(explicit)
            await manager.disconnect_all()
            assert not os.path.exists(private_dir)

    asyncio.run(run())


def test_preview_rejects_unsafe_url_html_and_oversized_image():
    oversized = base64.b64encode(b"x" * (2 * 1024 * 1024 + 1)).decode("ascii")
    result = {
        "stdout": "Page URL: https://example.test\nPage Title: <script>alert(1)</script>\nPage content: <html>private</html>",
        "exit_code": 0,
    }
    preview = _browser_preview("browser_navigate", {"url": "javascript:alert(1)"}, result, {
        "exit_code": 0,
        "images": [{"mimeType": "image/png", "data": oversized}],
    })
    assert preview["state"] == "unavailable"
    assert preview["url"] == "https://example.test"
    assert "title" not in preview
    assert "Page content" not in str(preview)
    assert "<script>" not in str(preview)
    assert "screenshot" not in preview


def test_preview_parses_bullet_prefixed_metadata():
    preview = _browser_preview("browser_click", {}, {
        "stdout": "- Page URL: https://example.test/path\n- Page Title: Example",
        "exit_code": 0,
    }, {"exit_code": 0, "images": [_image().__dict__]})
    assert preview["url"] == "https://example.test/path"
    assert preview["title"] == "Example"
    assert preview["state"] == "updated"


def test_visual_preview_never_enters_model_tool_result():
    from src.tool_execution import format_tool_result

    result = {
        'stdout': 'Page URL: https://example.test/', 'stderr': '', 'exit_code': 0,
        'browser_preview': {'state': 'updated', 'screenshot': 'private-preview-pixels'},
    }
    formatted = format_tool_result('browser navigation', result)
    assert 'Page URL: https://example.test/' in formatted
    assert 'private-preview-pixels' not in formatted
    assert 'browser_preview' not in formatted
