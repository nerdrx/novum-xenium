import asyncio
import json

import pytest

from src import research_handler
from src.research_handler import ResearchHandler


def _handler(tmp_path, monkeypatch):
    data_dir = tmp_path / "deep_research"
    data_dir.mkdir()
    monkeypatch.setattr(research_handler, "RESEARCH_DATA_DIR", data_dir)
    handler = ResearchHandler.__new__(ResearchHandler)
    handler._active_tasks = {}
    return handler, data_dir


@pytest.mark.parametrize(
    ("failure", "message"),
    [(RuntimeError("search failed"), "search failed"), (asyncio.TimeoutError(), "timed out")],
)
def test_terminal_failure_is_recoverable_after_handler_restart(tmp_path, monkeypatch, failure, message):
    handler, data_dir = _handler(tmp_path, monkeypatch)

    async def fail(*_args, **_kwargs):
        raise failure

    handler.call_research_service = fail
    async def run():
        info = handler.start_research(
            "rp-failed", "q", "http://local", "model", hard_timeout=60, owner="alice",
        )
        await handler._active_tasks[info["session_id"]]["task"]

    asyncio.run(run())

    report_path = data_dir / "rp-failed.json"
    saved = json.loads(report_path.read_text())
    assert saved["status"] == "error"
    assert message in saved["result"]

    restarted = ResearchHandler.__new__(ResearchHandler)
    restarted._active_tasks = {}
    assert restarted.get_status("rp-failed")["status"] == "error"
    assert restarted.get_result("rp-failed") == saved["result"]


def test_cancelled_run_persists_terminal_state(tmp_path, monkeypatch):
    handler, data_dir = _handler(tmp_path, monkeypatch)
    started = asyncio.Event()

    async def wait_forever(*_args, **_kwargs):
        started.set()
        await asyncio.Event().wait()

    handler.call_research_service = wait_forever

    async def run():
        info = handler.start_research(
            "rp-cancelled", "q", "http://local", "model", hard_timeout=60, owner="alice",
        )
        task = handler._active_tasks[info["session_id"]]["task"]
        await started.wait()
        assert handler.cancel_research("rp-cancelled") is True
        with pytest.raises(asyncio.CancelledError):
            await task

    asyncio.run(run())
    saved = json.loads((data_dir / "rp-cancelled.json").read_text())
    assert saved["status"] == "cancelled"
    assert saved["result"] == "Research was cancelled."

    restarted = ResearchHandler.__new__(ResearchHandler)
    restarted._active_tasks = {}
    assert restarted.get_status("rp-cancelled")["status"] == "cancelled"
