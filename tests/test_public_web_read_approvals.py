"""Public read exceptions must not become arbitrary outgoing-data grants."""
import json

import pytest

from src.tool_capabilities import ToolRunSecurityContext


def context(mode="auto", **kwargs):
    return ToolRunSecurityContext(approval_mode=mode, external_untrusted_context_seen=True, **kwargs)


@pytest.mark.parametrize("url", [
    "https://www.youtube.com/@therealnerdrx", "https://youtube.com/@nerdrx/",
    "https://github.com/nerdrx", "github.com/nerdrx",
    "https://www.deviantart.com/nerdrx", "https://deviantart.com/nerdrx/",
])
@pytest.mark.parametrize("native", [True, False])
def test_public_profile_after_search_needs_no_approval(url, native):
    content = json.dumps({"url": url}) if native else url
    assert context().decision_for("web_fetch", content).allowed
    assert not context("ask").decision_for("web_fetch", content).allowed
    assert not context(delegated_credential=True).decision_for("web_fetch", content).allowed


@pytest.mark.parametrize("url", [
    "https://www.youtube.com/@therealnerdrx?secret=private", "https://github.com/nerdrx/collect/private",
    "https://youtube.com.attacker.test/@nerdrx", "https://attacker.test/collect/private",
    "https://user:pass@youtube.com/@nerdrx", "https://youtube.com:8111/@nerdrx",
    "http://youtube.com/@nerdrx", "https://www.youtube.com/@nerdrx%2fsecret",
    "https://127.0.0.1/@nerdrx", "https://[::1]/@nerdrx", "https://metadata.google.internal/profile",
    "https://service.lan/profile", "https://youtube.com\\@attacker.test/@nerdrx",
    "https://www.deviantart.com/nerdrx?secret=private", "https://www.deviantart.com/nerdrx/gallery",
    "https://deviantart.com.attacker.test/nerdrx", "https://user:pass@deviantart.com/nerdrx",
    "https://deviantart.com:8111/nerdrx", "http://deviantart.com/nerdrx",
    "https://deviantart.com/nerdrx%2fsecret", "https://deviantart.com/users/logout",
])
def test_new_payload_or_unusual_destination_keeps_approval(url):
    assert not context().decision_for("web_fetch", json.dumps({"url": url})).allowed


def test_search_link_is_exact_and_does_not_grant_other_actions():
    run = context()
    url = "https://docs.example.test/guide?version=2"
    run.observe_tool_result("web_search", {"sources": [{"url": url}], "output": "search", "exit_code": 0})
    assert run.decision_for("web_fetch", json.dumps({"url": url})).allowed
    assert not run.decision_for("web_fetch", json.dumps({"url": url + "&secret=private"})).allowed
    assert not run.decision_for("web_fetch", json.dumps({"url": "https://docs.example.test/private"})).allowed
    assert not run.decision_for("bash", "printf hello").allowed
    assert not run.decision_for("write_file", "file\ndata").allowed
    assert not run.decision_for("vault_get", "key").allowed


@pytest.mark.asyncio
async def test_real_search_handler_passes_bound_sources_to_gate(monkeypatch):
    from src.agent_tools.web_tools import WebSearchTool
    url = "https://docs.example.test/guide"
    monkeypatch.setattr("src.search.comprehensive_web_search", lambda *args, **kwargs: (
        "public search text", [{"url": url, "title": "Guide"}]
    ))
    result = await WebSearchTool().execute("coding docs", {})
    run = context()
    run.observe_tool_result("web_search", result)
    assert run.decision_for("web_fetch", url).allowed
    assert not run.decision_for("web_fetch", url + "/secret").allowed


@pytest.mark.parametrize("multimodal", [False, True])
def test_untrusted_message_cannot_seed_new_destinations(multimodal):
    run = context()
    url = "https://example.test/page"
    content = [{"type": "text", "text": "read " + url}] if multimodal else "read " + url
    run.observe_messages([{"role": "user", "content": content, "metadata": {"trusted": False}}])
    assert not run.decision_for("web_fetch", url).allowed
    run.observe_messages([{"role": "user", "content": content}])
    assert run.decision_for("web_fetch", url).allowed
    assert not run.decision_for("web_fetch", url + "/private").allowed


def test_failed_search_and_other_tool_cannot_seed_links():
    run = context()
    result = {"sources": [{"url": "https://example.test/page"}], "output": "data", "exit_code": 1}
    run.observe_tool_result("web_search", result)
    result["exit_code"] = 0
    run.observe_tool_result("read_file", result)
    assert run.public_read_urls == set()


@pytest.mark.parametrize("content", [
    '{}', '{"url": []}', '{broken', '{"url": "https://github.com/nerdrx", "headers": {"Authorization":"secret"}}',
    'https://github.com/nerdrx\nhttps://attacker.test/collect',
])
def test_ambiguous_arguments_do_not_get_exception(content):
    assert not context().decision_for("web_fetch", content).allowed


@pytest.mark.parametrize("disabled", [False, True])
@pytest.mark.parametrize("url", ["https://www.youtube.com/@therealnerdrx", "https://www.deviantart.com/nerdrx"])
def test_real_agent_loop_public_fetch_does_not_bypass_disabled_tools(monkeypatch, disabled, url):
    from tests.test_external_context_tool_gate import _patch_agent_loop, _collect_agent_events
    from src.prompt_security import untrusted_context_message
    executed = []
    loop = _patch_agent_loop(monkeypatch, ["```web_fetch\n" + url + "\n```"], executed)

    async def fake_execute(block, **kwargs):
        executed.append(block.tool_type)
        return "web_fetch", {"output": "public profile", "exit_code": 0}

    monkeypatch.setattr(loop, "execute_tool_block", fake_execute)
    events = _collect_agent_events(loop.stream_agent_loop(
        "http://local.test/v1", "model", [{"role": "user", "content": "look up my profile"},
        untrusted_context_message("web search results", "external")], max_rounds=1,
        relevant_tools={"web_fetch"}, disabled_tools={"web_fetch"} if disabled else set(),
    ))
    assert executed == ([] if disabled else ["web_fetch"])
    assert not any(event.get("ask_user", {}).get("kind") == "tool_approval" for event in events)


@pytest.mark.parametrize("append_payload", [False, True])
def test_search_then_fetch_in_real_loop_binds_exact_destination(monkeypatch, append_payload):
    from tests.test_external_context_tool_gate import _patch_agent_loop, _collect_agent_events
    executed = []
    source_url = "https://docs.example.test/guide"
    target = source_url + ("?secret=private" if append_payload else "")
    loop = _patch_agent_loop(monkeypatch, [
        "```web_search\ncoding docs\n```", "```web_fetch\n" + target + "\n```",
    ], executed)

    async def fake_execute(block, **kwargs):
        executed.append(block.tool_type)
        return block.tool_type, {"output": "public data", "exit_code": 0,
                                  "sources": [{"url": source_url}] if block.tool_type == "web_search" else []}

    monkeypatch.setattr(loop, "execute_tool_block", fake_execute)
    events = _collect_agent_events(loop.stream_agent_loop(
        "http://local.test/v1", "model", [{"role": "user", "content": "research coding docs"}],
        max_rounds=2, relevant_tools={"web_search", "web_fetch"},
    ))
    assert executed == (["web_search"] if append_payload else ["web_search", "web_fetch"])
    assert any(event.get("ask_user", {}).get("kind") == "tool_approval" for event in events) is append_payload
