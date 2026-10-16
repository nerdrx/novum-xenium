import json

from core import database
from src import push_notifications
from tests.helpers.sqlite_db import make_temp_sqlite


def _session_fixture(monkeypatch):
    sessions, engine, _ = make_temp_sqlite(database.Base.metadata)
    monkeypatch.setattr(database, "SessionLocal", sessions)
    return sessions, engine


def test_device_reassignment_revokes_previous_owner_and_server_id_is_stable(monkeypatch):
    sessions, engine = _session_fixture(monkeypatch)
    with sessions() as db:
        db.add(database.NotificationEmailCursor(owner="alice", account_id="mail-a", last_uid=99, baselined=True))
        db.commit()
    first = push_notifications.register_device("alice", "private-token", opt_in=True)
    server = push_notifications.server_id()
    assert server == push_notifications.server_id()
    second = push_notifications.register_device("bob", "private-token", opt_in=True)
    assert first != second
    with sessions() as db:
        assert db.query(database.NotificationDevice).filter_by(owner="alice").count() == 0
        assert db.query(database.NotificationDevice).filter_by(owner="bob", token="private-token").count() == 1
        assert db.query(database.NotificationEmailCursor).filter_by(owner="alice").count() == 0
    assert push_notifications.unregister_device("alice", second) is False
    assert push_notifications.unregister_device("bob", second) is True
    engine.dispose()


def test_delivery_worker_sends_generic_payload_data_and_marks_sent(monkeypatch):
    sessions, engine = _session_fixture(monkeypatch)
    device_id = push_notifications.register_device("alice", "private-token", opt_in=True)
    from src.notification_feed import add_notification
    event_id = add_notification(
        "alice", "email", "private subject", body="private sender", route="#email=INBOX:1:a",
        source="email", source_id="mail-1",
    )
    assert event_id
    failed_task_id = add_notification(
        "alice", "task", "private task name", body="private task output", route="#tasks",
        status="failure", source="task", source_id="task-1",
    )
    assert failed_task_id
    monkeypatch.setattr(push_notifications, "_get_access_token", lambda: ("project", "access"))
    observed = []

    class Response:
        status = 200
        def __enter__(self):
            return self
        def __exit__(self, *_args):
            return False

    def fake_urlopen(request, timeout):
        observed.append((request, timeout))
        return Response()

    monkeypatch.setattr(push_notifications, "urlopen", fake_urlopen)
    assert push_notifications.process_pending_push(10) == 2
    assert len(observed) == 2
    sent_messages = []
    for request, timeout in observed:
        assert timeout == 5
        assert request.full_url == "https://fcm.googleapis.com/v1/projects/project/messages:send"
        assert request.get_header("Authorization") == "Bearer access"
        message = json.loads(request.data)["message"]
        assert message["token"] == "private-token"
        assert "notification" not in message  # Android handler validates before displaying.
        assert message["android"] == {"priority": "HIGH", "ttl": "86400s"}
        sent_messages.append(message["data"])
    by_kind = {message["kind"]: message for message in sent_messages}
    assert by_kind["email"] == {
        "event_id": str(event_id), "kind": "email",
        "server_id": push_notifications.server_id(), "status": "",
    }
    assert by_kind["task"] == {
        "event_id": str(failed_task_id), "kind": "task",
        "server_id": push_notifications.server_id(), "status": "failure",
    }
    assert "private subject" not in str(sent_messages)
    assert "private sender" not in str(sent_messages)
    assert "private task name" not in str(sent_messages)
    assert "private task output" not in str(sent_messages)
    assert "#email=" not in str(sent_messages)
    with sessions() as db:
        deliveries = db.query(database.NotificationPushDelivery).all()
        assert len(deliveries) == 2
        assert all(delivery.device_id == device_id and delivery.status == "sent" for delivery in deliveries)
    engine.dispose()
