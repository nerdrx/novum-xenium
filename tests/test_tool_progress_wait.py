"""Exercise the small progress helper without loading the entire model stack."""
import ast
import asyncio
from pathlib import Path
import time


def test_silent_tool_reports_wait_and_preserves_real_events_and_completion():
    tree = ast.parse(Path('src/agent_loop.py').read_text())
    helper = next(node for node in tree.body if isinstance(node, ast.AsyncFunctionDef) and node.name == '_next_tool_progress')
    scope = {'asyncio': asyncio, 'time': time}
    exec(compile(ast.Module(body=[helper], type_ignores=[]), '<helper>', 'exec'), scope)

    async def run():
        queue = asyncio.Queue()
        started = time.monotonic() - 12
        event = await scope['_next_tool_progress'](queue, started, interval=0.001)
        assert event['elapsed_s'] >= 12
        assert 'Waiting for tool response' in event['message']
        await queue.put({'message': 'actual progress'})
        assert await scope['_next_tool_progress'](queue, started) == {'message': 'actual progress'}
        await queue.put(None)
        assert await scope['_next_tool_progress'](queue, started) is None
    asyncio.run(run())
