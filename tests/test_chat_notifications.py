import pytest
from src.chat_notifications import record_chat_notification, stream_notification_state


def test_stream_state_errors_and_approval():
    assert stream_notification_state('data: {"type":"ask_user","data":{"approval_id":"a"}}', "done", False) == ("done", True)
    assert stream_notification_state('data: {"error":"bad"}', "done", True) == ("error", True)
    assert stream_notification_state('data: [DONE]', "done", False) == ("done", False)
    assert stream_notification_state('data: []', "done", False) == ("done", False)
    assert stream_notification_state('data: {"type":"cancelled"}', "done", False) == ("stopped", False)


def test_completion_has_no_message_contents_and_deduplicable_run_id(monkeypatch):
    calls = []
    monkeypatch.setattr("src.notification_feed.add_notification", lambda *a, **kw: calls.append((a,kw)))
    record_chat_notification("alice", "chat-1", "run-1", "done", True, completed=True)
    assert calls[0][0] == ("alice", "chat", "Response needs attention")
    assert calls[0][1]["source_id"] == "run-1"
    assert calls[0][1]["route"] == "#chat-1"
    assert calls[0][1]["status"] == "waiting_approval"


@pytest.mark.parametrize("options", [{"completed":False},{"incognito":True},{"compare_mode":True},{"subagent":True}])
def test_private_partial_and_child_runs_do_not_alert(monkeypatch, options):
    calls = []
    monkeypatch.setattr("src.notification_feed.add_notification", lambda *a, **kw: calls.append(a))
    record_chat_notification("alice", "chat-1", "run-1", "done", False, **({"completed":True}|options))
    assert calls == []
