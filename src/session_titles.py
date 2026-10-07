"""Small helpers for request-derived chat titles and their provenance."""

import json
import re


_TIME_SUFFIX = re.compile(r"\s+\d{1,2}:\d{2}:\d{2}(?:\s*(?:AM|PM))?$", re.IGNORECASE)


def message_text(content) -> str:
    if isinstance(content, list):
        return "\n".join(
            item["text"] for item in content
            if isinstance(item, dict) and isinstance(item.get("text"), str)
        ).strip()
    if isinstance(content, str) and content.lstrip().startswith("["):
        try:
            blocks = json.loads(content)
        except (json.JSONDecodeError, TypeError, ValueError):
            blocks = None
        if isinstance(blocks, list):
            return message_text(blocks)
    return content.strip() if isinstance(content, str) else ""


def first_user_message(history) -> str:
    if hasattr(history, "history"):
        history = history.history
    for message in history or []:
        role = message.get("role") if isinstance(message, dict) else getattr(message, "role", None)
        if role != "user":
            continue
        content = message.get("content", "") if isinstance(message, dict) else getattr(message, "content", "")
        return message_text(content)
    return ""


def request_title(message: str, *, group: bool = False) -> str:
    text = " ".join((message or "").split())
    if len(text) > 64:
        truncated = text[:63]
        if " " in truncated:
            truncated = truncated.rsplit(" ", 1)[0] or truncated
        text = truncated.rstrip(".,!?;:") + "…"
    title = f"Chat: {text}" if text else "Chat"
    return f"[GRP] {title}" if group else title


def is_legacy_placeholder(name: str, model: str = "") -> bool:
    """Recognize only established model/time names and generated group labels."""
    title = (name or "").strip()
    model_name = (model or "").strip().rstrip("/").rsplit("/", 1)[-1]
    candidate = title
    group = candidate.startswith("[GRP] ")
    if group:
        candidate = candidate[6:].strip()
        # Parent sessions list multiple participant labels; hidden participant
        # sessions contain one and remain useful identifiers.
        if candidate.count(",") < 1:
            return False
        return True
    if model_name and candidate.casefold() == model_name.casefold():
        return True
    if candidate.casefold() == "chat" or candidate.casefold().startswith("chat:"):
        return True
    if model_name and candidate.casefold().startswith(model_name.casefold() + " "):
        return bool(_TIME_SUFFIX.search(candidate[len(model_name):]))
    return bool(_TIME_SUFFIX.search(candidate))


def needs_auto_name(name: str, model: str = "", name_is_custom=None, first_message: str = "") -> bool:
    """Whether a persisted or in-flight name is known to be application-owned."""
    if name_is_custom is True:
        return False
    title = (name or "").strip()
    if name_is_custom is False:
        return not title or is_legacy_placeholder(title, model) or (
            first_message and title in {
                request_title(first_message), request_title(first_message, group=True)
            }
        )
    if not title or is_legacy_placeholder(title, model):
        return True
    return bool(first_message and title in {
        request_title(first_message), request_title(first_message, group=True)
    })


def display_title(name: str, model: str, name_is_custom, first_message: str) -> str:
    if not first_message or not needs_auto_name(name, model, name_is_custom, first_message):
        return name
    return request_title(first_message, group=(name or "").strip().startswith("[GRP] "))
