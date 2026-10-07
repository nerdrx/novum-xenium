from __future__ import annotations

import os
import asyncio
import subprocess
import sys

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from routes.project_routes import setup_project_routes
from src import project_workflows as workflows


def git(repo, *args):
    return subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True, text=True).stdout.strip()


@pytest.fixture
def repo(tmp_path, monkeypatch):
    root = tmp_path / "repo"
    root.mkdir()
    git(root, "init", "-q")
    git(root, "config", "user.email", "test@example.invalid")
    git(root, "config", "user.name", "Test")
    (root / "README.md").write_text("project\n", encoding="utf-8")
    (root / "AGENTS.md").write_text("Review this guidance; never execute it.\n", encoding="utf-8")
    (root / ".gitignore").write_text("ignored.txt\n", encoding="utf-8")
    git(root, "add", "README.md", "AGENTS.md", ".gitignore")
    git(root, "commit", "-qm", "initial")
    monkeypatch.setattr(workflows, "get_default_data_dir", lambda: str(tmp_path / "data"))
    monkeypatch.setenv("ODYSSEUS_PROJECT_WORKTREE_ROOT", str(tmp_path / "managed"))
    return root


def test_inspect_returns_bounded_reviewable_guidance(repo):
    report = workflows.inspect_project("alice", str(repo))
    assert report["repository"] == str(repo)
    assert "README.md" in report["workspace_map"]
    assert report["instructions"][0]["path"] == "AGENTS.md"
    assert "never execute it" in report["instructions"][0]["content"]
    assert "never executed automatically" in report["instructions"][0]["notice"]


def test_prompt_context_uses_only_applicable_ancestor_instructions(repo):
    (repo / "src").mkdir()
    (repo / "tests").mkdir()
    (repo / "src" / "AGENTS.md").write_text("src-specific rule\n", encoding="utf-8")
    (repo / "tests" / "AGENTS.md").write_text("unrelated test rule\n", encoding="utf-8")
    (repo / "package.json").write_text('{"scripts":{"test":"node test.js"}}', encoding="utf-8")
    context = workflows.project_prompt_context("alice", str(repo / "src"), max_chars=3000)
    assert "Review this guidance" in context
    assert "src-specific rule" in context
    assert "unrelated test rule" not in context
    assert "node test.js" in context
    assert "not executed" in context
    assert len(context) <= 3000


def test_worktree_owner_scope_verification_and_dirty_cleanup(repo):
    created = workflows.create_worktree("alice", str(repo))
    path = created["path"]
    assert os.path.isdir(path)
    assert workflows.list_worktrees("bob") == []
    with pytest.raises(workflows.ProjectWorkflowError, match="Unknown managed"):
        workflows.remove_worktree("bob", created["id"])

    workflows.save_verification_config("alice", str(repo), [
        {"name": "passes", "argv": [sys.executable, "-c", "print('ok')"], "required": True},
        {"name": "fails", "argv": [sys.executable, "-c", "raise SystemExit(7)"], "required": True},
    ])
    report = asyncio.run(workflows.run_verification("alice", created["id"]))
    assert [item["passed"] for item in report["results"]] == [True, False]
    assert report["complete"] is False

    workflows.save_verification_config("alice", str(repo), [
        {"name": "passes", "argv": [sys.executable, "-c", "print('ok')"], "required": True},
    ])
    report = asyncio.run(workflows.run_verification("alice", created["id"]))
    assert report["required_checks_passed"] is True
    assert report["complete"] is True

    with open(os.path.join(path, "uncommitted.txt"), "w", encoding="utf-8") as stream:
        stream.write("keep me\n")
    with pytest.raises(workflows.ProjectWorkflowError, match="modified, untracked"):
        workflows.remove_worktree("alice", created["id"])
    assert os.path.exists(os.path.join(path, "uncommitted.txt"))
    assert workflows.list_worktrees("alice")


def test_ignored_worktree_files_are_preserved(repo):
    created = workflows.create_worktree("alice", str(repo))
    ignored = os.path.join(created["path"], "ignored.txt")
    with open(ignored, "w", encoding="utf-8") as stream:
        stream.write("keep ignored content\n")
    with pytest.raises(workflows.ProjectWorkflowError, match="ignored files"):
        workflows.remove_worktree("alice", created["id"])
    assert os.path.exists(ignored)


def test_workspace_verification_persists_and_invalidates_on_edits(repo):
    created = workflows.create_worktree("alice", str(repo))
    workflows.save_verification_config("alice", str(repo), [
        {"name": "check", "argv": [sys.executable, "-c", "print('ok')"], "required": True},
    ], auto_run_on_completion=True)
    report = asyncio.run(workflows.run_workspace_verification("alice", created["path"]))
    assert report["managed"] is True
    assert report["complete"] is True
    assert workflows.get_workspace_verification_status("alice", created["path"])["complete"] is True
    with open(os.path.join(created["path"], "README.md"), "a", encoding="utf-8") as stream:
        stream.write("changed\n")
    status = workflows.get_workspace_verification_status("alice", created["path"])
    assert status["state"] == "stale"
    assert status["complete"] is False


@pytest.mark.parametrize("change", [
    {"argv": [sys.executable, "-c", "raise SystemExit(1)"]},
    {"required": False},
    {"timeout_seconds": 121},
    {"name": "renamed check"},
])
def test_verification_config_changes_invalidate_saved_evidence(repo, change):
    created = workflows.create_worktree("alice", str(repo))
    original = {"name": "check", "argv": [sys.executable, "-c", "pass"]}
    workflows.save_verification_config("alice", str(repo), [original])
    report = asyncio.run(workflows.run_verification("alice", created["id"]))
    assert report["complete"] is True

    workflows.save_verification_config("alice", str(repo), [{**original, **change}])
    status = workflows.get_workspace_verification_status("alice", created["path"])

    assert status["state"] == "stale"
    assert status["complete"] is False
    assert "checks changed" in status["reason"]
    assert status["previous_report"]["complete"] is True
    # Invalidating the current gate must retain the prior report as evidence.
    stored = workflows._read_json(
        workflows._store_dir("alice") / f"verification-{created['id']}.json", {}
    )
    assert stored["complete"] is True


def test_equivalent_verification_check_defaults_keep_evidence_current(repo):
    created = workflows.create_worktree("alice", str(repo))
    workflows.save_verification_config("alice", str(repo), [{
        "name": "check", "argv": [sys.executable, "-c", "pass"],
    }])
    report = asyncio.run(workflows.run_verification("alice", created["id"]))
    assert report["complete"] is True

    workflows.save_verification_config("alice", str(repo), [{
        "name": "check", "argv": [sys.executable, "-c", "pass"],
        "required": True, "timeout_seconds": 120,
    }])
    status = workflows.get_workspace_verification_status("alice", created["path"])
    assert status["complete"] is True


def test_verification_does_not_certify_worktree_changed_by_check(repo):
    created = workflows.create_worktree("alice", str(repo))
    workflows.save_verification_config("alice", str(repo), [{
        "name": "mutates source",
        "argv": [sys.executable, "-B", "-c", "from pathlib import Path; Path('README.md').write_text('changed by check\\n')"],
        "required": True,
    }])
    report = asyncio.run(workflows.run_verification("alice", created["id"]))
    created_path = os.path.join(created["path"], "README.md")
    with open(created_path, encoding="utf-8") as stream:
        assert stream.read() == "changed by check\n"
    assert report["workspace_changed_during_checks"] is True
    assert report["checked_dirty_fingerprint"] != report["dirty_fingerprint"]
    assert report["complete"] is False
    gate = next(item for item in report["results"] if item["name"] == "Workspace unchanged during checks")
    assert gate["passed"] is False
    assert "rerun checks" in gate["output"]


def test_verifier_bounds_output_and_kills_child_process(repo):
    if os.name == "nt":
        pytest.skip("child-process marker uses POSIX test code")
    created = workflows.create_worktree("alice", str(repo))
    workflows.save_verification_config("alice", str(repo), [{
        "name": "timeout",
        "argv": [sys.executable, "-c", (
            "import subprocess,sys,time; "
            "subprocess.Popen([sys.executable,'-c',\"import pathlib,time; time.sleep(2); pathlib.Path('child-finished').write_text('x')\"]); "
            "print('x'*100000,flush=True); time.sleep(10)"
        )],
        "required": True,
        "timeout_seconds": 1,
    }])
    report = asyncio.run(workflows.run_verification("alice", created["id"]))
    item = report["results"][0]
    assert item["timed_out"] is True
    assert len(item["output"]) < 6100
    import time
    time.sleep(2.2)
    assert not os.path.exists(os.path.join(created["path"], "child-finished"))


def test_verifier_cancellation_kills_owned_process_group(repo):
    if os.name == "nt":
        pytest.skip("process group cancellation test uses POSIX signals")
    created = workflows.create_worktree("alice", str(repo))
    started = os.path.join(created["path"], "started")
    child_done = os.path.join(created["path"], "child-done")
    parent = "import pathlib,subprocess,sys,time; subprocess.Popen([sys.executable,'-c',\"import time,pathlib;time.sleep(1.5);pathlib.Path('child-done').write_text('x')\"]); pathlib.Path('started').write_text('x'); time.sleep(20)"
    workflows.save_verification_config("alice", str(repo), [
        {"name": "long", "argv": [sys.executable, "-c", parent], "required": True},
    ])

    async def cancel_run():
        task = asyncio.create_task(workflows.run_verification("alice", created["id"], session_id="s1", run_id="r1"))
        for _ in range(100):
            if os.path.exists(started):
                break
            await asyncio.sleep(0.02)
        assert os.path.exists(started)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    asyncio.run(cancel_run())
    import time
    time.sleep(1.7)
    assert not os.path.exists(child_done)


def test_worktree_creation_disables_repository_filters(repo, tmp_path):
    if os.name == "nt":
        pytest.skip("filter-hook marker uses a POSIX command")
    marker = tmp_path / "filter-ran"
    (repo / ".gitattributes").write_text("README.md filter=tripwire\n", encoding="utf-8")
    git(repo, "add", ".gitattributes")
    git(repo, "commit", "-qm", "add filter attribute")
    git(repo, "config", "filter.tripwire.smudge", f"touch {marker}")
    record = workflows.create_worktree("alice", str(repo))
    assert not marker.exists()
    assert os.path.isfile(os.path.join(record["path"], "README.md"))


def test_routes_require_interactive_admin(monkeypatch):
    app = FastAPI()
    app.include_router(setup_project_routes())
    app.middleware("http")(
        lambda request, call_next: _set_user(request, call_next, "viewer")
    )
    monkeypatch.setattr("routes.project_routes.owner_is_admin_or_single_user", lambda user: user == "admin")
    response = TestClient(app).post("/api/project-workflows/inspect", json={"workspace": "/tmp"})
    assert response.status_code == 403


def test_project_routes_create_and_verify_managed_worktree(repo, monkeypatch):
    app = FastAPI()
    app.include_router(setup_project_routes())
    monkeypatch.setattr("routes.project_routes.get_current_user", lambda request: "admin")
    monkeypatch.setattr("routes.project_routes.storage_owner_for_request", lambda request: "alice")
    monkeypatch.setattr("routes.project_routes.owner_is_admin_or_single_user", lambda user: True)
    client = TestClient(app)
    created = client.post("/api/project-workflows/worktrees", json={"workspace": str(repo)})
    assert created.status_code == 200, created.text
    worktree = created.json()
    saved = client.put("/api/project-workflows/verification", json={
        "workspace": worktree["path"], "auto_run_on_completion": True,
        "checks": [{"name": "smoke", "argv": [sys.executable, "-c", "print('ok')"]}],
    })
    assert saved.status_code == 200, saved.text
    assert saved.json()["repository"] == str(repo)
    inherited = client.get("/api/project-workflows/verification", params={"workspace": worktree["path"]})
    assert inherited.status_code == 200
    assert inherited.json()["auto_run_on_completion"] is True
    verified = client.post(f"/api/project-workflows/worktrees/{worktree['id']}/verify")
    assert verified.status_code == 200, verified.text
    assert verified.json()["complete"] is True
    gate = asyncio.run(workflows.run_workspace_verification("alice", worktree["path"]))
    assert gate["complete"] is True


async def _set_user(request, call_next, user):
    request.state.current_user = user
    return await call_next(request)
