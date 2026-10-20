from contextlib import contextmanager

import pytest
from fastapi import BackgroundTasks


def _endpoint(router, path, method):
    for route in router.routes:
        if route.path == path and method in getattr(route, "methods", set()):
            return route.endpoint
    raise AssertionError(f"missing {method} {path}")


class FakeImap:
    def __init__(self):
        self.folder = None
        self.deleted = []
        self.expunges = 0
        self.account_ids = []

    def select(self, folder, readonly=False):
        self.folder = folder.decode() if isinstance(folder, bytes) else str(folder)
        self.folder = self.folder.strip('"')
        return "OK", [b"1"]

    def response(self, name):
        assert name == "UIDVALIDITY"
        return "UIDVALIDITY", [b"77" if self.folder in {"Drafts", "Sent"} else b"66"]

    def append(self, folder, flags, date, data):
        return "OK", [b"APPENDUID 77 502"]

    def uid(self, command, *args):
        if command == "FETCH":
            raw = (
                b"From: Sender <sender@example.invalid>\r\n"
                b"To: User <user@example.invalid>\r\n"
                b"Subject: Fixture read\r\n"
                b"Message-ID: <fixture-read@example.invalid>\r\n"
                b"Date: Tue, 04 Aug 2026 12:00:00 +0000\r\n"
                b"Content-Type: text/plain; charset=utf-8\r\n\r\n"
                b"Fixture body"
            )
            header, body = raw.split(b"\r\n\r\n", 1)
            return "OK", [
                (b"1 (UID 501 BODY[HEADER])", header + b"\r\n\r\n"),
                (b"1 (UID 501 BODY[TEXT]<0>)", body),
            ]
        if command == "SEARCH":
            return "OK", [b""]
        raise AssertionError(command)

    def expunge(self):
        self.expunges += 1


def _setup(monkeypatch, *, account="acct-A", send_config=None):
    import routes.email_routes as routes

    conn = FakeImap()
    conn._odysseus_account_id = (send_config or {}).get("account_id", account)
    conn._odysseus_mailbox_scope = f"scope-{conn._odysseus_account_id}" if conn._odysseus_account_id else None
    monkeypatch.setattr(routes, "_start_poller", lambda: None)
    monkeypatch.setattr(routes, "_assert_owns_account", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(routes, "_get_email_config", lambda *_args, **_kwargs: {
        "account_id": account,
        "from_address": "sender@example.invalid",
        "smtp_user": "sender@example.invalid",
        "smtp_password": "fixture",
        "smtp_host": "smtp.fixture.invalid",
        "smtp_port": 2525,
    })
    monkeypatch.setattr(routes, "_resolve_send_config", lambda *_args, **_kwargs: send_config or {
        "account_id": account,
        "from_address": "sender@example.invalid",
        "smtp_user": "sender@example.invalid",
        "smtp_password": "fixture",
        "smtp_host": "smtp.fixture.invalid",
        "smtp_port": 2525,
    })

    @contextmanager
    def fake_imap(account_id=None, owner=""):
        conn.account_ids.append(account_id)
        yield conn

    monkeypatch.setattr(routes, "_imap", fake_imap)
    monkeypatch.setattr(routes, "_detect_drafts_folder", lambda _conn: "Drafts")
    monkeypatch.setattr(routes, "_detect_sent_folder", lambda _conn: "Sent")
    monkeypatch.setattr(routes, "_send_smtp_message", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(routes, "_cleanup_compose_uploads", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(routes, "_store_email_flag", lambda _c, uid, flag, add=True: (conn.deleted.append((uid, flag)) or True))
    router = routes.setup_email_routes()
    return routes, conn, _endpoint(router, "/api/email/draft", "POST"), _endpoint(router, "/api/email/send", "POST")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "old_account,old_validity,old_scope,expected_delete",
    [("acct-A", "77", "scope-acct-A", True), ("acct-B", "77", "scope-acct-B", False), ("acct-A", "66", "scope-acct-A", False), ("acct-A", None, "scope-acct-A", False), ("acct-A", "77", None, False)],
)
async def test_draft_replacement_requires_account_and_old_folder_uidvalidity(
    monkeypatch, old_account, old_validity, old_scope, expected_delete
):
    _routes, conn, save_draft, _send = _setup(monkeypatch)
    from routes.email_helpers import SendEmailRequest

    result = await save_draft(SendEmailRequest(
        to="to@example.invalid", subject="fixture", body="fixture", account_id="acct-A",
        draft_uid="501", draft_folder="Drafts", draft_account_id=old_account,
        draft_uidvalidity=old_validity, draft_mailbox_scope=old_scope,
    ), owner="owner")

    assert result["success"] is True
    assert result["account_id"] == "acct-A"
    assert result["draft_uid"] == "502"
    assert result["draft_uidvalidity"] == "77"
    assert result["mailbox_scope"] == "scope-acct-A"
    assert bool(conn.deleted) is expected_delete


@pytest.mark.asyncio
async def test_draft_cleanup_does_not_trust_config_resolved_before_imap_connect(monkeypatch):
    import routes.email_helpers as helpers
    import routes.email_routes as routes
    from routes.email_helpers import SendEmailRequest

    _routes, conn, save_draft, _send = _setup(monkeypatch, account="acct-A")
    class SocketFake(FakeImap):
        def __init__(self, host):
            super().__init__()
            self.host = host

        def login(self, *_args):
            return "OK", [b"logged in"]

        def logout(self):
            return "BYE", [b"logged out"]

    actual_connections = []
    monkeypatch.setattr(routes, "_imap", helpers._imap)
    monkeypatch.setattr(routes, "_get_email_config", lambda *_args, **_kwargs: {
        "account_id": "acct-A", "imap_host": "imap-A.fixture.invalid",
        "from_address": "sender@example.invalid", "smtp_user": "sender@example.invalid",
        "smtp_password": "fixture", "smtp_host": "smtp.fixture.invalid", "smtp_port": 2525,
    })
    monkeypatch.setattr(helpers, "_get_email_config", lambda *_args, **_kwargs: {
        "account_id": "acct-B", "imap_host": "imap-B.fixture.invalid", "imap_port": 143,
        "imap_user": "user-B", "imap_password": "fixture", "from_address": "sender@example.invalid",
    })

    def fake_open(host, *_args, **_kwargs):
        conn = SocketFake(host)
        actual_connections.append(conn)
        return conn

    monkeypatch.setattr(helpers, "_open_imap_connection", fake_open)
    monkeypatch.setattr(routes, "_store_email_flag", lambda _c, uid, flag, add=True: (actual_connections[-1].deleted.append((uid, flag)) or True))
    smtp_cfg = {"account_id": "acct-A", "from_address": "sender@example.invalid", "smtp_user": "sender@example.invalid", "smtp_password": "fixture", "smtp_host": "smtp.fixture.invalid", "smtp_port": 2525}
    monkeypatch.setattr(routes, "_resolve_send_config", lambda *_args, **_kwargs: smtp_cfg)
    result = await save_draft(SendEmailRequest(
        to="to@example.invalid", subject="fixture", body="fixture", account_id="acct-A",
        draft_uid="501", draft_folder="Drafts", draft_account_id="acct-A",
        draft_uidvalidity="77", draft_mailbox_scope="scope-acct-A", resolve_for_send=True,
    ), owner="owner")

    assert result["success"] is True
    assert result["account_id"] == "acct-B"
    assert result["send_account_id"] == "acct-A"
    assert len(actual_connections) == 1
    assert actual_connections[0].host == "imap-B.fixture.invalid"
    # The old UID belongs to A even though actual _imap_connect fell back to B.
    assert actual_connections[0].deleted == []


@pytest.mark.asyncio
async def test_repointed_same_account_id_and_colliding_uidvalidity_are_not_a_scope_match(monkeypatch):
    import routes.email_helpers as helpers
    import routes.email_routes as routes
    from routes.email_helpers import SendEmailRequest

    _routes, _conn, save_draft, _send = _setup(monkeypatch, account="acct-A")
    class SocketFake(FakeImap):
        def __init__(self, host):
            super().__init__()
            self.host = host

        def login(self, *_args):
            return "OK", [b"logged in"]

        def logout(self):
            return "BYE", [b"logged out"]

    actual_connections = []
    monkeypatch.setattr(routes, "_imap", helpers._imap)
    monkeypatch.setattr(routes, "_get_email_config", lambda *_args, **_kwargs: {
        "account_id": "acct-A", "imap_host": "imap-new.fixture.invalid",
        "from_address": "sender@example.invalid", "smtp_user": "sender@example.invalid",
        "smtp_password": "fixture", "smtp_host": "smtp.fixture.invalid", "smtp_port": 2525,
    })
    monkeypatch.setattr(helpers, "_get_email_config", lambda *_args, **_kwargs: {
        "account_id": "acct-A", "imap_host": "imap-new.fixture.invalid", "imap_port": 143,
        "imap_user": "new-user", "imap_password": "fixture", "from_address": "sender@example.invalid",
    })

    def fake_open(host, *_args, **_kwargs):
        conn = SocketFake(host)
        actual_connections.append(conn)
        return conn

    monkeypatch.setattr(helpers, "_open_imap_connection", fake_open)
    monkeypatch.setattr(routes, "_store_email_flag", lambda _c, uid, flag, add=True: (actual_connections[-1].deleted.append((uid, flag)) or True))
    result = await save_draft(SendEmailRequest(
        to="to@example.invalid", subject="fixture", body="fixture", account_id="acct-A",
        draft_uid="501", draft_folder="Drafts", draft_account_id="acct-A",
        draft_uidvalidity="77",
    ), owner="owner")

    assert result["success"] is True
    assert actual_connections[0].host == "imap-new.fixture.invalid"
    # Same account row ID and a coincidentally reused UIDVALIDITY are not enough
    # to identify the old server/user namespace.
    assert actual_connections[0].deleted == []


def test_pooled_socket_keeps_its_original_namespace_stamp_after_row_repoint(monkeypatch):
    import routes.email_helpers as helpers

    _setup(monkeypatch, account="acct-A")  # installs this route instance's pool hooks
    configs = {
        "acct-A": {
            "account_id": "acct-A", "imap_host": "imap-old.fixture.invalid", "imap_port": 143,
            "imap_user": "old-user", "imap_password": "fixture",
        }
    }
    connections = []

    class SocketFake(FakeImap):
        def __init__(self, host):
            super().__init__()
            self.host = host

        def login(self, *_args):
            return "OK", [b"logged in"]

        def noop(self):
            return "OK", [b"alive"]

        def logout(self):
            return "BYE", [b"logged out"]

    monkeypatch.setattr(helpers, "_get_email_config", lambda account_id=None, owner="": configs[account_id])

    def fake_open(host, *_args, **_kwargs):
        conn = SocketFake(host)
        connections.append(conn)
        return conn

    monkeypatch.setattr(helpers, "_open_imap_connection", fake_open)
    with helpers._imap("acct-A", owner="owner") as first:
        old_scope = first._odysseus_mailbox_scope
    configs["acct-A"] = {
        "account_id": "acct-A", "imap_host": "imap-new.fixture.invalid", "imap_port": 143,
        "imap_user": "new-user", "imap_password": "fixture",
    }
    with helpers._imap("acct-A", owner="owner") as second:
        assert second is first
        assert second.host == "imap-old.fixture.invalid"
        assert second._odysseus_mailbox_scope == old_scope
    assert len(connections) == 1


@pytest.mark.asyncio
async def test_recovery_draft_uses_resolved_smtp_mailbox(monkeypatch):
    smtp_cfg = {
        "account_id": "acct-SMTP", "from_address": "sender@example.invalid",
        "smtp_user": "sender@example.invalid", "smtp_password": "fixture",
        "smtp_host": "smtp.fixture.invalid", "smtp_port": 2525,
    }
    _routes, _conn, save_draft, _send = _setup(monkeypatch, account=None, send_config=smtp_cfg)
    from routes.email_helpers import SendEmailRequest

    result = await save_draft(SendEmailRequest(
        to="to@example.invalid", subject="fixture", body="fixture", resolve_for_send=True,
    ), owner="owner")
    assert result["success"] is True
    assert result["account_id"] == "acct-SMTP"
    assert result["send_account_id"] == "acct-SMTP"
    assert result["mailbox_scope"] == "scope-acct-SMTP"


@pytest.mark.asyncio
async def test_read_response_uses_actual_connection_provenance(monkeypatch):
    import routes.email_routes as routes

    _routes, conn, _save, _send = _setup(monkeypatch, account=None)
    conn._odysseus_account_id = "acct-resolved"
    conn._odysseus_mailbox_scope = "scope-resolved"
    monkeypatch.setattr(routes, "_email_preview_cache_get", lambda *_args: None)
    monkeypatch.setattr(routes, "_email_preview_cache_put", lambda *_args: None)
    monkeypatch.setattr(routes, "_email_attachment_meta_cache_get", lambda *_args: None)
    monkeypatch.setattr(routes, "_email_attachment_meta_cache_put", lambda *_args: None)
    router = routes.setup_email_routes()
    read = _endpoint(router, "/api/email/read/{uid}", "GET")
    result = await read("501", folder="Drafts", account_id=None, mark_seen=False, full=False, owner="owner")

    assert result["account_id"] == "acct-resolved"
    assert result["uidvalidity"] == "77"
    assert result["mailbox_scope"] == "scope-resolved"
    assert conn.account_ids == [None]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "draft_account,draft_validity,draft_scope,expected_delete",
    [("acct-A", "77", "scope-acct-A", True), ("acct-B", "77", "scope-acct-B", False), ("acct-A", "66", "scope-acct-A", False), ("acct-A", "77", "other-scope", False), (None, None, None, False)],
)
async def test_send_cleanup_requires_same_account_and_uidvalidity(
    monkeypatch, draft_account, draft_validity, draft_scope, expected_delete
):
    _routes, conn, _save, send = _setup(monkeypatch, account="acct-A")
    from routes.email_helpers import SendEmailRequest

    result = await send(SendEmailRequest(
        to="to@example.invalid", subject="fixture", body="fixture", account_id="acct-A",
        draft_uid="501", draft_folder="Drafts", draft_account_id=draft_account,
        draft_uidvalidity=draft_validity, draft_mailbox_scope=draft_scope, wait_for_delivery=True,
    ), BackgroundTasks(), owner="owner")
    assert result["success"] is True
    assert bool(conn.deleted) is expected_delete
