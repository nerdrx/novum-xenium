"""Weak nonempty SearXNG batches get one bounded existing-provider supplement."""

import json
from datetime import datetime, timedelta

import pytest

from services.search.cache import generate_cache_key


@pytest.fixture
def core(monkeypatch, tmp_path):
    import services.search.core as module

    monkeypatch.setattr(module, "_get_search_settings", lambda: {
        "search_provider": "searxng",
        "search_fallback_chain": ["duckduckgo"],
    })
    monkeypatch.setattr(module, "_get_result_count", lambda: 3)
    monkeypatch.setattr(module, "SEARCH_CACHE_DIR", tmp_path)
    monkeypatch.setattr(module, "search_cache_index", {})
    monkeypatch.setattr(module, "cleanup_cache", lambda *args, **kwargs: None)
    monkeypatch.setattr(module, "_record_query", lambda *args, **kwargs: None)
    return module


def _row(url, title, snippet=""):
    return {"url": url, "title": title, "snippet": snippet}


def test_simple_search_supplements_sparse_batch_dedupes_and_caps(core, monkeypatch):
    query = "Electron FFmpeg desktop app"
    calls = []
    primary = [_row("https://docs.example/one", "Electron project", "Framework")]
    fallback = [
        _row("https://docs.example/one", "Electron FFmpeg desktop app", "Duplicate"),
        _row("https://docs.example/two", "Electron FFmpeg desktop app", "Tutorial"),
        _row("https://docs.example/three", "Electron FFmpeg desktop app", "Guide"),
        _row("https://docs.example/four", "Electron FFmpeg desktop app", "Examples"),
    ]

    def call(provider, q, count, time_filter):
        calls.append((provider, q, count, time_filter))
        return primary if provider == "searxng" else fallback

    monkeypatch.setattr(core, "_call_provider", call)

    results = core.searxng_search_results(query, count=3)

    assert [call[0] for call in calls] == ["searxng", "duckduckgo"]
    assert all(call[2] == 3 for call in calls)
    assert len(results) == 3
    assert len({item["url"] for item in results}) == 3
    assert "https://docs.example/two" in {item["url"] for item in results}


def test_comprehensive_search_supplements_only_to_requested_fetch_count(core, monkeypatch):
    query = "Electron FFmpeg desktop app"
    calls = []
    fetched = []
    primary = [_row("https://docs.example/one", "Electron project", "Framework")]
    fallback = [
        _row("https://docs.example/one", "Electron FFmpeg desktop app", "Duplicate"),
        _row("https://docs.example/two", "Electron FFmpeg desktop app", "Tutorial"),
        _row("https://docs.example/three", "Electron FFmpeg desktop app", "Guide"),
        _row("https://docs.example/four", "Electron FFmpeg desktop app", "Examples"),
    ]

    def call(provider, q, count, time_filter):
        calls.append((provider, count))
        return primary if provider == "searxng" else fallback

    def fetch(url, timeout=8, retry_attempt=0):
        fetched.append(url)
        return {"success": True, "url": url, "title": "Title", "content": "body"}

    monkeypatch.setattr(core, "_call_provider", call)
    monkeypatch.setattr(core, "fetch_webpage_content", fetch)

    output, sources = core.comprehensive_web_search(
        query, max_pages=2, max_workers=2, return_sources=True,
    )

    assert calls == [("searxng", 3), ("duckduckgo", 3)]
    assert len(sources) == 3
    assert len({item["url"] for item in sources}) == 3
    assert len(fetched) == 2  # max_pages still bounds page fetches
    assert "Searched 3 results, fetched 2 pages" in output


@pytest.mark.parametrize("fallback_result", [[], RuntimeError("provider failed")])
def test_empty_or_failing_supplement_preserves_primary(core, monkeypatch, fallback_result):
    calls = []
    primary = [_row("https://docs.example/one", "Electron project", "Framework")]

    def call(provider, q, count, time_filter):
        calls.append(provider)
        if provider == "searxng":
            return primary
        if isinstance(fallback_result, Exception):
            raise fallback_result
        return fallback_result

    monkeypatch.setattr(core, "_call_provider", call)

    results = core.searxng_search_results("Electron FFmpeg desktop app", count=3)

    assert calls == ["searxng", "duckduckgo"]  # one supplemental attempt
    assert results == primary


def test_full_but_lexically_weak_batch_is_supplemented(core, monkeypatch):
    calls = []
    primary = [_row(f"https://weak.example/{i}", "Package manager", "Install packages")
               for i in range(3)]
    fallback = [_row("https://electronjs.org/docs", "Electron FFmpeg desktop app",
                     "Electron FFmpeg desktop app docs")]

    def call(provider, q, count, time_filter):
        calls.append(provider)
        return primary if provider == "searxng" else fallback

    monkeypatch.setattr(core, "_call_provider", call)

    results = core.searxng_search_results("Electron FFmpeg desktop app", count=3)

    assert calls == ["searxng", "duckduckgo"]
    assert "https://electronjs.org/docs" in [item["url"] for item in results]


def test_supplement_discards_zero_match_noise_and_invalid_urls(core, monkeypatch):
    query = "Electron FFmpeg GUI apps examples features"
    primary = [_row("https://docs.example/primary", "Electron framework", "")]
    fallback = [
        _row("https://irrelevant.example/video", "Unrelated video", "Enjoy videos and music"),
        _row("javascript:alert(1)", "Electron GUI examples", "FFmpeg features"),
        _row("https://[bad", "Electron GUI examples", "FFmpeg features"),
        _row("https://docs.example/relevant", "Electron GUI examples", "FFmpeg features"),
    ]
    monkeypatch.setattr(core, "_call_provider", lambda provider, *args: fallback)

    results, status = core._supplement_weak_results(
        query, primary, 5, None, ["searxng", "duckduckgo"],
    )

    assert [item["url"] for item in results] == [
        "https://docs.example/primary", "https://docs.example/relevant",
    ]
    assert status == ("duckduckgo", "ok (4 returned; 1 relevant; 2 unique)")


def test_strong_primary_batch_does_not_call_fallback(core, monkeypatch):
    calls = []
    primary = [_row(f"https://docs.example/{i}", "Electron FFmpeg desktop app",
                    "Electron FFmpeg desktop app") for i in range(3)]
    monkeypatch.setattr(core, "_call_provider", lambda provider, *args: (
        calls.append(provider) or primary
    ))

    results = core.searxng_search_results("Electron FFmpeg desktop app", count=3)

    assert calls == ["searxng"]
    assert len(results) == 3


def test_disabled_and_custom_fallback_chains_are_respected(core, monkeypatch):
    calls = []
    primary = [_row("https://weak.example/one", "Package manager", "Install packages")]
    monkeypatch.setattr(core, "_call_provider", lambda provider, *args: (
        calls.append(provider) or (primary if provider == "searxng" else [
            _row("https://electronjs.org/docs", "Electron FFmpeg desktop app", "Docs")
        ])
    ))
    core._get_search_settings = lambda: {
        "search_provider": "searxng", "search_fallback_chain": ["disabled"],
    }
    core.searxng_search_results("Electron FFmpeg desktop app", count=3)
    assert calls == ["searxng"]

    calls.clear()
    core.search_cache_index.clear()
    core._get_search_settings = lambda: {
        "search_provider": "searxng", "search_fallback_chain": ["duckduckgo", "brave"],
    }
    core.searxng_search_results("Electron FFmpeg desktop app custom chain", count=3)
    assert calls == ["searxng", "duckduckgo"]


def test_simple_search_ignores_old_weak_cache_namespace(core, monkeypatch):
    query = "Electron FFmpeg desktop app"
    old_key = generate_cache_key(f"search-v2:{query}|3|None")
    (core.SEARCH_CACHE_DIR / f"{old_key}.cache").write_text(json.dumps({
        "expiry": (datetime.now() + timedelta(hours=1)).isoformat(),
        "data": [_row("https://stale.example/", "Old weak result", "")],
    }), encoding="utf-8")
    calls = []
    primary = [_row("https://docs.example/one", "Electron project", "Framework")]
    fallback = [_row("https://electronjs.org/docs", "Electron FFmpeg desktop app", "Docs")]
    monkeypatch.setattr(core, "_call_provider", lambda provider, *args: (
        calls.append(provider) or (primary if provider == "searxng" else fallback)
    ))

    results = core.searxng_search_results(query, count=3)

    assert calls == ["searxng", "duckduckgo"]
    assert all(item["url"] != "https://stale.example/" for item in results)
