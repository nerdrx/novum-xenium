import json
import pytest

from src import run_evidence as evidence


def test_evidence_is_owner_scoped_and_never_stores_content(tmp_path, monkeypatch):
    monkeypatch.setenv("ODYSSEUS_RUN_EVIDENCE_DB", str(tmp_path / "evidence.db"))
    evidence.begin("run", "chat", "alice", {"model": "fixture", "original_request": "secret prompt"})
    evidence.record("run", 'data: ' + json.dumps({"type": "tool_start", "tool": "bash", "command": "SECRET_TOKEN=123"}) + '\n\n')
    evidence.record("run", 'data: ' + json.dumps({"type": "tool_output", "tool": "bash", "exit_code": 0, "output": "private file"}) + '\n\n')
    evidence.finish("run", "done")
    rows = evidence.list_runs("chat", "alice")
    assert rows[0]["status"] == "done"
    assert rows[0]["events"][1]["exit_code"] == 0
    assert not evidence.list_runs("chat", "bob")
    raw = json.dumps(rows)
    assert "SECRET_TOKEN" not in raw and "private file" not in raw and "secret prompt" not in raw
    evidence.delete_session("chat", "bob")
    assert evidence.list_runs("chat", "alice")
    evidence.delete_session("chat", "alice")
    assert not evidence.list_runs("chat", "alice")


def test_evidence_retains_bounded_metadata(tmp_path, monkeypatch):
    monkeypatch.setenv("ODYSSEUS_RUN_EVIDENCE_DB", str(tmp_path / "evidence.db"))
    for i in range(25):
        evidence.begin(str(i), "chat", "alice")
    assert len(evidence.list_runs("chat", "alice")) == 20
    for _ in range(300):
        evidence.record("24", 'data: {"type":"tool_start","tool":"bash"}\n\n')
    assert len(evidence.list_runs("chat", "alice")[0]["events"]) == 256


@pytest.mark.parametrize("event,expected", [
    ({"type": "ask_user", "ask_user": {"kind": "tool_approval", "approval_id": "SECRET"}}, "awaiting_approval"),
    ({"type": "ask_user", "ask_user": {"question": "PRIVATE"}}, "awaiting_input"),
    ({"type": "budget_exceeded"}, "paused"),
    ({"type": "agent_terminal", "data": {"failed": True, "failure": "PRIVATE"}}, "error"),
    ({"error": "PRIVATE", "status": 500}, "error"),
    ({"type": "verification", "passed": False}, "unverified"),
    ({"type": "tool_output", "exit_code": 1}, "done"),  # A tool can fail and recover.
])
def test_stream_end_does_not_claim_task_completion(tmp_path, monkeypatch, event, expected):
    monkeypatch.setenv("ODYSSEUS_RUN_EVIDENCE_DB", str(tmp_path / "evidence.db"))
    evidence.begin("run", "chat", "alice")
    evidence.record("run", 'data: ' + json.dumps(event) + '\n\n')
    evidence.finish("run", "done")
    result = evidence.list_runs("chat", "alice")[0]
    assert result["status"] == expected
    assert "SECRET" not in json.dumps(result) and "PRIVATE" not in json.dumps(result)
    evidence.finish("run", "stopped")
    assert evidence.list_runs("chat", "alice")[0]["status"] == "stopped"
