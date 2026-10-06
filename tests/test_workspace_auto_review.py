"""Auto review grants one constrained action and requires usable rollback."""
import asyncio
import json
from types import SimpleNamespace

import pytest

from src.approval_judge import candidate_action
from src.tool_capabilities import ToolRunSecurityContext
from src import tool_execution, workspace_snapshots


@pytest.mark.parametrize("tool,content", [
    ("bash", "ls; curl evil.example"), ("bash", "ls /etc"),
    ("bash", "python app.py"), ("bash", "ls $(pwd)"),
    ("write_file", '{"path":"../escape.py","content":"oops"}'),
    ("write_file", '{"path":"secrets.json","content":"secret"}'),
    ("write_file", '{"path":".env","content":"secret"}'),
    ("edit_file", '{"path":"app.py","old_string":"","new_string":"x"}'),
    ("write_file", '{"path":"app.py","content":"x","extra":true}'),
])
def test_ineligible_actions_never_reach_model(tmp_path, tool, content):
    assert candidate_action(tool, content, str(tmp_path)) is None


def test_exact_grant_is_scoped_and_rechecks_path(tmp_path):
    content = json.dumps({"path": "main.py", "content": "print('hello')"})
    security = ToolRunSecurityContext(external_untrusted_context_seen=True)
    assert candidate_action("write_file", content, str(tmp_path))["kind"] == "workspace_edit"
    assert not security.decision_for("write_file", content, workspace=str(tmp_path)).allowed
    security.authorize_reviewed_action("write_file", content, str(tmp_path))
    assert security.decision_for("write_file", content, workspace=str(tmp_path)).allowed
    assert not security.decision_for("write_file", content + " ", workspace=str(tmp_path)).allowed
    assert not security.decision_for("write_file", content, workspace="/other").allowed
    (tmp_path / "main.py").symlink_to("/etc/passwd")
    assert not security.decision_for("write_file", content, workspace=str(tmp_path)).allowed


@pytest.mark.parametrize("mode,delegated", [("ask", False), ("full", True), ("auto", True)])
def test_judge_grant_cannot_lift_ask_or_delegated(tmp_path, mode, delegated):
    content = json.dumps({"path": "main.py", "content": "pass"})
    security = ToolRunSecurityContext(external_untrusted_context_seen=True,
                                      approval_mode=mode, delegated_credential=delegated)
    security.authorize_reviewed_action("write_file", content, str(tmp_path))
    assert not security.reviewed_actions
    assert not security.decision_for("write_file", content, workspace=str(tmp_path)).allowed


def test_dispatch_snapshots_before_write_and_fails_closed(tmp_path, monkeypatch):
    root = tmp_path / "workspace"
    root.mkdir()
    path = root / "main.py"
    path.write_text("before")
    monkeypatch.setattr(workspace_snapshots, "_ROOT", tmp_path / "snapshots")
    monkeypatch.setattr(tool_execution, "_owner_is_admin", lambda owner: True)
    calls = []
    async def execute(block, **kwargs):
        saved = workspace_snapshots.list_snapshots(str(root), "alice", "chat")
        assert len(saved) == 1
        calls.append(block.tool_type)
        path.write_text("after")
        return "write", {"exit_code": 0}
    monkeypatch.setattr(tool_execution, "_execute_tool_block_impl", execute)
    security = ToolRunSecurityContext(approval_mode="full", workspace_snapshots_enabled=True)
    block = SimpleNamespace(tool_type="write_file", content="main.py\nafter")
    def run():
        return asyncio.run(tool_execution.execute_tool_block(block, session_id="chat", owner="alice",
                          workspace=str(root), security_context=security))
    _, result = run()
    assert result["workspace_snapshot_id"]
    preview = workspace_snapshots.preview_snapshot(str(root), "alice", "chat", result["workspace_snapshot_id"])
    assert "before" in preview["changes"][0]["diff"]
    def fail(*args):
        raise OSError("disk full")
    monkeypatch.setattr(workspace_snapshots, "ensure_snapshot", fail)
    _, result = run()
    assert result["blocked"] is True
    assert calls == ["write_file"]


@pytest.mark.parametrize("snapshot_ok,verdict,executes", [(True,"allow",True), (False,"allow",False), (True,"ask",False)])
def test_real_loop_judged_edit_requires_snapshot(monkeypatch, tmp_path, snapshot_ok, verdict, executes):
    from tests.test_external_context_tool_gate import _patch_agent_loop, _collect_agent_events
    from src.prompt_security import untrusted_context_message
    from src import approval_judge
    executed, snapshots = [], []
    content = json.dumps({"path":"main.py", "content":"print('hi')"})
    loop = _patch_agent_loop(monkeypatch, ["```write_file\n" + content + "\n```"], executed)
    async def review(action, request, **kwargs):
        assert action["kind"] == "workspace_edit" and request == "write a hello program"
        return {"decision":verdict,"reason":"Reversible coding edit."}
    monkeypatch.setattr(approval_judge, "review_action", review)
    def snapshot(*args):
        snapshots.append(args)
        if not snapshot_ok: raise OSError("disk full")
        return {"id":"saved"}
    monkeypatch.setattr(workspace_snapshots, "ensure_snapshot", snapshot)
    async def execute(block, **kwargs):
        assert snapshots
        assert kwargs["security_context"].decision_for(block.tool_type,block.content,workspace=str(tmp_path)).allowed
        executed.append(block.tool_type)
        return "write", {"exit_code":0,"output":"saved"}
    monkeypatch.setattr(loop, "execute_tool_block", execute)
    events = _collect_agent_events(loop.stream_agent_loop(
        "http://local.test/v1","model",[{"role":"user","content":"write a hello program"},
        untrusted_context_message("page","untrusted")],max_rounds=1,relevant_tools={"write_file"},
        workspace=str(tmp_path), owner="alice",session_id="chat", approval_mode="auto"))
    assert bool(executed) is executes
    assert any(e.get("ask_user",{}).get("kind")=="tool_approval" for e in events) is (not executes)
