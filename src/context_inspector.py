"""Estimated token accounting for the main prompt components."""

from __future__ import annotations

import json
from typing import Any

from src.model_context import estimate_tokens, estimate_tool_schema_tokens


def _as_messages(value: Any) -> tuple[list[dict], int, int]:
    """Normalize prompt content and return messages, item count, characters."""
    if value is None:
        return [], 0, 0
    if isinstance(value, str):
        return ([{"role": "user", "content": value}] if value else []), int(bool(value)), len(value)
    if isinstance(value, dict):
        if "role" in value or "content" in value:
            content = value.get("content", "")
            return [value], 1, len(content) if isinstance(content, str) else len(json.dumps(content, ensure_ascii=False))
        text = json.dumps(value, ensure_ascii=False, default=str)
        return ([{"role": "user", "content": text}] if text else []), 1, len(text)
    if isinstance(value, (list, tuple)):
        items = list(value)
        if all(isinstance(item, dict) and ("role" in item or "content" in item) for item in items):
            chars = sum(
                len(content) if isinstance((content := item.get("content", "")), str)
                else len(json.dumps(content, ensure_ascii=False, default=str))
                for item in items
            )
            return items, len(items), chars
        messages, chars = [], 0
        for item in items:
            text = item if isinstance(item, str) else json.dumps(item, ensure_ascii=False, default=str)
            chars += len(text)
            messages.append({"role": "user", "content": text})
        return messages, len(messages), chars
    text = str(value)
    return ([{"role": "user", "content": text}] if text else []), int(bool(text)), len(text)


def _measure(value: Any) -> dict[str, int]:
    messages, items, characters = _as_messages(value)
    return {"tokens": int(estimate_tokens(messages)) if messages else 0,
            "items": items, "characters": characters}


def build_context_inspection(
    *,
    instructions: Any = None,
    tool_schemas: Any = None,
    memory_docs: Any = None,
    conversation: Any = None,
    tool_results: Any = None,
    archives: dict | None = None,
) -> dict:
    """Build content-free per-component token estimates for request metadata.

    `archives` describes retained tool output that is available by search, not
    text included in this request. Its token contribution is therefore zero.
    """
    schemas = tool_schemas if isinstance(tool_schemas, list) else []
    categories = {
        "instructions": _measure(instructions),
        "tool_schemas": {
            "tokens": int(estimate_tool_schema_tokens(schemas)) if schemas else 0,
            "items": len(schemas),
            "characters": len(json.dumps(schemas, ensure_ascii=False, default=str)) if schemas else 0,
        },
        "memory_docs": _measure(memory_docs),
        "conversation": _measure(conversation),
        "tool_results": _measure(tool_results),
    }
    archive_stats = archives if isinstance(archives, dict) else {}
    try:
        archive_count = max(0, int(archive_stats.get("count", 0)))
        archive_bytes = max(0, int(archive_stats.get("bytes", 0)))
    except (TypeError, ValueError):
        archive_count = archive_bytes = 0
    categories["archives"] = {
        "tokens": 0, "items": archive_count, "characters": 0,
        "count": archive_count, "bytes": archive_bytes,
    }
    return {
        "version": 1,
        "estimated": True,
        "total_tokens": sum(category["tokens"] for category in categories.values()),
        "categories": categories,
    }


def _message_group(message: dict) -> str:
    role = str(message.get("role") or "").lower()
    metadata = message.get("metadata")
    metadata = metadata if isinstance(metadata, dict) else {}
    source = str(metadata.get("source") or "").casefold()
    marker = message.get("_agent_injected")
    if role == "system" or marker in {"prompt", "merged_prompt"}:
        return "instructions"
    if (role == "tool" or "tool result" in source
            or source.startswith("tool execution results")
            or source.startswith("recent tool context")):
        return "tool_results"
    if (marker == "context" or source.startswith("saved memory:")
            or "document" in source or "memory" in source):
        return "memory_docs"
    return "conversation"


def describe_request(
    messages: list[dict] | None,
    tool_schemas: list[dict] | None,
    context_length: int | None = None,
    output_reserve: int = 0,
    archive_stats: dict | None = None,
    input_budget: int | None = None,
) -> dict:
    """Estimate prompt composition from assembled messages and native schemas.

    Returns only counts and estimates. Message content and tool schemas never
    leave the request process in this summary.
    """
    groups = {name: [] for name in ("instructions", "memory_docs", "conversation", "tool_results")}
    for message in messages or []:
        if isinstance(message, dict):
            groups[_message_group(message)].append(message)
    schemas = tool_schemas if isinstance(tool_schemas, list) else []
    categories = {
        name: _measure(group)
        for name, group in groups.items()
    }
    categories["native_tool_schemas"] = {
        "tokens": int(estimate_tool_schema_tokens(schemas)) if schemas else 0,
        "items": len(schemas),
        "characters": len(json.dumps(schemas, ensure_ascii=False, default=str)) if schemas else 0,
    }
    archive_stats = archive_stats if isinstance(archive_stats, dict) else {}
    try:
        archive_count = max(0, int(archive_stats.get("count", 0)))
        archive_bytes = max(0, int(archive_stats.get("bytes", 0)))
    except (TypeError, ValueError):
        archive_count = archive_bytes = 0
    categories["archives"] = {
        "tokens": 0, "items": archive_count, "characters": 0,
        "count": archive_count, "bytes": archive_bytes,
    }
    try:
        window = max(0, int(context_length or 0))
    except (TypeError, ValueError):
        window = 0
    try:
        reserve = max(0, int(output_reserve or 0))
    except (TypeError, ValueError):
        reserve = 0
    try:
        request_budget = max(0, int(input_budget)) if input_budget is not None else None
    except (TypeError, ValueError, OverflowError):
        request_budget = None
    available = max(window - reserve, 0) if window else None
    if request_budget is not None:
        available = min(available, request_budget) if available is not None else request_budget
    total = sum(category["tokens"] for category in categories.values())
    return {
        "version": 1,
        "estimated": True,
        "total_tokens": total,
        "context_length": window or None,
        "output_reserve": reserve,
        "input_budget_tokens": request_budget,
        "available_tokens": available,
        "remaining_tokens": max(available - total, 0) if available is not None else None,
        "categories": categories,
    }
