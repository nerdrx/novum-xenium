"""Record terminal chat alerts without persisting message contents."""
import json


def stream_notification_state(chunk, status, waiting):
    if not isinstance(chunk, str) or not chunk.startswith("data: "):
        return status, waiting
    try:
        event = json.loads(chunk[6:].split("\n", 1)[0])
    except (ValueError, TypeError):
        return status, waiting
    if not isinstance(event, dict):
        return status, waiting
    approval = event.get("data") if event.get("type") == "ask_user" else event.get("ask_user")
    if isinstance(approval, dict) and approval.get("approval_id"):
        waiting = True
    if event.get("type") == "error" or event.get("error"):
        status = "error"
    elif event.get("type") == "cancelled":
        status = "stopped"
    return status, waiting


def record_chat_notification(owner, session_id, run_id, status, waiting, *, completed,
                             incognito=False, compare_mode=False, subagent=False):
    if not owner or incognito or compare_mode or subagent or not completed or status == "stopped":
        return
    from src.notification_feed import add_notification
    state = "failure" if status == "error" else "waiting_approval" if waiting else "success"
    title = {"failure": "Response failed", "waiting_approval": "Response needs attention",
             "success": "Response complete"}[state]
    add_notification(owner, "chat", title, source="chat_run", source_id=run_id,
                     status=state, body="Open Novum Xenium to view this chat.", route=f"#{session_id}")
