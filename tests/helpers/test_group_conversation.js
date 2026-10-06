// Exercise the real group controller without model requests or browser windows.
import fs from 'node:fs';
import assert from 'node:assert/strict';

const scenario = process.argv[2];
const elements = new Map();
const storage = new Map();
const notices = [];
const injections = [];
const prompts = [];
const cards = [];
let streams = 0, spinners = 0, destroyed = 0, aborted = 0;

class Element {
  constructor() { this.style = {}; this.dataset = {}; this.children = []; this.nodes = new Map(); this.listeners = {}; this.classList = { toggle() {}, add() {}, remove() {} }; this.hidden = false; }
  set id(id) { this._id = id; elements.set(id, this); }
  get id() { return this._id; }
  appendChild(el) { this.children.push(el); el.parentNode = this; return el; }
  insertBefore(el) { return this.appendChild(el); }
  remove() { elements.delete(this.id); }
  addEventListener(name, cb) { this.listeners[name] = cb; }
  setAttribute(name, value) { this[name] = value; }
  focus() {}
  contains(el) { return this.children.includes(el); }
  querySelector(selector) {
    if (['.agent-tool-event', 'img'].includes(selector)) return this.children.find(x => selector === 'img' ? x.src : x.className === 'agent-tool-event') || null;
    if (!['.body', '.role', '.ask-user-close', 'svg', '.mode-toggle', '.chat-input-right', '#group-conversation-panel'].includes(selector) && !selector.startsWith('[data-group-')) return null;
    if (!this.nodes.has(selector)) this.nodes.set(selector, new Element());
    return this.nodes.get(selector);
  }
  querySelectorAll() { return []; }
}
const box = new Element(); box.id = 'chat-history'; box.parentNode = new Element();
const composer = new Element();
globalThis.document = { getElementById: id => elements.get(id), createElement: () => new Element(), querySelector: selector => selector === '.chat-input-right' ? composer : null, addEventListener() {} };
for (const [id, checked] of [['bash-toggle', true], ['web-toggle', false], ['rag-toggle', false]]) {
  const el = new Element(); el.id = id; el.checked = checked;
}
globalThis.localStorage = { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) };
globalThis.window = {};
globalThis.MutationObserver = class { observe() {} disconnect() {} };
Math.random = () => 0.999;

const state = { active: true, mode: 'round-robin', models: [{ mid: 'a', display: 'A' }, { mid: 'b', display: 'B' }],
  participantSessions: ['a-session', 'b-session'], parentSessionId: 'parent', autoConversation: true, replyLimit: 0 };
if (['limit', 'concurrent'].includes(scenario)) state.replyLimit = 20;
if (['single', 'parallel', 'toggle', 'approval', 'deny', 'ask-stop', 'ask-stale', 'question', 'tool-events', 'context'].includes(scenario)) state.autoConversation = false;
if (['parallel', 'toggle'].includes(scenario)) state.mode = 'parallel';
storage.set('odysseus-group-state', JSON.stringify(state));

const stubs = `
const uiModule = { esc: s => s, scrollHistory() {}, showToast: msg => globalThis.__notices.push(msg) };
const markdownModule = { squashOutsideCode: s => s, processWithThinking: s => s };
const chatRenderer = { shortModel: s => s, applyModelColor() {}, createMsgFooter: () => document.createElement('div'), safeDisplayImageSrc: s => s,
  renderAskUserCard: (payload, options) => globalThis.__card(payload, options) };
const spinnerModule = { create: () => globalThis.__spinner() };
const providerLogo = () => ''; const PROMPT_TEMPLATES = []; const getUserTemplates = () => []; const sortModelObjects = x => x;
const Storage = { KEYS: { WORKSPACE: 'workspace' }, get: () => '/workspace', loadToggleState: () => ({ mode: 'agent' }), getJSON: (key, fallback) => JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback)) };
`;
globalThis.__notices = notices;
globalThis.__spinner = () => { spinners++; let done = false; return { createElement: () => new Element(), start() {}, destroy() { if (!done) { destroyed++; done = true; } } }; };
globalThis.__card = (payload, options) => {
  const card = new Element(); cards.push({ payload, options, card }); options.root.appendChild(card);
  setTimeout(() => {
    assert.equal(streams, 1, 'No next participant before human choice');
    if (scenario === 'ask-stop' || scenario === 'ask-stale') {
      group.stopConversation();
      assert.equal(options.onSubmit({ kind: 'tool_approval', approval_id: 'approval-1', decision: 'approve' }), false, 'Stale choice must be rejected');
    } else {
      if (scenario !== 'question') {
        assert.equal(options.onSubmit({ kind: 'tool_approval', approval_id: 'wrong-id', decision: 'approve' }), false);
        assert.equal(options.onSubmit({ kind: 'tool_approval', approval_id: 'approval-1', decision: 'invalid' }), false);
      }
      options.onSubmit(scenario === 'question' ? { kind: 'answer', text: 'Use Python' } :
        { kind: 'tool_approval', approval_id: 'approval-1', decision: scenario === 'deny' ? 'deny' : 'approve_task' });
    }
  }, 10);
  return card;
};

const source = fs.readFileSync('static/js/group.js', 'utf8').replace(/^import .*;\r?\n/gm, '');
const group = await import('data:text/javascript;base64,' + Buffer.from(stubs + source).toString('base64'));
assert.equal(group.restoreState('parent'), true);

globalThis.fetch = async (url, options = {}) => {
  if (options.signal?.aborted) throw new DOMException('Stopped', 'AbortError');
  if (!url.endsWith('/api/chat_stream')) {
    injections.push({ url, ...JSON.parse(options.body) });
    if (scenario === 'sync-error' && url.includes('b-session')) return { ok: false, status: 500 };
    return { ok: true };
  }
  streams++;
  assert.ok(streams <= 25, 'Runaway conversation');
  prompts.push(Object.fromEntries(options.body));
  if (scenario === 'http-error') return { ok: false, status: 503 };
  const shouldStop = ['stop', 'stale', 'toggle'].includes(scenario) && streams === 3;
  let text = scenario === 'sse-error' ? 'data: {"error":"Provider failed"}\n\ndata: [DONE]\n\n' :
    `data: ${JSON.stringify({ delta: 'Reply ' + streams })}\n\n` + (scenario === 'early-eof' ? '' : 'data: [DONE]\n\n');
  if (streams === 1 && ['approval', 'deny', 'ask-stop', 'ask-stale', 'question'].includes(scenario)) {
    text = `data: ${JSON.stringify({ delta: 'Please choose' })}\n\ndata: ${JSON.stringify({ type: 'ask_user', data: {
      kind: scenario === 'question' ? 'question' : 'tool_approval', approval_id: 'approval-1', question: 'Allow?', options: ['Yes', 'No'] } })}\n\ndata: [DONE]\n\n`;
  }
  if (scenario === 'tool-events') text = 'data: {"type":"tool_start","tool":"bash","command":"pwd"}\n\ndata: {"delta":"Done"}\n\ndata: [DONE]\n\n';
  const body = new ReadableStream({ start(controller) {
    options.signal.addEventListener('abort', () => { aborted++; try { controller.error(new DOMException('Stopped', 'AbortError')); } catch {} }, { once: true });
    if (shouldStop) {
      queueMicrotask(() => {
        if (scenario === 'stale') {
          group.stopGroup();
          storage.set('odysseus-group-state', JSON.stringify(state));
          group.restoreState('parent');
        } else group.stopConversation();
      });
    } else { controller.enqueue(new TextEncoder().encode(text)); controller.close(); }
  } });
  return { ok: true, body };
};

if (scenario === 'toggle') {
  const checkbox = elements.get('group-conversation-controls').querySelector('[data-group-auto]');
  checkbox.checked = true;
  checkbox.listeners.change({ target: checkbox });
}
if (scenario === 'concurrent') await Promise.all([group.sendMessage('Topic'), group.sendMessage('Duplicate')]);
else await group.sendMessage('Topic');

assert.equal(group.isRunning(), false);
assert.equal(spinners, destroyed, 'All spinners must stop');
for (const prompt of prompts) {
  assert.equal(prompt.mode, 'agent'); assert.equal(prompt.workspace, '/workspace');
  assert.equal(prompt.allow_bash, 'true'); assert.equal(prompt.allow_web_search, 'false');
  assert.equal(prompt.use_rag, 'false'); assert.equal(prompt.plan_mode, 'false');
}
if (['limit', 'concurrent'].includes(scenario)) {
  assert.equal(streams, 20);
  assert.equal(injections.filter(x => x.url.includes('/parent/') && x.messages[0].role === 'user').length, 1);
  assert.deepEqual(prompts.slice(0, 2).map(x => x.message), ['Topic', 'Topic']);
  assert.ok(prompts[2].message.startsWith('Continue the group discussion'));
  assert.ok(prompts[2].message.includes('Original user request:\nTopic'));
  assert.deepEqual(prompts.slice(0, 4).map(x => x.session), ['a-session', 'b-session', 'a-session', 'b-session']);
  assert.ok(injections.some(x => x.url.includes('b-session') && x.messages[0].content === '[A]: Reply 1'));
} else if (['stop', 'stale', 'toggle'].includes(scenario)) {
  assert.equal(streams, 3);
  assert.ok(aborted >= 1);
  assert.equal(group.isActive(), true);
  assert.equal(elements.get('group-conversation-controls').querySelector('[data-group-stop]').hidden, true);
} else if (['approval', 'deny', 'question'].includes(scenario)) {
  assert.equal(streams, 3); assert.equal(cards.length, 1);
  assert.equal(prompts[1].session, 'a-session');
  if (scenario === 'question') assert.equal(prompts[1].message, 'Use Python');
  else { assert.equal(prompts[1].message, ''); assert.equal(prompts[1].tool_approval_id, 'approval-1');
    assert.equal(prompts[1].tool_approval_decision, scenario === 'deny' ? 'deny' : 'approve_task'); }
} else if (['ask-stop', 'ask-stale'].includes(scenario)) assert.equal(streams, 1);
else if (['single', 'parallel', 'context', 'tool-events'].includes(scenario)) {
  assert.equal(streams, 2);
  if (scenario === 'tool-events') assert.ok(box.children.every(x => x.querySelector('.body').children.some(c => c.className === 'agent-tool-event')), 'Text updates must retain tool events');
}
else { assert.equal(streams, 1); assert.ok(notices.some(x => x.includes('stopped'))); }
console.log(JSON.stringify({ scenario, streams, passed: true }));
