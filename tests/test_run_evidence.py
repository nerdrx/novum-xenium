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


def test_loop_breaker_is_diagnostic_when_synthesis_completes(tmp_path, monkeypatch):
    monkeypatch.setenv("ODYSSEUS_RUN_EVIDENCE_DB", str(tmp_path / "evidence.db"))
    evidence.begin("run", "chat", "alice")
    evidence.record("run", 'data: {"type":"loop_breaker_triggered","reason":"fixture"}\n\n')
    evidence.record("run", 'data: {"delta":"A concise synthesis."}\n\n')
    evidence.record("run", 'data: {"type":"agent_terminal","status":"completed"}\n\n')
    evidence.finish("run", "done")

    result = evidence.list_runs("chat", "alice")[0]
    assert result["status"] == "done"
    assert [event["type"] for event in result["events"]] == ["pause_candidate", "terminal"]


def test_raw_done_does_not_clear_unresolved_pause_candidate(tmp_path, monkeypatch):
    monkeypatch.setenv("ODYSSEUS_RUN_EVIDENCE_DB", str(tmp_path / "evidence.db"))
    evidence.begin("run", "chat", "alice")
    evidence.record("run", 'data: {"type":"loop_breaker_triggered","reason":"fixture"}\n\n')
    evidence.finish("run", "done")
    assert evidence.list_runs("chat", "alice")[0]["status"] == "paused"


@pytest.mark.parametrize(("event", "expected"), [
    ({"type": "agent_terminal", "status": "paused"}, "paused"),
    ({"type": "agent_terminal", "status": "failed"}, "error"),
    ({"type": "agent_terminal", "status": "awaiting_input"}, "awaiting_input"),
    ({"type": "agent_terminal", "status": "awaiting_approval"}, "awaiting_approval"),
    ({"type": "chat_terminal", "data": {"status": "failed"}}, "error"),
])
def test_explicit_terminal_status_is_recorded(tmp_path, monkeypatch, event, expected):
    monkeypatch.setenv("ODYSSEUS_RUN_EVIDENCE_DB", str(tmp_path / "evidence.db"))
    evidence.begin("run", "chat", "alice")
    evidence.record("run", 'data: ' + json.dumps(event) + '\n\n')
    evidence.finish("run", "done")
    result = evidence.list_runs("chat", "alice")[0]
    assert result["status"] == expected
    assert not any(key in json.dumps(result) for key in ("message", "reason", "PRIVATE"))


def test_later_explicit_terminal_outcome_wins_by_chronology(tmp_path, monkeypatch):
    monkeypatch.setenv("ODYSSEUS_RUN_EVIDENCE_DB", str(tmp_path / "evidence.db"))
    evidence.begin("run", "chat", "alice")
    evidence.record("run", 'data: {"type":"agent_terminal","status":"paused"}\n\n')
    evidence.record("run", 'data: {"type":"agent_terminal","status":"completed"}\n\n')
    evidence.finish("run", "done")
    assert evidence.list_runs("chat", "alice")[0]["status"] == "done"
