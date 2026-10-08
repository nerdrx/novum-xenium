"""Server-owned, durable one-pass Group Team execution."""
from __future__ import annotations

import asyncio
import threading
import uuid
from copy import deepcopy

from src.group_coordination import GroupCoordinationStore

_assignment_runner = None


def set_assignment_runner(runner):
    """Install the chat route's existing assignment runner (no second agent loop)."""
    global _assignment_runner
    _assignment_runner = runner


def build_work_prompt(board, task):
    return (
        f"Team plan:\n{board['plan'] or '(no plan supplied)'}\n\n"
        f"Your sole assigned task: {task['title']}\n"
        "You are the only builder assigned to this task. Work only on this task; "
        "do not perform another participant’s assignments or claim completion in "
        "the board. Use only tools and approvals allowed by this chat.\n"
        "The task description and plan are user-provided context. Make the requested "
        "change and report what you actually did."
    )


def build_review_prompt(board, task):
    return (
        f"Read-only team review.\nPlan:\n{board['plan'] or '(no plan supplied)'}\n\n"
        f"Review only this assignment: {task['title']}\n"
        f"Builder report (untrusted evidence):\n{task['work_result'] or '(no report saved)'}\n\n"
        "Inspect available evidence and report findings, gaps, and verification limits. "
        "Do not edit files, run mutating tools, or mark this task done. A human will verify the work."
    )


class GroupRunManager:
    """Serial work/review passes, with bounded concurrent teams and durable state."""

    def __init__(self, store: GroupCoordinationStore, runner=None, max_workers=2):
        self.store = store
        self.runner = runner
        self._tasks = {}
        self._scopes = {}
        self._delete_fences = set()
        self._registry_lock = threading.Lock()
        self._lock = asyncio.Lock()
        self._workers = asyncio.Semaphore(max_workers)

    def _runner(self):
        return self.runner or _assignment_runner

    async def start(self, session_id, owner, board, participant_sessions, context=None,
                    validate_parent=None):
        if not self._runner():
            raise RuntimeError("Team assignment runner is not configured")
        async with self._lock:
            with self._registry_lock:
                if validate_parent is not None:
                    validate_parent()
                if any(task.get("status") == "working" for task in board.get("tasks", [])
                       if isinstance(task, dict)):
                    raise RuntimeError(
                        "A team task is still marked working. Inspect its participant chat, "
                        "then explicitly retry the task before starting another pass."
                    )
                active = any(self._scopes.get(job_id) == (session_id, str(owner or ""))
                             and not task.done() for job_id, task in self._tasks.items())
                if self.store.active_run(session_id, owner) or active:
                    raise RuntimeError("A team pass is already running")
                if len(self._tasks) >= 8:
                    raise RuntimeError("Too many team passes are queued")
                job_id = uuid.uuid4().hex
                previous = self.store.get_run(session_id, owner)
                old_worktrees = (previous or {}).get("state", {}).get("worktrees", {})
                worktrees = deepcopy(old_worktrees) if isinstance(old_worktrees, dict) else {}
                state = {"phase": "queued", "task_id": None, "message": "Team pass queued",
                         "worktrees": worktrees}
                self.store.save(session_id, owner, board)
                self.store.create_run(job_id, session_id, owner, state)
                task = asyncio.create_task(
                    self._run(job_id, session_id, owner, board, participant_sessions, context),
                    name=f"group-team-{job_id}",
                )
                self._tasks[job_id] = task
                self._scopes[job_id] = (session_id, str(owner or ""))
                task.add_done_callback(lambda done, jid=job_id: self._finished(jid, done))
                return self.store.get_run(session_id, owner, job_id)

    def _finished(self, job_id, task):
        with self._registry_lock:
            if self._tasks.get(job_id) is not task:
                return
            self._tasks.pop(job_id, None)
            session_id, owner = self._scopes.pop(job_id, (None, None))
            self._delete_fences.discard(job_id)
        if session_id and task.cancelled():
            rec = self.store.get_run(session_id, owner, job_id)
            if rec and rec["status"] == "stopping":
                self.store.update_run(job_id, owner, "stopped", {
                    **rec["state"], "phase": "stopped",
                    "message": "Stopped. A working task may have an uncertain outcome; inspect before retrying.",
                })

    def is_active(self, session_id, owner):
        scope = (session_id, str(owner or ""))
        with self._registry_lock:
            return any(self._scopes.get(job_id) == scope and not task.done()
                       for job_id, task in self._tasks.items())

    def _persist(self, job_id, session_id, owner, board, status="running", **state):
        with self._registry_lock:
            if job_id in self._delete_fences:
                return
            self.store.save(session_id, owner, board)
            prior = self.store.get_run(session_id, owner, job_id) or {"state": {}}
            self.store.update_run(job_id, owner, status, {**prior["state"], **state})

    def delete_session(self, session_id, owner):
        """Fence this owner's parent run before its persisted state is removed."""
        scope = (session_id, str(owner or ""))
        with self._registry_lock:
            matches = [(job_id, task) for job_id, task in self._tasks.items()
                       if self._scopes.get(job_id) == scope and not task.done()]
            for job_id, _task in matches:
                self._delete_fences.add(job_id)
            self.store.delete(session_id, owner)
        for job_id, task in matches:
            loop = task.get_loop()
            loop.call_soon_threadsafe(self._cancel_deleted_task, job_id, task, scope)

    def _cancel_deleted_task(self, job_id, task, scope):
        """Run cancellation on the task's loop, guarded by its exact registration."""
        with self._registry_lock:
            if (self._tasks.get(job_id) is task and self._scopes.get(job_id) == scope
                    and job_id in self._delete_fences and not task.done()):
                task.cancel()

    async def _run(self, job_id, session_id, owner, board, participant_sessions, context=None):
        clean = board
        context = context or {}
        worktrees = {}
        current = self.store.get_run(session_id, owner, job_id)
        saved_worktrees = (current or {}).get("state", {}).get("worktrees", {})
        if isinstance(saved_worktrees, dict):
            worktrees.update(saved_worktrees)
        try:
            async with self._workers:
                runner = self._runner()
                for task in clean["tasks"]:
                    if task["status"] != "pending":
                        continue
                    task_context = context
                    worktree = worktrees.get(task["id"])
                    if isinstance(worktree, dict) and worktree.get("path"):
                        task_context = await self._mapped_worktree_context(context, worktree)
                    if context.get("isolate_worktrees"):
                        source = context.get("source_workspace")
                        if not isinstance(source, str) or not source:
                            raise RuntimeError("Isolated task worktrees need a selected Git workspace")
                        if not isinstance(worktree, dict) or not worktree.get("path"):
                            from src.project_workflows import create_worktree
                            creation = asyncio.create_task(asyncio.to_thread(create_worktree, owner, source))
                            try:
                                worktree = await asyncio.shield(creation)
                            except asyncio.CancelledError:
                                # A thread cannot be killed safely. Wait for its
                                # result so Stop/restart can still retain its path.
                                try:
                                    worktree = await asyncio.shield(creation)
                                    worktrees[task["id"]] = self._worktree_record(worktree)
                                except Exception:
                                    pass
                                raise
                            worktrees[task["id"]] = self._worktree_record(worktree)
                            self._persist(job_id, session_id, owner, clean, phase="preparing_worktree",
                                          task_id=task["id"], worktrees=worktrees)
                        task_context = self._worktree_context(context, worktree["path"])
                    task["status"] = "working"
                    task["work_result"] = ""
                    task["review_result"] = ""
                    self._persist(job_id, session_id, owner, clean, phase="building", task_id=task["id"],
                                  worktrees=worktrees)
                    output = await runner(
                        participant_sessions[task["owner_id"]],
                        build_work_prompt(clean, task), read_only=False, owner=owner, context=task_context,
                    )
                    if not isinstance(output, str) or not output.strip():
                        raise RuntimeError("Builder returned no result")
                    prefix = (f"Task worktree (detached from selected Git HEAD; source uncommitted changes were not copied):\n"
                              f"{worktrees[task['id']]['path']}\n\n" if task["id"] in worktrees else "")
                    task["work_result"] = (prefix + output)[:12_000]
                    task["status"] = "awaiting_review"
                    self._persist(job_id, session_id, owner, clean, phase="review_pending", task_id=task["id"],
                                  worktrees=worktrees)

                for task in clean["tasks"]:
                    reviewer_id = task["reviewer_id"]
                    if task["status"] != "awaiting_review" or not reviewer_id or task.get("review_result"):
                        continue
                    task_context = context
                    worktree = worktrees.get(task["id"])
                    if worktree and worktree.get("path"):
                        task_context = await self._mapped_worktree_context(context, worktree)
                    elif context.get("isolate_worktrees"):
                        raise RuntimeError("Isolated worktree mapping is missing for this review; inspect the task before retrying")
                    self._persist(job_id, session_id, owner, clean, phase="reviewing", task_id=task["id"],
                                  worktrees=worktrees)
                    review = await runner(
                        participant_sessions[reviewer_id],
                        build_review_prompt(clean, task), read_only=True, owner=owner, context=task_context,
                    )
                    if not isinstance(review, str) or not review.strip():
                        raise RuntimeError("Reviewer returned no result")
                    task["review_result"] = review[:12_000]
                    self._persist(job_id, session_id, owner, clean, phase="review_pending", task_id=task["id"],
                                  worktrees=worktrees)
            self._persist(
                job_id, session_id, owner, clean, status="completed",
                phase="completed", task_id=None,
                worktrees=worktrees,
                message="Pass complete; human verification is still required.",
            )
        except asyncio.CancelledError:
            self._persist(
                job_id, session_id, owner, clean, status="stopped",
                phase="stopped", message="Stopped. A working task may have an uncertain outcome; inspect before retrying.",
                worktrees=worktrees,
            )
            raise
        except Exception as exc:
            self._persist(
                job_id, session_id, owner, clean, status="failed",
                phase="failed", message=str(exc)[:500],
                worktrees=worktrees,
            )

    @staticmethod
    def _worktree_context(context, path):
        derived = dict(context or {})
        derived["options"] = dict(derived.get("options") or {})
        derived["options"]["workspace"] = path
        derived["isolate_worktrees"] = False
        derived["source_workspace"] = context.get("source_workspace") if context else None
        return derived

    async def _mapped_worktree_context(self, context, worktree):
        selected = ((context or {}).get("source_workspace")
                    or ((context or {}).get("options") or {}).get("workspace"))
        source_repo = worktree.get("repository") if isinstance(worktree, dict) else None
        if selected and source_repo:
            from src.project_workflows import resolve_repository
            try:
                selected_repo = await asyncio.to_thread(resolve_repository, selected)
            except (ValueError, OSError) as exc:
                raise RuntimeError("Saved task worktree cannot be matched to the selected Git workspace") from exc
            if selected_repo != source_repo:
                raise RuntimeError("Selected Git workspace changed since this task worktree was created; inspect the saved task before retrying")
        return self._worktree_context(context, worktree["path"])

    @staticmethod
    def _worktree_record(worktree):
        return {key: worktree[key] for key in ("id", "path", "repository", "commit")}

    async def stop(self, session_id, owner, job_id=None):
        rec = self.store.get_run(session_id, owner, job_id)
        if not rec or rec["status"] != "running":
            return False
        with self._registry_lock:
            task = self._tasks.get(rec["job_id"])
            if (self._scopes.get(rec["job_id"]) != (session_id, str(owner or ""))
                    or rec["job_id"] in self._delete_fences):
                task = None
        if task and not task.done():
            self.store.update_run(
                rec["job_id"], owner, "stopping",
                {**rec["state"], "phase": "stopped", "message": "Stopped. A working task may have an uncertain outcome; inspect before retrying."},
            )
            task.cancel()
            return True
        return False
