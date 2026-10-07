import json
import shutil
import subprocess
from pathlib import Path

import pytest


def test_tool_approval_status_and_resolution_helpers_match_execution_state():
    if not shutil.which("node"):
        pytest.skip("node is not installed")
    root = Path(__file__).resolve().parents[1]
    renderer = (root / "static/js/chatRenderer.js").read_text(encoding="utf-8")
    start = renderer.index("export function toolEventStatus(")
    end = renderer.index("\n\nfunction _makeActionBtn", start)
    helpers = renderer[start:end].replace("export function", "function")
    object_start = renderer.index("const chatRenderer = {") + len("const chatRenderer = {")
    object_end = renderer.index("\n};\n\nexport default chatRenderer", object_start)
    object_body = renderer[object_start:object_end]
    object_members = [
        line.strip().rstrip(",")
        for line in object_body.splitlines()
        if line.strip().rstrip(",").isidentifier()
    ]
    script = f"""
      const helperFns = new Function(
        {json.dumps(helpers + '; return { toolEventStatus, resolveToolApprovalNode, findPendingApprovalNode };')}
      )();
      const names = {json.dumps(object_members)};
      const values = names.map(name => helperFns[name] || (() => {{}}));
      const chatRenderer = new Function(...names, {json.dumps('return ({' + object_body + '\n});')})(...values);
      if (chatRenderer.toolEventStatus !== helperFns.toolEventStatus
          || chatRenderer.resolveToolApprovalNode !== helperFns.resolveToolApprovalNode
          || chatRenderer.findPendingApprovalNode !== helperFns.findPendingApprovalNode) {{
        throw new Error('default chatRenderer omits approval status helpers');
      }}
      const {{ toolEventStatus, resolveToolApprovalNode, findPendingApprovalNode }} = chatRenderer;
      const states = [
        toolEventStatus({{ tool: 'write_file', exit_code: null, approval_required: true,
          ask_user: {{ kind: 'tool_approval', approval_id: 'a1' }} }}),
        toolEventStatus({{ tool: 'write_file', exit_code: null }}),
        toolEventStatus({{ tool: 'write_file', exit_code: 0 }}),
        toolEventStatus({{ tool: 'write_file', exit_code: 2 }}),
        toolEventStatus({{ tool: 'write_file', exit_code: null, approval_required: true,
          ask_user: {{ kind: 'tool_approval', resolved: 'deny' }} }}),
      ];
      const classes = new Set(['pending']);
      const icon = {{ textContent: '…' }};
      const label = {{ textContent: 'awaiting approval' }};
      const wave = {{ removed: false, remove() {{ this.removed = true; }} }};
      const node = {{ classList: {{ remove(name) {{ classes.delete(name); }} }},
        querySelector(selector) {{ return selector === '.agent-thread-icon' ? icon
          : selector === '.agent-thread-status' ? label : selector === '.agent-thread-wave' ? wave : null; }} }};
      const resolved = resolveToolApprovalNode(node, 'deny');
      const oldPending = {{ dataset: {{ approvalId: 'old' }} }};
      const targetPending = {{ dataset: {{ approvalId: 'target', comparePane: '2' }} }};
      const otherPanePending = {{ dataset: {{ approvalId: 'target', comparePane: '1' }} }};
      const root = {{ querySelectorAll() {{ return [oldPending, targetPending, otherPanePending]; }} }};
      const matched = findPendingApprovalNode(root, 'target');
      const matchedPane = findPendingApprovalNode(root, 'target', 2);
      process.stdout.write(JSON.stringify({{ states, resolved, classes: [...classes], icon: icon.textContent,
        label: label.textContent, waveRemoved: wave.removed,
        matched: matched.dataset.approvalId, matchedPane: matchedPane.dataset.comparePane }}));
    """
    result = subprocess.run(
        ["node", "--input-type=module"], input=script, capture_output=True,
        text=True, cwd=root, timeout=30,
    )
    assert result.returncode == 0, result.stderr
    state = json.loads(result.stdout)
    assert state["states"] == [
        {"label": "awaiting approval", "icon": "…", "className": "pending", "pending": True},
        {"label": "done", "icon": "✓", "className": "", "pending": False},
        {"label": "done", "icon": "✓", "className": "", "pending": False},
        {"label": "failed", "icon": "✗", "className": "error", "pending": False},
        {"label": "denied", "icon": "✗", "className": "", "pending": False},
    ]
    assert state["resolved"] is True
    assert state["classes"] == []
    assert state["icon"] == "✗"
    assert state["label"] == "denied"
    assert state["waveRemoved"] is True
    assert state["matched"] == "target"
    assert state["matchedPane"] == "2"


def test_live_replay_and_compare_use_shared_approval_status_without_closing_prior_tool():
    root = Path(__file__).resolve().parents[1]
    renderer = (root / "static/js/chatRenderer.js").read_text(encoding="utf-8")
    chat = (root / "static/js/chat.js").read_text(encoding="utf-8")
    compare = (root / "static/js/compare/stream.js").read_text(encoding="utf-8")

    assert "const toolStatus = toolEventStatus(ev);" in renderer
    assert "const toolStatus = chatRenderer.toolEventStatus(json);" in chat
    assert "currentToolBubble.dataset.toolName !== (json.tool || '')" in chat
    assert "if (!currentToolBubble && toolStatus.pending)" in chat
    assert "chatRenderer.findPendingApprovalNode(" in chat
    assert "approvalForSend?.approval_id" in chat
    assert "node.dataset.approvalId = json.ask_user?.approval_id || '';" in chat
    assert "approvalForSend.tool && json.tool === approvalForSend.tool" in chat
    assert "findPendingApprovalNode(hist, opts.toolApproval?.approval_id, paneIdx)" in compare
    assert "opts.toolApproval.tool && json.tool === opts.toolApproval.tool" in compare
    assert "node.dataset.comparePane = String(paneIdx);" in compare
    assert "Denied. No action executed." in chat
    assert "const toolStatus = toolEventStatus(json);" in compare
    assert "currentToolBlock.dataset.toolName !== (json.tool || '')" in compare
    assert "resolveToolApprovalNode(" in compare
