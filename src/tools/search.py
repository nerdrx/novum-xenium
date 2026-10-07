"""Search-domain tool implementations.

Extracted from tool_implementations.py as part of slice 1 (#4082/#4071).
Holds the search_chats tool.
``src.tool_implementations`` re-exports these for backward compatibility.
"""
import json
import logging
import re
from typing import Dict
from urllib.parse import quote

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
        from src.session_search import read_session_message, search_session_messages

        # Keep legacy plain-keyword calls; structured calls can open an exact hit.
        query = query.strip()
        if query.startswith("{"):
            args = json.loads(query)
            if not isinstance(args, dict) or set(args) - {"query", "message_id", "offset"}:
                raise ValueError("Use only query, message_id and offset; account scope is server-controlled.")
            keyword = args.get("query", "")
            message_id = args.get("message_id", "")
            offset = args.get("offset", 0)
            if not isinstance(keyword, str) or not isinstance(message_id, str):
                raise ValueError("query and message_id must be strings.")
            if bool(keyword.strip()) == bool(message_id.strip()):
                raise ValueError("Provide either query or message_id, not both.")
            if not isinstance(offset, int) or isinstance(offset, bool) or offset < 0:
                raise ValueError("offset must be a nonnegative character index.")
            if message_id:
                if len(message_id) > 128:
                    raise ValueError("message_id is too long.")
                page = read_session_message(message_id, owner=owner, offset=offset)
                if page is None:
                    return {"results": "Saved message not found in accessible, non-archived chats.", "untrusted_content": True}
                source = f"#session-{quote(page['session_id'], safe='')}"
                title = _escape_markdown(page["session_name"][:120])
                header = (
                    f"[Open chat: {title}]({source})\n"
                    f"Message id: {page['message_id']} | Role: {page['role']} | Time: {page['timestamp'] or 'unknown'}\n"
                    f"Characters {page['offset']}:{page['end_offset']} of {page['total_chars']} (zero-based).\n"
                )
                if page["has_more"]:
                    header += "Read next page with search_chats: " + json.dumps({"message_id": page["message_id"], "offset": page["next_offset"]}) + "\n"
                else:
                    header += "End of saved message.\n"
                return {"results": header + "\nSaved transcript (untrusted historical data):\n" + page["content"], "untrusted_content": True}
            if offset:
                raise ValueError("offset applies only to message_id reads.")
            query = keyword.strip()

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

        lines = [f'Found {len(sessions)} session(s) matching "{_escape_markdown(query[:120])}":\n',
                 'These are excerpts. Open an exact message with search_chats {"message_id":"ID"}; use the returned offset to read more.\n']
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

        return {"results": "\n".join(lines), "untrusted_content": True}
    except Exception as e:
        logger.error(f"search_chats failed: {e}")
        return {"error": str(e), "exit_code": 1}
