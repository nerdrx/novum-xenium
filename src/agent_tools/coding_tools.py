import hashlib
import json
import os
import re
from typing import Any, Dict, List

from src.constants import DATA_DIR


_TODO_DIR = os.path.join(DATA_DIR, "agent_todos")
_MAX_TODOS = 20
_MAX_TODO_CHARS = 500
_MAX_TODO_FILE_BYTES = 64 * 1024
_TODO_STATUSES = {"pending", "in_progress", "completed"}
_TODO_PRIORITIES = {"low", "medium", "high"}


def _safe_session_id(value: str) -> str:
    value = value or "current"
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", value)[:120] or "current"


def _scoped_todo_path(owner: str, session_id: str) -> str:
    key = f"{owner}\0{session_id}".encode("utf-8")
    return os.path.join(_TODO_DIR, hashlib.sha256(key).hexdigest() + ".json")


def read_todos(ctx: dict) -> List[Dict[str, Any]]:
    """Load only owner/session-bound task state; legacy files are write-only."""
    owner, session_id = ctx.get("owner"), ctx.get("session_id")
    if ctx.get("incognito") or not owner or not session_id:
        return []
    try:
        with open(_scoped_todo_path(str(owner), str(session_id)), "rb") as f:
            raw = f.read(_MAX_TODO_FILE_BYTES + 1)
        if len(raw) > _MAX_TODO_FILE_BYTES:
            return []
        todos = json.loads(raw).get("todos", [])
    except (OSError, ValueError, TypeError, AttributeError):
        return []
    if not isinstance(todos, list):
        return []
    restored = []
    for item in todos[:_MAX_TODOS]:
        if not isinstance(item, dict):
            continue
        content = str(item.get("content", ""))[:_MAX_TODO_CHARS]
        status = item.get("status", "pending")
        priority = item.get("priority", "medium")
        if (content and isinstance(status, str) and status in _TODO_STATUSES
                and isinstance(priority, str) and priority in _TODO_PRIORITIES):
            restored.append({"content": content, "status": status, "priority": priority})
    return restored


class TodoWriteTool:
    async def execute(self, content: str, ctx: dict) -> dict:
        try:
            args = json.loads(content) if (content or "").strip().startswith("{") else {"todos": []}
        except (json.JSONDecodeError, TypeError):
            return {"error": "todowrite: JSON object required", "exit_code": 1}
        todos = args.get("todos")
        if not isinstance(todos, list):
            return {"error": "todowrite: todos must be a list", "exit_code": 1}

        normalized: List[Dict[str, Any]] = []
        if len(todos) > _MAX_TODOS:
            return {"error": f"todowrite: at most {_MAX_TODOS} todos are allowed", "exit_code": 1}
        active_count = 0
        for item in todos:
            if not isinstance(item, dict):
                return {"error": "todowrite: each todo must be an object", "exit_code": 1}
            content_text = str(item.get("content") or item.get("text") or "").strip()
            if not content_text:
                return {"error": "todowrite: todo content required", "exit_code": 1}
            if len(content_text) > _MAX_TODO_CHARS:
                return {"error": f"todowrite: each todo must be at most {_MAX_TODO_CHARS} characters", "exit_code": 1}
            status = str(item.get("status") or "pending").strip()
            if status not in _TODO_STATUSES:
                return {"error": f"todowrite: invalid status {status!r}", "exit_code": 1}
            if status == "in_progress":
                active_count += 1
            priority = str(item.get("priority") or "medium").strip()
            if priority not in _TODO_PRIORITIES:
                return {"error": f"todowrite: invalid priority {priority!r}", "exit_code": 1}
            normalized.append({
                "content": content_text,
                "status": status,
                "priority": priority,
            })
        if active_count > 1:
            return {"error": "todowrite: only one todo can be in_progress", "exit_code": 1}

        session_id = _safe_session_id(str(ctx.get("session_id") or args.get("session_id") or "current"))
        owner = ctx.get("owner")
        # Preserve the old write location for callers without owner context;
        # restoration deliberately never reads it.
        path = (_scoped_todo_path(str(owner), str(ctx["session_id"]))
                if owner and ctx.get("session_id") else
                os.path.join(_TODO_DIR, f"{session_id}.json"))
        if ctx.get("incognito"):
            return {"output": "Todo list kept for this turn only.", "exit_code": 0, "todos": normalized}
        os.makedirs(_TODO_DIR, exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump({"todos": normalized}, f, ensure_ascii=False, indent=2)

        lines = []
        for item in normalized:
            marker = {"pending": " ", "in_progress": ">", "completed": "x"}[item["status"]]
            lines.append(f"[{marker}] {item['content']} ({item['priority']})")
        return {
            "output": "Updated todo list:\n" + ("\n".join(lines) if lines else "(empty)"),
            "exit_code": 0,
            "todos": normalized,
        }
