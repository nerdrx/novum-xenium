"""Owner-scoped storage and validation for opt-in Group Team boards."""
from __future__ import annotations

import json
import os
import sqlite3
import time
from pathlib import Path

from src.constants import DATA_DIR

_MAX_PLAN = 8_000
_MAX_TASKS = 32
_MAX_RESULT = 12_000
_MAX_REVIEW = 12_000
_STATUSES = {"pending", "working", "awaiting_review", "done"}
_ROLES = {"builder", "reviewer"}


def validate_board(raw):
    if not isinstance(raw, dict):
        raise ValueError("Board must be an object")
    if len(json.dumps(raw, ensure_ascii=False)) > 600_000:
        raise ValueError("Board is too large")
    plan = raw.get("plan", "")
    participants = raw.get("participants", [])
    tasks = raw.get("tasks", [])
    if not isinstance(plan, str) or len(plan) > _MAX_PLAN:
        raise ValueError("Plan is too long")
    if not isinstance(participants, list) or not 1 <= len(participants) <= 8:
        raise ValueError("Board needs one to eight participants")
    if not isinstance(tasks, list) or len(tasks) > _MAX_TASKS:
        raise ValueError("Board has too many tasks")

    clean_people = []
    by_id = {}
    for item in participants:
        if not isinstance(item, dict):
            raise ValueError("Invalid participant")
        pid = item.get("id")
        display = item.get("display", "")
        role = item.get("role")
        if (not isinstance(pid, str) or not pid or len(pid) > 256 or pid in by_id
                or not isinstance(display, str) or len(display) > 256
                or not isinstance(role, str) or role not in _ROLES):
            raise ValueError("Invalid or duplicate participant")
        person = {"id": pid, "display": display, "role": role}
        by_id[pid] = person
        clean_people.append(person)

    clean_tasks = []
    task_ids = set()
    for item in tasks:
        if not isinstance(item, dict):
            raise ValueError("Invalid task")
        task_id = item.get("id")
        title = item.get("title")
        owner_id = item.get("owner_id")
        reviewer_id = item.get("reviewer_id") or ""
        status = item.get("status", "pending")
        result = item.get("work_result", "")
        review_result = item.get("review_result", "")
        if (not isinstance(task_id, str) or not task_id or len(task_id) > 80 or task_id in task_ids
                or not isinstance(title, str) or not title.strip() or len(title) > 500
                or not isinstance(owner_id, str) or not isinstance(reviewer_id, str)
                or owner_id not in by_id or by_id[owner_id]["role"] != "builder"
                or not isinstance(status, str) or status not in _STATUSES or reviewer_id and (
                    reviewer_id not in by_id or by_id[reviewer_id]["role"] != "reviewer"
                    or reviewer_id == owner_id
                )
                or not isinstance(result, str) or not isinstance(review_result, str)):
            raise ValueError("Invalid task assignment")
        task_ids.add(task_id)
        clean_task = {
            "id": task_id, "title": title.strip(), "owner_id": owner_id,
            "reviewer_id": reviewer_id, "status": status,
            "work_result": result[:_MAX_RESULT],
        }
        if "review_result" in item:
            clean_task["review_result"] = review_result[:_MAX_REVIEW]
        clean_tasks.append(clean_task)
    return {"plan": plan, "participants": clean_people, "tasks": clean_tasks}


class GroupCoordinationStore:
    def __init__(self, path=None):
        self.path = path or os.path.join(DATA_DIR, "group_coordination.db")
        Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as db:
            db.execute(
                "CREATE TABLE IF NOT EXISTS group_team_boards ("
                "session_id TEXT NOT NULL, owner TEXT NOT NULL, board TEXT NOT NULL, updated REAL NOT NULL, "
                "PRIMARY KEY(session_id, owner))"
            )
            db.execute(
                "CREATE TABLE IF NOT EXISTS group_team_runs ("
                "job_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, owner TEXT NOT NULL, "
                "status TEXT NOT NULL, state TEXT NOT NULL, updated REAL NOT NULL)"
            )
            # A process restart cannot resume an in-flight model call safely.
            # Keep its partial board and make the interrupted state explicit.
            db.execute(
                "UPDATE group_team_runs SET status='interrupted', updated=? WHERE status IN ('running','stopping')",
                (time.time(),),
            )
        if os.name == "posix":
            os.chmod(self.path, 0o600)

    def _connect(self):
        db = sqlite3.connect(self.path, timeout=5)
        db.execute("PRAGMA busy_timeout=5000")
        return db

    def get(self, session_id, owner):
        with self._connect() as db:
            row = db.execute(
                "SELECT board FROM group_team_boards WHERE session_id=? AND owner=?",
                (session_id, str(owner or "")),
            ).fetchone()
        if row is None:
            return None
        try:
            return validate_board(json.loads(row[0]))
        except (ValueError, TypeError, json.JSONDecodeError):
            return None

    def save(self, session_id, owner, board):
        clean = validate_board(board)
        with self._connect() as db:
            db.execute(
                "INSERT INTO group_team_boards(session_id, owner, board, updated) VALUES(?,?,?,?) "
                "ON CONFLICT(session_id,owner) DO UPDATE SET board=excluded.board, updated=excluded.updated",
                (session_id, str(owner or ""), json.dumps(clean, ensure_ascii=False), time.time()),
            )
        return clean

    def delete(self, session_id, owner):
        """Remove one owner's board when its parent session is permanently deleted."""
        with self._connect() as db:
            db.execute(
                "DELETE FROM group_team_boards WHERE session_id=? AND owner=?",
                (session_id, str(owner or "")),
            )
            db.execute(
                "DELETE FROM group_team_runs WHERE session_id=? AND owner=?",
                (session_id, str(owner or "")),
            )

    def create_run(self, job_id, session_id, owner, state):
        with self._connect() as db:
            db.execute(
                "INSERT INTO group_team_runs(job_id,session_id,owner,status,state,updated) VALUES(?,?,?,'running',?,?)",
                (job_id, session_id, str(owner or ""), json.dumps(state), time.time()),
            )

    def update_run(self, job_id, owner, status, state):
        with self._connect() as db:
            db.execute(
                "UPDATE group_team_runs SET status=?,state=?,updated=? WHERE job_id=? AND owner=?",
                (status, json.dumps(state, ensure_ascii=False), time.time(), job_id, str(owner or "")),
            )

    def get_run(self, session_id, owner, job_id=None):
        with self._connect() as db:
            if job_id:
                row = db.execute(
                    "SELECT job_id,status,state,updated FROM group_team_runs WHERE session_id=? AND owner=? AND job_id=?",
                    (session_id, str(owner or ""), job_id),
                ).fetchone()
            else:
                row = db.execute(
                    "SELECT job_id,status,state,updated FROM group_team_runs WHERE session_id=? AND owner=? ORDER BY updated DESC LIMIT 1",
                    (session_id, str(owner or "")),
                ).fetchone()
        if row is None:
            return None
        return {"job_id": row[0], "status": row[1], "state": json.loads(row[2]), "updated": row[3]}

    def active_run(self, session_id, owner):
        with self._connect() as db:
            row = db.execute(
                "SELECT job_id FROM group_team_runs WHERE session_id=? AND owner=? AND status IN ('running','stopping') LIMIT 1",
                (session_id, str(owner or "")),
            ).fetchone()
        return row[0] if row else None
