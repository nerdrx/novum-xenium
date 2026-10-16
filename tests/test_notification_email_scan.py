from core import database
from routes import email_pollers
from routes import email_routes
from tests.helpers.sqlite_db import make_temp_sqlite


def _setup(monkeypatch, tmp_path):
    sessions, engine, _ = make_temp_sqlite(database.Base.metadata)
    monkeypatch.setattr(database, "SessionLocal", sessions)
    monkeypatch.setattr(email_pollers, "SCHEDULED_DB", str(tmp_path / "scheduled.db"))
    monkeypatch.setattr("routes.email_routes.SCHEDULED_DB", str(tmp_path / "scheduled.db"))
    with sessions() as db:
        db.add(database.NotificationDevice(id="device", owner="alice", token="secret"))
        db.add(database.EmailAccount(id="account", owner="alice", name="Inbox", is_default=True, enabled=True))
        db.commit()
    return sessions, engine


class FakeImap:
    def __init__(self, runtime):
        self.runtime = runtime
        self.searches = []

    def select(self, *_args, **_kwargs):
        return "OK", []

    def response(self, name):
        return name, [str(self.runtime["meta"][name]).encode()]

    def uid(self, command, *args):
        if command == "SEARCH":
            self.searches.append(args)
            if args[-1] == "ALL":
                hits = self.runtime["uids"]
            else:
                low = int(args[-1].split(":", 1)[0])
                hits = [uid for uid in self.runtime["uids"] if uid >= low]
            return "OK", [" ".join(map(str, hits)).encode()]
        requested = [int(uid) for uid in str(args[0]).split(",")]
        rows = []
        for uid in requested:
            raw = (
                f"Message-ID: <m{uid}@example.com>\r\nSubject: Subject {uid}\r\n"
                f"From: Sender <sender{uid}@example.com>\r\n\r\n"
            ).encode()
            rows.append((f"{uid} (UID {uid} BODY[HEADER.FIELDS] {{0}})".encode(), raw))
        return "OK", rows

    def logout(self):
        pass


def test_baseline_incremental_burst_and_uidvalidity_reset(monkeypatch, tmp_path):
    sessions, engine = _setup(monkeypatch, tmp_path)
    runtime = {"uids": list(range(1, 101)), "meta": {"UIDVALIDITY": 8, "UIDNEXT": 101}}
    imaps = []

    def connect(*_args, **_kwargs):
        conn = FakeImap(runtime)
        imaps.append(conn)
        return conn

    monkeypatch.setattr(email_pollers, "_imap_connect", connect)

    # UIDNEXT baseline does not search or flood historical messages.
    assert email_pollers._notification_email_scan_once() == []
    with sessions() as db:
        cursor = db.query(database.NotificationEmailCursor).one()
        assert (cursor.last_uid, cursor.uidvalidity, cursor.baselined) == (100, "8", True)
    assert imaps[-1].searches == []

    runtime["uids"] = list(range(1, 171))
    runtime["meta"]["UIDNEXT"] = 171
    batch = email_pollers._notification_email_scan_once()[0]
    assert [row["uid"] for row in batch[2]] == [str(uid) for uid in range(101, 151)]
    assert batch[3:] == (150, "8")
    assert imaps[-1].searches[0][-2:] == ("UID", "101:*")

    # A changed UIDVALIDITY establishes a fresh quiet baseline even if new UIDs
    # happen to be numerically above the previous watermark.
    runtime["uids"] = [200, 201]
    runtime["meta"].update(UIDVALIDITY=9, UIDNEXT=202)
    assert email_pollers._notification_email_scan_once() == []
    with sessions() as db:
        cursor = db.query(database.NotificationEmailCursor).one()
        assert (cursor.last_uid, cursor.uidvalidity) == (201, "9")
    engine.dispose()


def test_email_cursor_advances_only_after_durable_feed(monkeypatch, tmp_path):
    sessions, engine = _setup(monkeypatch, tmp_path)
    runtime = {"uids": [1], "meta": {"UIDVALIDITY": 8, "UIDNEXT": 2}}
    monkeypatch.setattr(email_pollers, "_imap_connect", lambda *_a, **_k: FakeImap(runtime))
    email_pollers._notification_email_scan_once()
    runtime["uids"].append(2)
    runtime["meta"]["UIDNEXT"] = 3
    batch = email_pollers._notification_email_scan_once()[0]
    from routes.email_routes import _record_email_received_events

    monkeypatch.setattr("src.notification_feed.add_notification", lambda *_a, **_k: None)
    assert _record_email_received_events(*batch[:2], "INBOX", batch[2]) is False
    with sessions() as db:
        assert db.query(database.NotificationEmailCursor).one().last_uid == 1

    monkeypatch.setattr("src.notification_feed.add_notification", lambda *_a, **_k: 42)
    monkeypatch.setattr("src.event_bus.fire_event", lambda *_a, **_k: None)
    assert _record_email_received_events(*batch[:2], "INBOX", batch[2]) is True
    with sessions() as db:
        cursor = db.query(database.NotificationEmailCursor).one()
        cursor.last_uid = batch[3]
        db.commit()
        assert cursor.last_uid == 2
    engine.dispose()


def test_foreground_email_refresh_ignores_rows_covered_by_notification_uid_baseline(monkeypatch, tmp_path):
    sessions, engine = _setup(monkeypatch, tmp_path)
    with sessions() as db:
        db.add(database.NotificationEmailCursor(
            owner="alice", account_id="account", last_uid=100, uidvalidity="8", baselined=True,
        ))
        db.commit()
    import sqlite3
    with sqlite3.connect(str(tmp_path / "scheduled.db")) as conn:
        conn.execute(
            "CREATE TABLE email_event_seen (owner TEXT NOT NULL, account_key TEXT NOT NULL, folder TEXT NOT NULL, "
            "message_key TEXT NOT NULL, first_seen_at TEXT NOT NULL, PRIMARY KEY(owner, account_key, folder, message_key))"
        )
        conn.execute(
            "INSERT INTO email_event_seen VALUES ('alice','account','INBOX','__notification_baseline__','now')"
        )
    events = []
    monkeypatch.setattr(
        "src.notification_feed.add_notification",
        lambda owner, kind, title, **kwargs: events.append(kwargs["source_id"]) or len(events),
    )
    monkeypatch.setattr("src.event_bus.fire_event", lambda *_args: None)
    rows = [
        {"uid": "98", "message_id": "old-98", "subject": "Old 98"},
        {"uid": "100", "message_id": "old-100", "subject": "Old 100"},
        {"uid": "101", "message_id": "new-101", "subject": "New 101"},
    ]
    assert email_routes._record_email_received_events("alice", "account", "INBOX", rows)
    assert events == ["account:INBOX:new-101"]
    engine.dispose()
