import json

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
