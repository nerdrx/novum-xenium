"""Old-session cleanup must use the permanent-deletion cleanup boundary."""
import os
import subprocess
import sys


def test_cleanup_old_sessions_removes_private_artifacts_and_preserves_other_owner(tmp_path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / "fixture.txt").write_text("private fixture\n")
    code = r'''import asyncio, os, sys
from datetime import datetime, timedelta
from pathlib import Path
from core.database import SessionLocal, Session as DbSession
from core.session_manager import SessionManager
from src.cleanup_service import cleanup_old_sessions
from src.tool_result_store import archive_result, get_result_stats
from src.run_checkpoints import begin as begin_checkpoint, get_checkpoint
from src import run_evidence, workspace_snapshots
import src.tool_execution as tool_execution

workspace = sys.argv[1]
tool_execution.vet_workspace = lambda path: os.path.realpath(path) if os.path.isdir(path) else None
workspace_snapshots._ROOT = Path(os.environ["ODYSSEUS_DATA_DIR"]) / "workspace_snapshots"
manager = SessionManager()
old = datetime.utcnow() - timedelta(days=40)
for index in range(11):
    sid = f"alice-old-{index}"
    manager.create_session(sid, f"Old {index}", "unused", "unused", owner="alice")
    db = SessionLocal()
    row = db.get(DbSession, sid)
    row.archived = True
    row.created_at = old - timedelta(days=index)
    row.last_accessed = old - timedelta(days=index)
    row.updated_at = old - timedelta(days=index)
    db.commit()
    db.close()

# A different owner's otherwise eligible chat must remain untouched.
manager.create_session("bob-old", "Bob old", "unused", "unused", owner="bob")
db = SessionLocal()
row = db.get(DbSession, "bob-old")
row.archived = True
row.created_at = old
row.last_accessed = old
row.updated_at = old
db.commit()
db.close()

for owner, sid in (("alice", "alice-old-10"), ("bob", "bob-old")):
    archive_result(owner, sid, "browser", f"private output for {owner}")
    begin_checkpoint(f"run-{sid}", sid, owner, {"original_request": "private request"})
    run_evidence.begin(f"run-{sid}", sid, owner, {})
    run_evidence.finish(f"run-{sid}", "done")
    workspace_snapshots.create_snapshot(workspace, owner, sid)

deleted, _freed_mb = asyncio.run(cleanup_old_sessions(manager, owner="alice"))
db = SessionLocal()
alice = db.get(DbSession, "alice-old-10")
bob = db.get(DbSession, "bob-old")
db.close()
assert deleted == 1, deleted
assert alice is None and "alice-old-10" not in manager.sessions
assert bob is not None and "bob-old" in manager.sessions
assert get_result_stats("alice", "alice-old-10")["count"] == 0
assert get_checkpoint("alice-old-10", "alice") is None
assert run_evidence.list_runs("alice-old-10", "alice") == []
assert workspace_snapshots.list_snapshots(workspace, "alice", "alice-old-10") == []
assert get_result_stats("bob", "bob-old")["count"] == 1
assert get_checkpoint("bob-old", "bob") is not None
assert len(run_evidence.list_runs("bob-old", "bob")) == 1
assert len(workspace_snapshots.list_snapshots(workspace, "bob", "bob-old")) == 1
'''
    env = os.environ.copy()
    env.update(
        DATABASE_URL=f"sqlite:///{tmp_path / 'app.db'}",
        ODYSSEUS_DATA_DIR=str(tmp_path / "data"),
        AUTH_ENABLED="true",
    )
    result = subprocess.run(
        [sys.executable, "-c", code, str(workspace)],
        capture_output=True, text=True, timeout=30, env=env,
    )
    assert result.returncode == 0, result.stderr


def test_no_login_cleanup_deletes_reserved_local_owner_archive(tmp_path):
    code = r'''import asyncio
from datetime import datetime, timedelta
from core.database import SessionLocal, Session as DbSession
from core.session_manager import SessionManager
from src.cleanup_service import cleanup_old_sessions
from src.tool_result_store import archive_result, get_result_stats

manager = SessionManager()
old = datetime.utcnow() - timedelta(days=40)
for index in range(11):
    sid = f"local-old-{index}"
    manager.create_session(sid, f"Old {index}", "unused", "unused")
    db = SessionLocal()
    row = db.get(DbSession, sid)
    row.archived = True
    row.created_at = old - timedelta(days=index)
    row.last_accessed = old - timedelta(days=index)
    db.commit()
    db.close()

target = "local-old-10"
archive_result(None, target, "browser", "private local output")
assert get_result_stats(None, target)["count"] == 1
deleted, _freed_mb = asyncio.run(cleanup_old_sessions(manager, owner=None))
db = SessionLocal()
assert db.get(DbSession, target) is None
db.close()
assert deleted == 1
assert get_result_stats(None, target)["count"] == 0
'''
    env = os.environ.copy()
    env.update(
        DATABASE_URL=f"sqlite:///{tmp_path / 'app.db'}",
        ODYSSEUS_DATA_DIR=str(tmp_path / "data"),
        AUTH_ENABLED="false",
    )
    result = subprocess.run(
        [sys.executable, "-c", code],
        capture_output=True, text=True, timeout=30, env=env,
    )
    assert result.returncode == 0, result.stderr
