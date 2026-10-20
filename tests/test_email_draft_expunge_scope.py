"""Draft cleanup is UID-scoped and preserves unknown/pre-existing flags."""
from contextlib import contextmanager

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


class FakeImap:
    def __init__(self, mode="ok"):
        self.mode = mode
        self.folder = "INBOX"
        self.mailboxes = {"Drafts": {"41", "42"}, "Sent": set()}
        self.deleted = {"Drafts": {"42"}, "Sent": set()}
        self.lowercase_deleted = set()
        if mode == "preexisting-target":
            self.deleted["Drafts"].add("41")
        self.calls = []
        self.expunges = 0
        self._odysseus_account_id = "acct-A"
        self._odysseus_mailbox_scope = "scope-acct-A"

    def select(self, folder, readonly=False):
        self.folder = (folder.decode() if isinstance(folder, bytes) else str(folder)).strip('"')
        return "OK", [str(len(self.mailboxes.get(self.folder, set()))).encode()]

    def response(self, name):
        assert name == "UIDVALIDITY"
        return "UIDVALIDITY", [b"77"]

    def append(self, folder, flags, date, data):
        folder = (folder.decode() if isinstance(folder, bytes) else str(folder)).strip('"')
        uid = "99" if folder == "Drafts" else "90"
        self.mailboxes.setdefault(folder, set()).add(uid)
        self.deleted.setdefault(folder, set())
        self.calls.append(("APPEND", folder, uid))
        return "OK", [f"APPENDUID 77 {uid}".encode()]

    def uid(self, command, *args):
        raw = args[0] if args else b""
        uid = raw.decode() if isinstance(raw, bytes) else str(raw)
        self.calls.append((command, self.folder, uid))
        if command == "FETCH":
            query = str(args[-1]) if args else ""
            if "FLAGS" in query and self.mode == "flags-query-error":
                raise RuntimeError("synthetic UID FLAGS failure")
            if "FLAGS" in query and self.mode == "flags-query-failure":
                return "NO", []
            if uid not in self.mailboxes.get(self.folder, set()):
                return "OK", []
            flags = b"\\deleted" if uid in self.lowercase_deleted else (
                b"\\Deleted" if uid in self.deleted.get(self.folder, set()) else b""
            )
            return "OK", [(b"1 (UID " + uid.encode() + b" FLAGS (" + flags + b"))",)]
        if command == "STORE":
            operation, flag = args[1], args[2]
            flag = flag.decode() if isinstance(flag, bytes) else str(flag)
            assert flag == "\\Deleted"
            current = self.deleted.setdefault(self.folder, set())
            if operation == "+FLAGS":
                current.add(uid)
            elif operation == "-FLAGS":
                current.discard(uid)
            self.calls.append(("STORE", self.folder, uid, operation))
            return "OK", []
        if command == "EXPUNGE":
            assert uid == "41", "must never expunge mailbox-wide or another UID"
            if self.mode in {"uid-expunge-no", "uid-expunge-error"}:
                if self.mode == "uid-expunge-error":
                    raise RuntimeError("synthetic UID EXPUNGE failure")
                return "NO", []
            self.mailboxes[self.folder].discard(uid)
            self.deleted[self.folder].discard(uid)
            return "OK", []
        raise AssertionError(f"Unexpected UID command: {command}")

    def expunge(self):
        self.expunges += 1
        raise AssertionError("mailbox-wide EXPUNGE is forbidden in draft cleanup")


@pytest.fixture
def mail_client(monkeypatch):
    from routes import email_routes as routes

    conn = FakeImap()
    config = {
        "account_id": "acct-A",
        "from_address": "sender@example.invalid",
        "smtp_user": "sender@example.invalid",
        "smtp_password": "fixture-only",
        "smtp_host": "smtp.fixture.invalid",
        "smtp_port": 2525,
    }
    monkeypatch.setattr(routes, "_start_poller", lambda: None)
    monkeypatch.setattr(routes, "_assert_owns_account", lambda *_a, **_k: None)
    monkeypatch.setattr(routes, "_get_email_config", lambda *_a, **_k: config)
    monkeypatch.setattr(routes, "_resolve_send_config", lambda *_a, **_k: config)
    monkeypatch.setattr(routes, "_detect_drafts_folder", lambda _c: "Drafts")
    monkeypatch.setattr(routes, "_detect_sent_folder", lambda _c: "Sent")
    monkeypatch.setattr(routes, "_send_smtp_message", lambda *_a, **_k: None)
    monkeypatch.setattr(routes, "_cleanup_compose_uploads", lambda *_a, **_k: None)

    @contextmanager
    def fake_imap(*_args, **_kwargs):
        yield conn

    monkeypatch.setattr(routes, "_imap", fake_imap)
    app = FastAPI()
    app.include_router(routes.setup_email_routes())
    app.dependency_overrides[routes.require_owner] = lambda: "fixture-owner"
    with TestClient(app) as client:
        yield client, conn


def _payload():
    return {
        "to": "recipient@example.invalid",
        "subject": "Synthetic draft cleanup",
        "body": "Fixture content only",
        "account_id": "acct-A",
        "draft_uid": "41",
        "draft_folder": "Drafts",
        "draft_account_id": "acct-A",
        "draft_uidvalidity": "77",
        "draft_mailbox_scope": "scope-acct-A",
    }


@pytest.mark.parametrize("path", ["/api/email/draft", "/api/email/send"])
def test_success_expunge_removes_only_target_uid(mail_client, path):
    client, conn = mail_client
    payload = _payload()
    if path.endswith("/send"):
        payload["wait_for_delivery"] = True
    response = client.post(path, json=payload)
    assert response.status_code == 200
    assert response.json()["success"] is True
    assert "41" not in conn.mailboxes["Drafts"]
    assert "42" in conn.mailboxes["Drafts"]
    assert conn.deleted["Drafts"] == {"42"}
    assert [(call[0], call[1], call[2]) for call in conn.calls if call[0] == "EXPUNGE"] == [
        ("EXPUNGE", "Drafts", "41")
    ]
    assert conn.expunges == 0


@pytest.mark.parametrize("path", ["/api/email/draft", "/api/email/send"])
@pytest.mark.parametrize("mode", ["uid-expunge-no", "uid-expunge-error"])
def test_failed_selective_expunge_restores_new_flag_and_keeps_draft(mail_client, path, mode):
    client, conn = mail_client
    conn.mode = mode
    payload = _payload()
    if path.endswith("/send"):
        payload["wait_for_delivery"] = True
    response = client.post(path, json=payload)
    assert response.status_code == 200
    assert response.json()["success"] is True
    assert "41" in conn.mailboxes["Drafts"]
    assert "42" in conn.mailboxes["Drafts"]
    assert conn.deleted["Drafts"] == {"42"}
    assert conn.expunges == 0
    assert ("STORE", "Drafts", "41", "-FLAGS") in conn.calls


@pytest.mark.parametrize("path", ["/api/email/draft", "/api/email/send"])
@pytest.mark.parametrize("lowercase", [False, True])
def test_failed_expunge_retains_preexisting_target_deleted_flag(mail_client, path, lowercase):
    client, conn = mail_client
    conn.mode = "uid-expunge-no"
    conn.deleted["Drafts"].add("41")
    if lowercase:
        conn.lowercase_deleted.add("41")
    payload = _payload()
    if path.endswith("/send"):
        payload["wait_for_delivery"] = True
    response = client.post(path, json=payload)
    assert response.status_code == 200
    assert response.json()["success"] is True
    assert "41" in conn.mailboxes["Drafts"]
    assert conn.deleted["Drafts"] == {"41", "42"}
    assert ("STORE", "Drafts", "41", "-FLAGS") not in conn.calls


@pytest.mark.parametrize("path", ["/api/email/draft", "/api/email/send"])
@pytest.mark.parametrize("mode", ["flags-query-failure", "flags-query-error"])
def test_unknown_initial_flag_state_skips_cleanup_without_mutating(mail_client, path, mode):
    client, conn = mail_client
    conn.mode = mode
    payload = _payload()
    if path.endswith("/send"):
        payload["wait_for_delivery"] = True
    response = client.post(path, json=payload)
    assert response.status_code == 200
    assert response.json()["success"] is True
    assert "41" in conn.mailboxes["Drafts"]
    assert conn.deleted["Drafts"] == {"42"}
    assert not any(call[0] == "STORE" and call[2] == "41" for call in conn.calls)
    assert not any(call[0] == "EXPUNGE" for call in conn.calls)
    assert conn.expunges == 0
