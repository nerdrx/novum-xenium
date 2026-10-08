import asyncio
import threading

import pytest

from src.group_coordination import GroupCoordinationStore
from src.group_runs import GroupRunManager


def board():
    return {
        "plan": "Implement and inspect",
        "participants": [
            {"id": "builder", "display": "Builder", "role": "builder"},
            {"id": "reviewer", "display": "Reviewer", "role": "reviewer"},
        ],
        "tasks": [{
            "id": "t1", "title": "Make the change", "owner_id": "builder",
            "reviewer_id": "reviewer", "status": "pending", "work_result": "",
        }],
    }


def test_pass_persists_results_and_runs_serially(tmp_path):
    calls = []

    async def runner(session, prompt, *, read_only, owner, context=None):
        calls.append((session, read_only, owner))
        await asyncio.sleep(0)
        return "review evidence" if read_only else "builder result"

    store = GroupCoordinationStore(str(tmp_path / "group.db"))
    manager = GroupRunManager(store, runner=runner)

    async def scenario():
        run = await manager.start("parent", "alice", board(), {"builder": "s1", "reviewer": "s2"})
        task = manager._tasks[run["job_id"]]
        await task
        return store.get_run("parent", "alice", run["job_id"])

    run = asyncio.run(scenario())
    saved = store.get("parent", "alice")
    assert run["status"] == "completed"
    assert calls == [("s1", False, "alice"), ("s2", True, "alice")]
    assert saved["tasks"][0]["status"] == "awaiting_review"
    assert saved["tasks"][0]["work_result"] == "builder result"
    assert saved["tasks"][0]["review_result"] == "review evidence"


def test_stop_cancels_runner_and_preserves_uncertain_working_task(tmp_path):
    started = asyncio.Event()
    cancelled = asyncio.Event()

    async def runner(*_args, **_kwargs):
        started.set()
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            cancelled.set()
            raise

    store = GroupCoordinationStore(str(tmp_path / "group.db"))
    manager = GroupRunManager(store, runner=runner)

    async def scenario():
        run = await manager.start("parent", "alice", board(), {"builder": "s1", "reviewer": "s2"})
        await started.wait()
        assert await manager.stop("parent", "alice", run["job_id"])
        task = manager._tasks[run["job_id"]]
        try:
            await task
        except asyncio.CancelledError:
            pass
        return store.get_run("parent", "alice", run["job_id"])

    run = asyncio.run(scenario())
    assert cancelled.is_set()
    assert run["status"] == "stopped"
    assert store.get("parent", "alice")["tasks"][0]["status"] == "working"


def test_parent_delete_fences_only_matching_owner_run(tmp_path):
    started = {owner: asyncio.Event() for owner in ("alice", "bob")}

    async def runner(_session, _prompt, *, owner, **_kwargs):
        started[owner].set()
        await asyncio.Event().wait()

    store = GroupCoordinationStore(str(tmp_path / "group-delete-owner.db"))
    manager = GroupRunManager(store, runner=runner)

    async def scenario():
        alice = await manager.start("parent", "alice", board(), {"builder": "a1", "reviewer": "a2"})
        bob = await manager.start("parent", "bob", board(), {"builder": "b1", "reviewer": "b2"})
        alice_task = manager._tasks[alice["job_id"]]
        bob_task = manager._tasks[bob["job_id"]]
        await asyncio.gather(*(event.wait() for event in started.values()))

        manager.delete_session("parent", "alice")
        done, _pending = await asyncio.wait({alice_task}, timeout=1)
        assert alice_task in done and alice_task.cancelled()
        with pytest.raises(asyncio.CancelledError):
            await alice_task
        assert manager.is_active("parent", "bob")
        assert store.get("parent", "bob") is not None

        assert await manager.stop("parent", "bob", bob["job_id"])
        with pytest.raises(asyncio.CancelledError):
            await bob_task

    asyncio.run(scenario())


def test_restart_marks_running_job_interrupted(tmp_path):
    path = str(tmp_path / "group.db")
    first = GroupCoordinationStore(path)
    first.create_run("job", "parent", "alice", {"phase": "building"})
    reopened = GroupCoordinationStore(path)
    run = reopened.get_run("parent", "alice", "job")
    assert run["status"] == "interrupted"
    assert run["state"]["phase"] == "building"


def test_process_cancellation_marks_team_run_interrupted_not_user_stopped(tmp_path):
    started = asyncio.Event()

    async def runner(*_args, **_kwargs):
        started.set()
        await asyncio.Event().wait()

    path = str(tmp_path / "group-shutdown.db")
    store = GroupCoordinationStore(path)
    manager = GroupRunManager(store, runner=runner)

    async def scenario():
        run = await manager.start("parent", "alice", board(), {"builder": "s1"})
        task = manager._tasks[run["job_id"]]
        await started.wait()
        # Model server/event-loop teardown directly; user Stop goes through
        # manager.stop(), which durably records "stopping" before cancellation.
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        after_cancel = store.get_run("parent", "alice", run["job_id"])
        reopened = GroupCoordinationStore(path)
        after_restart = reopened.get_run("parent", "alice", run["job_id"])
        saved_board = reopened.get("parent", "alice")
        return after_cancel, after_restart, saved_board

    after_cancel, after_restart, saved_board = asyncio.run(scenario())
    assert after_cancel["status"] == "interrupted"
    assert after_restart["status"] == "interrupted"
    assert "Server stopped" in after_restart["state"]["message"]
    assert saved_board["tasks"][0]["status"] == "working"


def test_isolated_builder_and_reviewer_share_persisted_worktree(tmp_path, monkeypatch):
    from src import project_workflows

    monkeypatch.setattr(project_workflows, "resolve_repository", lambda path: path)
    created = []
    def create(owner, workspace):
        created.append((owner, workspace))
        return {"id": "a" * 32, "path": "/managed/task-a", "repository": "/repo", "commit": "deadbeef"}
    monkeypatch.setattr(project_workflows, "create_worktree", create)
    contexts = []

    async def runner(session, prompt, *, read_only, owner, context):
        contexts.append((session, read_only, context["options"]["workspace"]))
        return "review" if read_only else "builder"

    store = GroupCoordinationStore(str(tmp_path / "group-isolated.db"))
    manager = GroupRunManager(store, runner=runner)
    context = {"source_workspace": "/repo", "isolate_worktrees": True,
               "options": {"workspace": "/repo"}, "models": {"s1": "m1", "s2": "m2"}}

    async def scenario():
        run = await manager.start("parent", "alice", board(), {"builder": "s1", "reviewer": "s2"}, context)
        await manager._tasks[run["job_id"]]
        return store.get_run("parent", "alice", run["job_id"])

    run = asyncio.run(scenario())
    saved = store.get("parent", "alice")["tasks"][0]
    assert created == [("alice", "/repo")]
    assert contexts == [("s1", False, "/managed/task-a"), ("s2", True, "/managed/task-a")]
    assert run["status"] == "completed"
    assert run["state"]["worktrees"]["t1"]["path"] == "/managed/task-a"
    assert saved["work_result"].startswith("Task worktree (detached from selected Git HEAD;")
    assert "/managed/task-a" in saved["work_result"]


def test_isolated_review_retry_reuses_saved_worktree_or_fails_explicitly(tmp_path, monkeypatch):
    from src import project_workflows

    created = []
    monkeypatch.setattr(project_workflows, "create_worktree", lambda *args: created.append(args))
    monkeypatch.setattr(project_workflows, "resolve_repository", lambda path: path)
    previous = board()
    previous["tasks"][0].update(status="awaiting_review", work_result="existing builder result")
    store = GroupCoordinationStore(str(tmp_path / "group-review.db"))
    store.save("parent", "alice", previous)
    store.create_run("prior", "parent", "alice", {"worktrees": {
        "t1": {"id": "b" * 32, "path": "/managed/saved-task", "repository": "/repo", "commit": "abc"},
    }})
    store.update_run("prior", "alice", "completed", {"worktrees": {
        "t1": {"id": "b" * 32, "path": "/managed/saved-task", "repository": "/repo", "commit": "abc"},
    }})
    seen = []

    async def reviewer(session, _prompt, *, read_only, owner, context):
        seen.append((session, read_only, context["options"]["workspace"]))
        return "review complete"

    manager = GroupRunManager(store, runner=reviewer)
    context = {"source_workspace": "/repo", "isolate_worktrees": True,
               "options": {"workspace": "/repo"}}

    async def scenario():
        run = await manager.start("parent", "alice", previous, {"builder": "s1", "reviewer": "s2"}, context)
        await manager._tasks[run["job_id"]]
        return store.get_run("parent", "alice", run["job_id"])

    run = asyncio.run(scenario())
    assert run["status"] == "completed"
    assert seen == [("s2", True, "/managed/saved-task")]
    assert not created

    store.save("parent-2", "alice", previous)
    previous["tasks"][0]["review_result"] = ""
    store.save("parent-2", "alice", previous)
    manager2 = GroupRunManager(store, runner=reviewer)
    async def missing_mapping():
        run = await manager2.start("parent-2", "alice", previous, {"builder": "s1", "reviewer": "s2"}, context)
        await manager2._tasks[run["job_id"]]
        return store.get_run("parent-2", "alice", run["job_id"])
    failed = asyncio.run(missing_mapping())
    assert failed["status"] == "failed"
    assert "mapping is missing" in failed["state"]["message"]


def test_saved_worktree_controls_builder_and_reviewer_even_if_toggle_was_cleared(tmp_path, monkeypatch):
    from src import project_workflows

    monkeypatch.setattr(project_workflows, "resolve_repository", lambda path: path)
    monkeypatch.setattr(project_workflows, "create_worktree", lambda *_args: pytest.fail("must reuse saved mapping"))
    existing = board()
    existing["tasks"][0].update(status="pending", work_result="", review_result="")
    store = GroupCoordinationStore(str(tmp_path / "group-deselected.db"))
    store.save("parent", "alice", existing)
    mapping = {"t1": {"id": "d" * 32, "path": "/managed/saved", "repository": "/repo", "commit": "head"}}
    store.create_run("prior", "parent", "alice", {"worktrees": mapping})
    store.update_run("prior", "alice", "completed", {"worktrees": mapping})
    contexts = []

    async def runner(session, _prompt, *, read_only, owner, context):
        contexts.append((session, read_only, context["options"]["workspace"]))
        return "result"

    manager = GroupRunManager(store, runner=runner)
    context = {"options": {"workspace": "/repo"}, "isolate_worktrees": False}

    async def scenario():
        run = await manager.start("parent", "alice", existing,
                                  {"builder": "s1", "reviewer": "s2"}, context)
        await manager._tasks[run["job_id"]]
        return store.get_run("parent", "alice", run["job_id"])

    run = asyncio.run(scenario())
    assert run["status"] == "completed"
    assert contexts == [("s1", False, "/managed/saved"), ("s2", True, "/managed/saved")]


def test_saved_worktree_rejects_changed_selected_repository(tmp_path, monkeypatch):
    from src import project_workflows

    monkeypatch.setattr(project_workflows, "resolve_repository", lambda _path: "/different-repo")
    store = GroupCoordinationStore(str(tmp_path / "group-changed-source.db"))
    saved_board = board()
    saved_board["tasks"][0]["status"] = "pending"
    store.save("parent", "alice", saved_board)
    mapping = {"t1": {"id": "e" * 32, "path": "/managed/saved", "repository": "/repo", "commit": "head"}}
    store.create_run("prior", "parent", "alice", {"worktrees": mapping})
    store.update_run("prior", "alice", "completed", {"worktrees": mapping})
    calls = []

    async def runner(*_args, **_kwargs):
        calls.append(True)
        return "unexpected"

    manager = GroupRunManager(store, runner=runner)
    context = {"options": {"workspace": "/other-repo"}, "isolate_worktrees": False}

    async def scenario():
        run = await manager.start("parent", "alice", saved_board,
                                  {"builder": "s1", "reviewer": "s2"}, context)
        await manager._tasks[run["job_id"]]
        return store.get_run("parent", "alice", run["job_id"])

    run = asyncio.run(scenario())
    assert run["status"] == "failed"
    assert "workspace changed" in run["state"]["message"]
    assert not calls


def test_stop_during_worktree_creation_preserves_created_path(tmp_path, monkeypatch):
    from src import project_workflows

    started = threading.Event()
    release = threading.Event()

    def create(_owner, _source):
        started.set()
        release.wait(timeout=5)
        return {"id": "c" * 32, "path": "/managed/slow", "repository": "/repo", "commit": "head"}

    monkeypatch.setattr(project_workflows, "create_worktree", create)
    store = GroupCoordinationStore(str(tmp_path / "group-stopping-create.db"))
    manager = GroupRunManager(store, runner=lambda *args, **kwargs: "unused")
    context = {"source_workspace": "/repo", "isolate_worktrees": True,
               "options": {"workspace": "/repo"}}

    async def scenario():
        run = await manager.start("parent", "alice", board(), {"builder": "s1", "reviewer": "s2"}, context)
        await asyncio.to_thread(started.wait, 3)
        assert await manager.stop("parent", "alice", run["job_id"])
        release.set()
        try:
            await manager._tasks[run["job_id"]]
        except asyncio.CancelledError:
            pass
        return store.get_run("parent", "alice", run["job_id"])

    run = asyncio.run(scenario())
    assert run["status"] == "stopped"
    assert run["state"]["worktrees"]["t1"]["path"] == "/managed/slow"
