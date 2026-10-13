from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]


@pytest.mark.skipif(not shutil.which("node"), reason="node is unavailable")
def test_coding_work_card_and_grouped_tool_activity_are_safe_and_truthful():
    script = r"""
import assert from 'node:assert/strict';
import { renderCodingWorkPacketStatus, recordCodingWorkToolActivity } from './static/js/codingWorkPacket.js';
class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.dataset = {}; this.attributes = {}; this.parentNode = null; this._text = ''; }
  setAttribute(key, value) { this.attributes[key] = value; }
  appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
  append(...children) { children.forEach(child => this.appendChild(child)); }
  insertBefore(child, before) { child.parentNode = this; const i = this.children.indexOf(before); this.children.splice(i < 0 ? this.children.length : i, 0, child); return child; }
  removeChild(child) { this.children.splice(this.children.indexOf(child), 1); child.parentNode = null; return child; }
  get firstChild() { return this.children[0] || null; }
  get lastChild() { return this.children[this.children.length - 1] || null; }
  get previousSibling() { if (!this.parentNode) return null; return this.parentNode.children[this.parentNode.children.indexOf(this) - 1] || null; }
  get nextSibling() { if (!this.parentNode) return null; return this.parentNode.children[this.parentNode.children.indexOf(this) + 1] || null; }
  set textContent(value) { while (this.firstChild) this.removeChild(this.firstChild); this._text = String(value); }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set innerHTML(_value) { throw new Error('HTML insertion is forbidden'); }
  querySelector(selector) {
    if (selector === ':scope > summary') return this.children.find(child => child.tagName === 'summary') || null;
    const cls = selector.startsWith('.') ? selector.slice(1) : '';
    const visit = node => { for (const child of node.children) { if (child.className === cls) return child; const nested = visit(child); if (nested) return nested; } return null; };
    return cls ? visit(this) : null;
  }
}
globalThis.document = { createElement: tag => new Element(tag) };
const parent = new Element('div');
const anchor = new Element('article'); parent.appendChild(anchor);
const card = renderCodingWorkPacketStatus({
  type: 'coding_work_packet', stage: 'verify', test_status: 'not_verified', review_status: 'not_reviewed',
  packet: { objective: '<img src=x onerror=alert(1)>', files: ['src/a.py'], reproduce_command: 'pytest -q tests/test_a.py', acceptance_command: 'pytest -q', acceptance_condition: 'the check passes' },
}, anchor);
assert.equal(card.previousSibling, anchor);
assert.equal(card.children[0].textContent, '<img src=x onerror=alert(1)>');
assert.equal(card.children[1].textContent, 'Verifying · pytest -q');
assert.equal(card.children[2].textContent.includes('Not verified'), true);
assert.equal(card.children[2].textContent.includes('Not reviewed'), true);
assert.equal(card.children[3].children[0].tagName, 'details', 'plan is expandable');
assert.match(card.children[3].textContent, /src\/a.py/);

const nodeA = new Element('div'); nodeA.className = 'agent-thread-node'; nodeA.dataset = {};
const nodeB = new Element('div'); nodeB.className = 'agent-thread-node error'; nodeB.dataset = {};
recordCodingWorkToolActivity({ type: 'tool_start', tool: 'read_file', command: 'src/a.py' }, anchor, nodeA);
recordCodingWorkToolActivity({ type: 'tool_output', tool: 'read_file', command: 'src/a.py', output: 'contents a', exit_code: 0 }, anchor, nodeA);
recordCodingWorkToolActivity({ type: 'tool_start', tool: 'read_file', command: 'src/b.py' }, anchor, nodeB);
recordCodingWorkToolActivity({ type: 'tool_output', tool: 'read_file', command: 'src/b.py', output: 'denied', exit_code: 2, error: 'permission denied' }, anchor, nodeB);
const nodeSearch = new Element('div'); nodeSearch.className = 'agent-thread-node'; nodeSearch.dataset = {};
recordCodingWorkToolActivity({ type: 'tool_start', tool: 'web_search', command: 'find docs' }, anchor, nodeSearch);
recordCodingWorkToolActivity({ type: 'tool_progress', tool: 'web_search', message: 'Searching sources' }, anchor, nodeSearch);
recordCodingWorkToolActivity({ type: 'tool_output', tool: 'web_search', exit_code: 0 }, anchor, nodeSearch);
const activity = card._codingToolActivity;
assert.equal(activity.tagName, 'details', 'activity is expandable');
assert.match(activity.children[0].textContent, /3 actions/);
const groups = activity.children[1].children;
assert.equal(groups.length, 2, 'repeated reads share one group and searches another');
assert.match(groups[0].children[0].textContent, /Reads · 2 actions · 1 failed/);
assert.equal(groups[0].dataset.failed, '1');
assert.match(groups[0].textContent, /permission denied/);
assert.match(groups[0].textContent, /contents a/);
assert.match(groups[1].children[0].textContent, /Searches · 1 action/);
assert.match(nodeA.className, /coding-work-group-hidden/, 'repeated success is folded into grouped details');
assert.doesNotMatch(nodeB.className, /coding-work-group-hidden/, 'failure remains visible in the thread');
assert.doesNotMatch(nodeSearch.className, /coding-work-group-hidden/, 'a single success remains in the thread');

const updated = renderCodingWorkPacketStatus({
  type: 'coding_work_packet', stage: 'done', test_status: 'passed', review_status: 'unverified',
  packet: { objective: 'Safe update', files: ['src/a.py'], acceptance_condition: 'all checks pass' },
}, anchor);
assert.equal(updated, card, 'status card updates in place');
assert.equal(card.children[1].textContent, 'Slice checked · all checks pass');
assert.match(card.children[2].textContent, /Passed/);
assert.match(card.children[2].textContent, /Unverified/);
assert.equal(card.children[3].children[1], activity, 'tool history survives status updates');
renderCodingWorkPacketStatus({
  type: 'coding_work_packet', stage: 'verify', test_status: 'not_verified', review_status: 'not_reviewed',
  packet: { objective: 'Safe update', files: 'malformed', acceptance_command: 'pytest -q' },
}, anchor);
assert.match(card.children[2].textContent, /Not verified/, 'missing backend result never becomes Passed');
recordCodingWorkToolActivity({ type: 'tool_start', tool: 'bash', command: 'pytest -q' }, anchor);
recordCodingWorkToolActivity({ type: 'tool_output', tool: 'bash', command: 'pytest -q', exit_code: 2, output: 'failed' }, anchor);
assert.match(card.children[2].textContent, /Failed/, 'an exact failed acceptance command is visible immediately');
renderCodingWorkPacketStatus({
  type: 'coding_work_packet', stage: 'verify', test_status: 'not_verified', review_status: 'not_reviewed',
  packet: { objective: 'Safe update', acceptance_command: 'pytest -q' },
}, anchor);
assert.match(card.children[2].textContent, /Failed/, 'packet refresh does not erase observed failure');
recordCodingWorkToolActivity({ type: 'tool_start', tool: 'bash', command: 'pytest -q' }, anchor);
recordCodingWorkToolActivity({ type: 'tool_output', tool: 'bash', command: 'pytest -q', exit_code: 0, output: 'passed' }, anchor);
assert.match(card.children[2].textContent, /Passed/, 'only an explicit successful acceptance exit becomes Passed');
console.log('ok');
"""
    result = subprocess.run(
        ["node", "--input-type=module"], input=script, cwd=ROOT,
        capture_output=True, text=True, timeout=20,
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "ok"


def test_packet_renderer_is_wired_for_live_and_reconnected_streams():
    source = (ROOT / "static/js/chat.js").read_text(encoding="utf-8")
    assert "renderCodingWorkPacketStatus, recordCodingWorkToolActivity" in source
    assert source.count("json.type === 'coding_work_packet'") >= 2
    assert "packet evidence is not part of persisted chat history" in source
    assert "recordCodingWorkToolActivity(json, holder, node)" in source
    assert "recordCodingWorkToolActivity(json, holder, currentToolBubble)" in source
    assert 'href="/static/task-activity-upgrade.css"' in (ROOT / "static/index.html").read_text(encoding="utf-8")
