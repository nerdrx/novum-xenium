"""Private in-memory chat context follows the permanent session-delete boundary."""
import os
import subprocess
import sys


def test_delete_clears_only_owned_incognito_context_and_blocks_late_writes(tmp_path):
    code = r'''from core.session_manager import SessionManager
from routes import chat_helpers
from src.tool_result_store import archive_result, get_result_stats

manager = SessionManager()
sid = "shared-deleted-chat"
live_sid = "bob-live-chat"
manager.create_session(sid, "Nobody", "unused", "unused", owner="alice")
manager.create_session(live_sid, "Nobody", "unused", "unused", owner="bob")

chat_helpers._append_incognito_message(sid, "user", "alice private prompt", owner="alice")
chat_helpers._append_incognito_message(sid, "assistant", "alice private answer", owner="alice")
chat_helpers._append_incognito_message(live_sid, "user", "bob still-live prompt", owner="bob")
archive_result("alice", sid, "browser", "alice session archive")
archive_result("bob", live_sid, "browser", "bob live archive")

assert [m["content"] for m in chat_helpers._incognito_messages(sid, owner="alice")] == [
    "alice private prompt", "alice private answer"
]
assert chat_helpers._incognito_messages(sid, owner="bob") == []
chat_helpers._append_incognito_message(sid, "user", "wrong owner", owner="bob")
assert len(chat_helpers._incognito_messages(sid, owner="alice")) == 2

# A completed deletion clears its private transcript and fences a late writer
# that still holds a stale session object. Other owner's data stays intact.
assert manager.delete_session(sid)
assert chat_helpers._incognito_messages(sid, owner="alice") == []
chat_helpers._append_incognito_message(sid, "assistant", "late alice callback", owner="alice")
assert chat_helpers._incognito_messages(sid, owner="alice") == []
assert get_result_stats("alice", sid)["count"] == 0
assert [m["content"] for m in chat_helpers._incognito_messages(live_sid, owner="bob")] == [
    "bob still-live prompt"
]
assert get_result_stats("bob", live_sid)["count"] == 1

# Even a reused SID under a different account starts with a clean transcript.
manager.create_session(sid, "Nobody", "unused", "unused", owner="bob")
assert chat_helpers._incognito_messages(sid, owner="bob") == []
chat_helpers._append_incognito_message(sid, "user", "bob new private prompt", owner="bob")
assert [m["content"] for m in chat_helpers._incognito_messages(sid, owner="bob")] == [
    "bob new private prompt"
]
assert chat_helpers._incognito_messages(sid, owner="alice") == []
'''
    env = os.environ.copy()
    env.update(
        DATABASE_URL=f"sqlite:///{tmp_path / 'app.db'}",
        ODYSSEUS_DATA_DIR=str(tmp_path / "data"),
        AUTH_ENABLED="true",
    )
    result = subprocess.run(
        [sys.executable, "-c", code],
        capture_output=True,
        text=True,
        timeout=30,
        env=env,
    )
    assert result.returncode == 0, result.stderr


def test_missing_owner_fails_closed_and_database_open_error_releases_delete_lock(tmp_path):
    code = r'''import threading
from types import SimpleNamespace
from core import session_manager as session_manager_module
from core.session_manager import SessionManager
from src import incognito_context

sid = "owner-required"
manager = SessionManager()
manager.create_session(sid, "Chat", "unused", "unused", owner="alice")
incognito_context.append_incognito_message(sid, "user", "must not be accepted", owner=incognito_context.OWNER_UNSET)
assert incognito_context.incognito_messages(sid, owner="alice") == []

real_factory = session_manager_module.SessionLocal
session_manager_module.SessionLocal = lambda: (_ for _ in ()).throw(RuntimeError("db unavailable"))
assert manager.delete_session("no-such-chat") is False
acquired = []
def acquire_from_another_thread():
    ok = incognito_context.INCOGNITO_CONTEXT_LOCK.acquire(timeout=1)
    acquired.append(ok)
    if ok:
        incognito_context.INCOGNITO_CONTEXT_LOCK.release()
thread = threading.Thread(target=acquire_from_another_thread)
thread.start()
thread.join(timeout=2)
assert not thread.is_alive() and acquired == [True], acquired
session_manager_module.SessionLocal = real_factory
'''
    env = os.environ.copy()
    env.update(
        DATABASE_URL=f"sqlite:///{tmp_path / 'app.db'}",
        ODYSSEUS_DATA_DIR=str(tmp_path / "data"),
        AUTH_ENABLED="true",
    )
    result = subprocess.run(
        [sys.executable, "-c", code],
        capture_output=True,
        text=True,
        timeout=30,
        env=env,
    )
    assert result.returncode == 0, result.stderr
