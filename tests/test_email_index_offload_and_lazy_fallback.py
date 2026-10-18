import asyncio
import threading
from contextlib import contextmanager

import pytest


def _endpoint(router, path, method):
    return next(
        route.endpoint for route in router.routes
        if route.path == path and method in route.methods
    )


@pytest.mark.asyncio
async def test_cached_only_list_offloads_index_query_and_preserves_owner(monkeypatch):
    import routes.email_routes as email_routes

    monkeypatch.setattr(email_routes, "_start_poller", lambda: None)
    monkeypatch.delenv("ODYSSEUS_EMAIL_FIXTURE", raising=False)
    entered = threading.Event()
    release = threading.Event()
    calls = []

    def slow_index(*args):
        calls.append(args)
        entered.set()
        assert release.wait(2)
        return ([{"uid": "4"}], 1, "indexed")

    monkeypatch.setattr(email_routes, "_email_index_list", slow_index)
    route = _endpoint(email_routes.setup_email_routes(), "/api/email/list", "GET")
    request = asyncio.create_task(route(
        folder="Archive", limit=8, offset=3, filter="unread", from_addr=None,
        account_id="acct-a", has_attachments=1, date_from=None, date_to=None,
        cached_only=1, cache_bust=None, refresh=0, owner="alice",
    ))

    try:
        assert await asyncio.to_thread(entered.wait, 1)
        ticks = 0

        async def heartbeat():
            nonlocal ticks
            for _ in range(4):
                await asyncio.sleep(0.01)
                ticks += 1

        await heartbeat()
    finally:
        release.set()
    result = await request

    assert ticks == 4
    assert calls == [("alice", "acct-a", "Archive", "unread", 8, 3, True)]
    assert result["emails"] == [{"uid": "4"}]
    assert result["sync"]["cached_only"] is True


class _SearchImap:
    def list(self):
        return "OK", []

    def select(self, *_args, **_kwargs):
        return "OK", []


def _search_route(monkeypatch, index_result, imap_search_result):
    import routes.email_routes as email_routes

    monkeypatch.setattr(email_routes, "_start_poller", lambda: None)
    monkeypatch.delenv("ODYSSEUS_EMAIL_FIXTURE", raising=False)
    calls = []

    def index(*args, **kwargs):
        calls.append((args, kwargs))
        return index_result

    monkeypatch.setattr(email_routes, "_email_index_search", index)
    monkeypatch.setattr(email_routes, "_imap_uid_search", lambda *_a: imap_search_result)
    monkeypatch.setattr(email_routes, "_email_index_rows", lambda *_a: {})
    monkeypatch.setattr(email_routes, "_imap_uid_fetch", lambda *_a: ("NO", []))
    monkeypatch.setattr(email_routes, "_email_index_upsert", lambda *_a: None)

    @contextmanager
    def fake_imap(_account_id=None, owner=""):
        assert owner == "alice"
        yield _SearchImap()

    monkeypatch.setattr(email_routes, "_imap", fake_imap)
    route = _endpoint(email_routes.setup_email_routes(), "/api/email/search", "GET")
    return route, calls


def test_remote_search_skips_index_when_imap_has_matches(monkeypatch):
    route, calls = _search_route(monkeypatch, ([{"uid": "9"}], 1, "time"), ("OK", [b"5"]))

    result = route(q="invoice", folder="INBOX", limit=20, account_id="acct-a", local_only=False, scope="all", owner="alice")

    assert result["source"] == "imap"
    assert calls == []


def test_search_index_is_loaded_only_for_local_or_fallback_paths(monkeypatch):
    indexed = ([{"uid": "9"}], 1, "time")

    route, calls = _search_route(monkeypatch, indexed, ("OK", []))
    result = route(q="invoice", folder="INBOX", limit=20, account_id="acct-a", local_only=False, scope="all", owner="alice")
    assert result["fallback"] is True
    assert result["emails"] == indexed[0]
    assert len(calls) == 1
    assert calls[0][0][0:4] == ("alice", "acct-a", "INBOX", "invoice")

    route, calls = _search_route(monkeypatch, indexed, ("OK", [b"5"]))
    result = route(q="invoice", folder="INBOX", limit=20, account_id="acct-a", local_only=True, scope="all", owner="alice")
    assert result["source"] == "index"
    assert result["emails"] == indexed[0]
    assert len(calls) == 1


def test_search_index_fallback_covers_imap_error_and_exception(monkeypatch):
    indexed = ([{"uid": "9"}], 1, "time")
    route, calls = _search_route(monkeypatch, indexed, ("NO", [b""]))
    result = route(q="invoice", folder="INBOX", limit=20, account_id="acct-a", local_only=False, scope="all", owner="alice")
    assert result["fallback"] is True
    assert result["sync"]["fallback_reason"] == "imap_search_failed"
    assert len(calls) == 1

    import routes.email_routes as email_routes

    route, calls = _search_route(monkeypatch, indexed, ("OK", []))

    @contextmanager
    def broken_imap(*_args, **_kwargs):
        raise RuntimeError("synthetic IMAP failure")
        yield  # pragma: no cover

    monkeypatch.setattr(email_routes, "_imap", broken_imap)
    result = route(q="invoice", folder="INBOX", limit=20, account_id="acct-a", local_only=False, scope="all", owner="alice")
    assert result["fallback"] is True
    assert result["emails"] == indexed[0]
    assert len(calls) == 1


@pytest.mark.parametrize("path", ["local", "empty", "exception"])
def test_index_lookup_failure_returns_generic_error_without_retry(monkeypatch, path):
    import routes.email_routes as email_routes

    route, _ = _search_route(monkeypatch, ([], 0, None), ("OK", []))
    calls = []

    def broken_index(*_args, **_kwargs):
        calls.append(1)
        raise RuntimeError("synthetic index failure")

    monkeypatch.setattr(email_routes, "_email_index_search", broken_index)
    if path == "exception":
        @contextmanager
        def broken_imap(*_args, **_kwargs):
            raise RuntimeError("synthetic IMAP failure")
            yield  # pragma: no cover

        monkeypatch.setattr(email_routes, "_imap", broken_imap)

    result = route(
        q="invoice", folder="INBOX", limit=20, account_id="acct-a",
        local_only=(path == "local"), scope="all", owner="alice",
    )

    assert result == {"emails": [], "total": 0, "error": "Mail operation failed"}
    assert len(calls) == 1
