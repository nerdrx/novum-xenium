"""Search-domain tool implementations.

Extracted from tool_implementations.py as part of slice 1 (#4082/#4071).
Holds the search_chats tool.
``src.tool_implementations`` re-exports these for backward compatibility.
"""
import logging
import re
from typing import Dict

logger = logging.getLogger(__name__)

_MARKDOWN_PUNCTUATION = re.compile(r"([\\`*_{}\[\]()#+\-.!|>])")


def _escape_markdown(value: str) -> str:
    return _MARKDOWN_PUNCTUATION.sub(r"\\\1", value)


async def do_search_chats(query: str, limit: int = 20, owner: str | None = None) -> Dict:
    """Search past session transcripts for the calling user's sessions only.

    Without an owner filter this used to leak EVERY user's chat history
    into the agent's `search_chats` results (v2 review HIGH-11). The
    caller in `tool_execution.execute_tool_block` now plumbs the owner
    through; legacy callers without owner pass through as before but
    will only see legacy/null-owner rows.
    """
    try:
        from src.session_search import search_session_messages

        search_limit = max(1, min(int(limit or 20), 100))
        results = search_session_messages(query, limit=search_limit, owner=owner)
        if not results:
            return {"results": f'No chats found matching "{_escape_markdown(query[:120])}".'}

        # Keep several distinct evidence messages per session, in search order.
        sessions = {}
        for result in results:
            matches = sessions.setdefault(result.session_id, [])
            if len(matches) < 3 and all(match.message_id != result.message_id for match in matches):
                matches.append(result)

        lines = [f'Found {len(sessions)} session(s) matching "{_escape_markdown(query[:120])}":\n']
        for sid, matches in sessions.items():
            result = matches[0]
            safe_name = _escape_markdown(result.session_name[:120])
            lines.append(f"- [**{safe_name}**](#session-{sid})")
            lines.append(f"  Open: [Open chat](#session-{sid})")
            for match in matches:
                timestamp = match.timestamp or "unknown"
                lines.append(
                    f"  Match ({match.role}, id: {match.message_id}, time: {timestamp}): "
                    f"{match.content_snippet[:240]}"
                )
                if match.context_before:
                    before = match.context_before[-1]
                    lines.append(f"  Before ({before['role']}): {before['content'][:180]}")
                if match.context_after:
                    after = match.context_after[0]
                    lines.append(f"  After ({after['role']}): {after['content'][:180]}")
            lines.append("")

        return {"results": "\n".join(lines)}
    except Exception as e:
        logger.error(f"search_chats failed: {e}")
        return {"error": str(e), "exit_code": 1}
