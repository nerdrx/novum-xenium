"""Auto review grants one constrained action and requires usable rollback."""
import asyncio
import errno
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


def test_default_workspace_edit_is_reviewable_but_parent_traversal_is_not(tmp_path, monkeypatch):
    from src import constants, tool_execution

    data_dir = tmp_path / "data"
    workspace = data_dir / "agent_workspace"
    workspace.mkdir(parents=True)
    monkeypatch.setattr(constants, "DATA_DIR", str(data_dir))
    monkeypatch.setattr(tool_execution, "AGENT_WORKSPACE_DIR", str(workspace))

    content = json.dumps({"path": "main.py", "content": "print('ok')"})
    action = candidate_action("write_file", content)
    assert action and action["kind"] == "workspace_edit"
    assert action["workspace"] == str(workspace)
    traversal = json.dumps({"path": "../../outside.py", "content": "unsafe"})
    assert candidate_action("write_file", traversal) is None


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


@pytest.mark.parametrize("content", [
    '{"action":"call","method":"GET","path":"/api/documents/library"}',
])
def test_app_api_private_read_still_needs_exact_approval(content):
    from src.tool_capabilities import ToolEffect, capabilities_for_action

    assert candidate_action("app_api", content) is None
    security = ToolRunSecurityContext(external_untrusted_context_seen=True)
    assert not security.decision_for("app_api", content).allowed
    assert ToolEffect.ADMIN_CHANGE in capabilities_for_action("app_api", content).effects


def test_app_api_endpoint_discovery_is_a_safe_but_untrusted_metadata_read():
    from src.tool_capabilities import (
        ResultIntegrity, ToolEffect, capabilities_for_action,
    )

    content = '{"action":"endpoints","filter":"gallery"}'
    capabilities = capabilities_for_action("app_api", content)
    assert capabilities.effects == frozenset({ToolEffect.READ_CONTEXT})
    assert capabilities.result_integrity is ResultIntegrity.EXTERNAL_UNTRUSTED
    security = ToolRunSecurityContext(external_untrusted_context_seen=True)
    assert security.decision_for("app_api", content).allowed
    security.observe_tool_result("app_api", {"output": "endpoint schema", "exit_code": 0}, content)
    assert security.external_untrusted_context_seen
    assert not security.decision_for("bash", "ls").allowed


@pytest.mark.parametrize("content", [
    '{"action":"call","method":"POST","path":"/api/notes"}',
    '{"action":"call","method":"GET","path":"/api/tokens"}',
    '{"action":"call","method":"GET","path":"/api/cookbook/state/../kill"}',
    '{"action":"call","method":"GET","path":"/api/sessions"}',
])
def test_app_api_actions_except_metadata_discovery_stay_exact_approval_only(content):
    from src.tool_capabilities import ToolEffect, capabilities_for_action

    assert candidate_action("app_api", content) is None
    assert ToolEffect.ADMIN_CHANGE in capabilities_for_action("app_api", content).effects


@pytest.mark.parametrize("mode,delegated", [("ask", False), ("full", True), ("auto", True)])
def test_judge_grant_cannot_lift_ask_or_delegated(tmp_path, mode, delegated):
    content = json.dumps({"path": "main.py", "content": "pass"})
    security = ToolRunSecurityContext(external_untrusted_context_seen=True,
                                      approval_mode=mode, delegated_credential=delegated)
    security.authorize_reviewed_action("write_file", content, str(tmp_path))
    assert not security.reviewed_actions
    assert not security.decision_for("write_file", content, workspace=str(tmp_path)).allowed


def test_dispatch_snapshots_before_write_and_fails_closed(tmp_path, monkeypatch, caplog):
    root = tmp_path / "workspace"
    root.mkdir()
    path = root / "main.py"
    path.write_text("before")
    monkeypatch.setattr(workspace_snapshots, "_ROOT", tmp_path / "snapshots")
    monkeypatch.setattr(tool_execution, "_owner_is_admin", lambda owner: True)
    calls = []
    validated_scopes = []
    # This dispatch unit fixture has no persisted chat; real ownership and
    # deletion races are covered by the snapshot route/storage tests.
    monkeypatch.setattr(workspace_snapshots, "validate_session_scope",
                        lambda owner, sid: validated_scopes.append((owner, sid)))
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
    assert validated_scopes == [("alice", "chat")]
    preview = workspace_snapshots.preview_snapshot(str(root), "alice", "chat", result["workspace_snapshot_id"])
    assert "before" in preview["changes"][0]["diff"]
    def fail(*args, **kwargs):
        raise OSError(errno.ENOSPC, "no space", "/private/snapshot-path")
    monkeypatch.setattr(workspace_snapshots, "ensure_snapshot", fail)
    _, result = run()
    assert result["blocked"] is True
    assert "storage is full" in result["error"]
    assert "/private/snapshot-path" not in result["error"]
    assert any(record.exc_info for record in caplog.records if "rollback snapshot unavailable" in record.message.lower())
    assert calls == ["write_file"]


def test_default_workspace_snapshot_is_used_when_no_workspace_selected(tmp_path, monkeypatch):
    from src import constants

    root = tmp_path / "data" / "agent_workspace"
    root.mkdir(parents=True)
    path = root / "main.py"
    path.write_text("before")
    monkeypatch.setattr(constants, "DATA_DIR", str(root.parent))
    monkeypatch.setattr(tool_execution, "AGENT_WORKSPACE_DIR", str(root))
    monkeypatch.setattr(workspace_snapshots, "_ROOT", tmp_path / "snapshots")
    monkeypatch.setattr(tool_execution, "_owner_is_admin", lambda owner: True)
    monkeypatch.setattr(workspace_snapshots, "validate_session_scope", lambda *args: None)

    async def execute(block, **kwargs):
        path.write_text("after")
        return "write", {"exit_code": 0}

    monkeypatch.setattr(tool_execution, "_execute_tool_block_impl", execute)
    security = ToolRunSecurityContext(approval_mode="full", workspace_snapshots_enabled=True)
    block = SimpleNamespace(tool_type="write_file", content="main.py\nafter")
    _, result = asyncio.run(tool_execution.execute_tool_block(
        block, session_id="chat", owner="alice", workspace=None,
        security_context=security,
    ))
    assert result["workspace_snapshot_id"]
    snapshots = workspace_snapshots.list_snapshots(str(root), "alice", "chat")
    assert len(snapshots) == 1


def test_default_workspace_auto_review_covers_longer_write_task_without_exact_prompts(
    tmp_path, monkeypatch,
):
    from tests.test_external_context_tool_gate import _patch_agent_loop, _collect_agent_events
    from src.prompt_security import untrusted_context_message
    from src import approval_judge, constants, tool_execution, workspace_snapshots

    root = tmp_path / "data" / "agent_workspace"
    root.mkdir(parents=True)
    monkeypatch.setattr(constants, "DATA_DIR", str(root.parent))
    monkeypatch.setattr(tool_execution, "AGENT_WORKSPACE_DIR", str(root))
    files = [f"module_{index}.py" for index in range(7)]
    content = [json.dumps({"path": name, "content": f"value = {index}"})
               for index, name in enumerate(files)]
    responses = [f"```write_file\n{item}\n```" for item in content] + ["Done."]
    executed, reviewed, snapshots = [], [], []
    loop = _patch_agent_loop(monkeypatch, responses, executed)

    async def review(action, request, **kwargs):
        assert action["workspace"] == str(root)
        assert request == "Create seven small source files in the default workspace."
        reviewed.append(action["path"])
        return {"decision": "allow", "reason": "Requested workspace edit."}

    def ensure_snapshot(workspace, owner, session_id, run_id):
        assert workspace == str(root)
        snapshots.append(run_id)
        return {"id": f"snapshot-{len(snapshots)}"}

    async def execute(block, **kwargs):
        decision = kwargs["security_context"].decision_for(
            block.tool_type, block.content, workspace=None,
        )
        assert decision.allowed
        args = json.loads(block.content)
        (root / args["path"]).write_text(args["content"], encoding="utf-8")
        executed.append(args["path"])
        return "write_file", {"output": "saved", "exit_code": 0}

    monkeypatch.setattr(approval_judge, "review_action", review)
    monkeypatch.setattr(workspace_snapshots, "ensure_snapshot", ensure_snapshot)
    monkeypatch.setattr(loop, "execute_tool_block", execute)
    events = _collect_agent_events(loop.stream_agent_loop(
        "http://local.test/v1", "model", [
            {"role": "user", "content": "Create seven small source files in the default workspace."},
            untrusted_context_message("page", "untrusted page text"),
        ], max_rounds=8, relevant_tools={"write_file"}, owner="alice", session_id="chat",
        approval_mode="auto",
    ))
    assert len(reviewed) == len(executed) == len(snapshots) == 7
    assert executed == files
    assert not any(event.get("ask_user", {}).get("kind") == "tool_approval" for event in events)


@pytest.mark.parametrize("error,expected", [
    ("workspace exceeds snapshot size limit", "exceeds rollback snapshot limits"),
    ("chat is no longer available for this workspace snapshot", "Reopen the chat"),
    ("snapshot storage is not a private directory", "failed a safety check"),
])
def test_snapshot_error_guidance_is_actionable_and_sanitized(error, expected):
    from src.workspace_snapshots import SnapshotError

    message = tool_execution._snapshot_failure_message(SnapshotError(error))
    assert expected in message
    assert "/" not in message
    assert "token" not in message.lower()


def test_snapshot_os_error_guidance_does_not_expose_filename():
    message = tool_execution._snapshot_failure_message(
        PermissionError(errno.EACCES, "denied", "/private/workspace/token.txt")
    )
    assert "Check permissions" in message
    assert "/private/workspace/token.txt" not in message


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


def test_real_loop_allows_endpoint_metadata_discovery_without_exact_approval(monkeypatch):
    from tests.test_external_context_tool_gate import _patch_agent_loop, _collect_agent_events
    from src.prompt_security import untrusted_context_message

    content = json.dumps({"action": "endpoints", "filter": "gallery"})
    executed = []
    loop = _patch_agent_loop(monkeypatch, ["```app_api\n" + content + "\n```"], executed)

    async def execute(block, **kwargs):
        decision = kwargs["security_context"].decision_for(block.tool_type, block.content)
        assert decision.allowed
        executed.append(block.tool_type)
        return "app_api", {"output": "document content", "exit_code": 0}

    monkeypatch.setattr(loop, "execute_tool_block", execute)
    events = _collect_agent_events(loop.stream_agent_loop(
        "http://local.test/v1", "model", [
            {"role": "user", "content": "Find the gallery API endpoint."},
            untrusted_context_message("page", "untrusted page text"),
        ], max_rounds=1, relevant_tools={"app_api"}, owner="alice", session_id="chat",
    ))
    assert executed == ["app_api"]
    assert not any(e.get("ask_user", {}).get("kind") == "tool_approval" for e in events)
