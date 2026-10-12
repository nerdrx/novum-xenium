"""GitHub blob documentation fetches prefer the same safe raw fetcher."""

import asyncio
import json

import pytest

from src.agent_tools.web_tools import WebFetchTool


def test_github_doc_candidate_is_conservative():
    assert WebFetchTool._github_raw_doc_url(
        "https://github.com/nerdrx/nx-hub/blob/main/docs/DESIGN.md"
    ) == "https://raw.githubusercontent.com/nerdrx/nx-hub/main/docs/DESIGN.md"
    for url in (
        "http://github.com/o/r/blob/main/README.md",
        "https://user@github.com/o/r/blob/main/README.md",
        "https://github.com:444/o/r/blob/main/README.md",
        "https://github.com/o/r/blob/feature/topic/README.md",
        "https://github.com/o/r/blob/main/docs%2FREADME.md",
        "https://github.com/o/r/blob/main/../README.md",
        "https://github.com/o/r/blob/main/README.pdf",
        "https://github.com/o/r/blob/main/README.md?raw=1",
        "https://github.com/o/r/pull/1",
    ):
        assert WebFetchTool._github_raw_doc_url(url) is None, url


def test_github_doc_fetch_keeps_source_and_fetched_provenance(monkeypatch):
    calls = []

    def fake_fetch(url, timeout=10, max_bytes=None):
        calls.append((url, timeout, max_bytes))
        return {"content": "# Design\nBody", "title": "DESIGN.md", "error": ""}

    import src.search.content as content_mod
    monkeypatch.setattr(content_mod, "fetch_webpage_content", fake_fetch)

    result = asyncio.run(WebFetchTool().execute(json.dumps({
        "url": "https://github.com/nerdrx/nx-hub/blob/main/docs/DESIGN.md",
        "max_bytes": 12345,
    }), ctx={}))

    assert result["exit_code"] == 0
    assert calls == [(
        "https://raw.githubusercontent.com/nerdrx/nx-hub/main/docs/DESIGN.md",
        10, 12345,
    )]
    assert "Source: https://github.com/nerdrx/nx-hub/blob/main/docs/DESIGN.md" in result["output"]
    assert "Fetched: https://raw.githubusercontent.com/nerdrx/nx-hub/main/docs/DESIGN.md" in result["output"]
    assert result["output"].endswith("# Design\nBody")


def test_github_raw_failure_falls_back_to_original_with_same_budget(monkeypatch):
    calls = []

    def fake_fetch(url, timeout=10, max_bytes=None):
        calls.append((url, timeout, max_bytes))
        if "raw.githubusercontent.com" in url:
            return {"content": "", "error": "NetworkError"}
        return {"content": "Original page text", "title": "DESIGN.md", "error": ""}

    import src.search.content as content_mod
    monkeypatch.setattr(content_mod, "fetch_webpage_content", fake_fetch)

    result = asyncio.run(WebFetchTool().execute(json.dumps({
        "url": "https://github.com/nerdrx/nx-hub/blob/main/docs/DESIGN.md",
        "full": True,
    }), ctx={}))

    assert result["exit_code"] == 0
    assert [call[0] for call in calls] == [
        "https://raw.githubusercontent.com/nerdrx/nx-hub/main/docs/DESIGN.md",
        "https://github.com/nerdrx/nx-hub/blob/main/docs/DESIGN.md",
    ]
    assert all(call[2] is not None for call in calls)
    assert "Source: https://github.com/nerdrx/nx-hub/blob/main/docs/DESIGN.md" in result["output"]
    assert "Fetched: https://raw.githubusercontent.com" not in result["output"]
    assert "Original page text" in result["output"]


def test_github_raw_exception_falls_back_with_hard_cap(monkeypatch):
    calls = []

    def fake_fetch(url, timeout=10, max_bytes=None):
        calls.append((url, max_bytes))
        if "raw.githubusercontent.com" in url:
            raise RuntimeError("raw endpoint unavailable")
        return {"content": "Original fallback", "error": ""}

    import src.search.content as content_mod
    monkeypatch.setattr(content_mod, "fetch_webpage_content", fake_fetch)
    from src.constants import WEB_FETCH_HARD_MAX_BYTES

    result = asyncio.run(WebFetchTool().execute(json.dumps({
        "url": "https://github.com/nerdrx/nx-hub/blob/main/docs/DESIGN.md",
        "full": True,
    }), ctx={}))

    assert result["exit_code"] == 0
    assert calls == [
        ("https://raw.githubusercontent.com/nerdrx/nx-hub/main/docs/DESIGN.md",
         WEB_FETCH_HARD_MAX_BYTES),
        ("https://github.com/nerdrx/nx-hub/blob/main/docs/DESIGN.md",
         WEB_FETCH_HARD_MAX_BYTES),
    ]
    assert "Original fallback" in result["output"]


def test_github_raw_timeout_does_not_start_original_fallback(monkeypatch):
    import src.agent_tools.web_tools as web_tools

    calls = 0

    async def timeout_first(awaitable, timeout):
        nonlocal calls
        calls += 1
        if calls == 1:
            awaitable.cancel()
            raise asyncio.TimeoutError
        return await asyncio.wait_for(awaitable, timeout)

    monkeypatch.setattr(web_tools.asyncio, "wait_for", timeout_first)
    result = asyncio.run(WebFetchTool().execute(
        "https://github.com/nerdrx/nx-hub/blob/main/docs/DESIGN.md", ctx={},
    ))

    assert calls == 1
    assert result["exit_code"] == 1
    assert "timed out" in result["error"]


@pytest.mark.parametrize("url", [
    "https://github.com/o/r/pull/42",
    "https://example.com/docs.md",
    "https://github.com/o/r/blob/feature/topic/docs.md",
])
def test_noncandidate_fetches_original_only(monkeypatch, url):
    calls = []
    import src.search.content as content_mod
    monkeypatch.setattr(content_mod, "fetch_webpage_content", lambda fetched, **kwargs: (
        calls.append(fetched) or {"content": "body", "error": ""}
    ))

    result = asyncio.run(WebFetchTool().execute(url, ctx={}))

    assert result["exit_code"] == 0
    assert calls == [url]
