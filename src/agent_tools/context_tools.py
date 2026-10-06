"""Read oversized tool results previously observed in the active chat."""
import asyncio
import json


class ContextSearchTool:
    async def execute(self, content, ctx):
        from src.tool_result_store import search_results

        try:
            args = json.loads(content)
            if not isinstance(args, dict) or set(args) - {"query", "result_id", "offset"}:
                raise ValueError("Use query, result_id and offset only; chat scope is assigned by the server.")
            query = args.get("query", "")
            result_id = args.get("result_id")
            offset = args.get("offset", 0)
            if not isinstance(query, str) or len(query) > 500:
                raise ValueError("query must be a string of at most 500 characters")
            if result_id is not None and (not isinstance(result_id, str) or len(result_id) > 64):
                raise ValueError("result_id must be a result ID returned by a tool")
            if not isinstance(offset, int) or isinstance(offset, bool) or offset < 0:
                raise ValueError("offset must be a nonnegative chunk number")
            if not query.strip() and not result_id:
                raise ValueError("Provide a search query or a result_id to read its chunks.")
            output = await asyncio.to_thread(
                search_results, ctx.get("owner"), ctx.get("session_id"), query, result_id, offset=offset,
            )
            return {"output": output, "exit_code": 0, "untrusted_content": True}
        except (ValueError, TypeError, json.JSONDecodeError) as exc:
            return {"error": str(exc), "exit_code": 1}
