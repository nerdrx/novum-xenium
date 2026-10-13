from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
HAS_NODE = shutil.which("node") is not None


@pytest.mark.skipif(not HAS_NODE, reason="node is unavailable")
def test_status_card_is_safe_accessible_and_updates_in_place():
    script = r"""
import assert from 'node:assert/strict';
import { renderCodingWorkPacketStatus } from './static/js/codingWorkPacket.js';
class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.dataset = {}; this.attributes = {}; this.parentNode = null; this._text = ''; }
  setAttribute(key, value) { this.attributes[key] = value; }
  appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
  append(...children) { children.forEach(child => this.appendChild(child)); }
  insertBefore(child, before) { child.parentNode = this; const i = this.children.indexOf(before); this.children.splice(i < 0 ? this.children.length : i, 0, child); return child; }
  removeChild(child) { this.children.splice(this.children.indexOf(child), 1); child.parentNode = null; return child; }
  get firstChild() { return this.children[0] || null; }
  get previousSibling() { if (!this.parentNode) return null; return this.parentNode.children[this.parentNode.children.indexOf(this) - 1] || null; }
  get nextSibling() { if (!this.parentNode) return null; return this.parentNode.children[this.parentNode.children.indexOf(this) + 1] || null; }
  set textContent(value) { while (this.firstChild) this.removeChild(this.firstChild); this._text = String(value); }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set innerHTML(_value) { throw new Error('HTML insertion is forbidden'); }
}
globalThis.document = { createElement: tag => new Element(tag) };
const parent = new Element('div');
const anchor = new Element('article');
parent.appendChild(anchor);
const card = renderCodingWorkPacketStatus({
  type: 'coding_work_packet', stage: 'verify', test_status: 'not_verified',
  review_status: 'not_reviewed', packet: { objective: '<img src=x onerror=alert(1)>' },
}, anchor);
assert.equal(card.attributes.role, 'status');
assert.equal(card.attributes['aria-live'], 'polite');
assert.equal(card.previousSibling, anchor);
assert.equal(card.children[0].textContent, '<img src=x onerror=alert(1)>');
assert.equal(card.children[1].children[1].children[1].textContent, 'Not verified');
assert.equal(card.children[1].children[2].children[1].textContent, 'Not reviewed');
const updated = renderCodingWorkPacketStatus({
  type: 'coding_work_packet', stage: 'done', test_status: 'passed',
  review_status: 'not_reviewed', packet: { objective: 'Safe update' },
}, anchor);
assert.equal(updated, card);
assert.equal(parent.children.length, 2);
assert.equal(card.dataset.stage, 'done');
assert.equal(card.children[1].children[0].children[1].textContent, 'Slice checked');
assert.equal(card.children[1].children[1].children[1].textContent, 'Passed');
console.log('ok');
"""
    result = subprocess.run(
        ["node", "--input-type=module"], input=script, cwd=ROOT,
        capture_output=True, text=True, timeout=20,
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "ok"


def test_live_and_reconnect_streams_handle_packet_events_without_claiming_history():
    source = (ROOT / "static/js/chat.js").read_text(encoding="utf-8")
    assert "import { renderCodingWorkPacketStatus } from './codingWorkPacket.js';" in source
    assert source.count("json.type === 'coding_work_packet'") >= 2
    assert "packet evidence is not part of persisted chat history" in source

