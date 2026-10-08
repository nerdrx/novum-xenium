const assert = require('node:assert/strict');
const fs = require('node:fs');
const source = fs.readFileSync('static/js/chat.js', 'utf8');
const start = source.indexOf('  function _createQueuedBubble(item) {');
const end = source.indexOf('\n  function _renderQueuedRequestsForCurrentSession()', start);
assert.ok(start >= 0 && end > start, 'queued bubble builder exists');
const createBubble = source.slice(start, end);
const apiStart = source.indexOf('  const chatModule = {');
const apiEnd = source.indexOf('\n  };', apiStart);
assert.ok(apiStart >= 0 && apiEnd > apiStart, 'public chat module API exists');
assert.match(source.slice(apiStart, apiEnd), /\bqueueStreamingComposerRequest\s*,/, 'app queue callers can reach the named export');

class Element {
  constructor() { this.attrs = {}; this.listeners = {}; this.dataset = {}; }
  setAttribute(name, value) { this.attrs[name] = value; }
  addEventListener(type, callback) { this.listeners[type] = callback; }
  appendChild(child) { child.parentNode = this; return child; }
}

const host = new Element();
const promoted = [];
const document = { createElement: () => new Element() };
const _ensureQueuedBubbleHost = () => host;
const _promoteQueuedRequest = id => promoted.push(id);
const _escapeQueueText = text => String(text || '');
const uiModule = { scrollHistory() {} };
const makeBubble = new Function('document', '_ensureQueuedBubbleHost', '_promoteQueuedRequest', '_escapeQueueText', 'uiModule', `${createBubble}\nreturn _createQueuedBubble;`);
const item = { id: 'queue-1', message: 'Continue this task' };
const wrap = makeBubble(document, _ensureQueuedBubbleHost, _promoteQueuedRequest, _escapeQueueText, uiModule)(item);
assert.equal(wrap.attrs.role, 'button');
assert.equal(wrap.attrs.tabindex, '0');
assert.match(wrap.attrs['aria-label'], /Continue this task.*stop the current response/);
assert.equal(wrap.title, 'Queued - activate to send now and stop the current response');

let prevented = false;
wrap.listeners.keydown({ key: 'Enter', repeat: false, target: wrap, preventDefault() { prevented = true; } });
assert.equal(prevented, true);
assert.deepEqual(promoted, ['queue-1']);
wrap.listeners.keydown({ key: ' ', repeat: false, target: wrap, preventDefault() { prevented = true; } });
assert.deepEqual(promoted, ['queue-1', 'queue-1'], 'Space activates the same promotion action');
wrap.listeners.keydown({ key: 'Enter', repeat: true, target: wrap, preventDefault() {} });
assert.equal(promoted.length, 2, 'held key does not repeatedly promote');

wrap.listeners.click({ target: wrap });
assert.deepEqual(promoted, ['queue-1', 'queue-1', 'queue-1'], 'existing mouse activation remains intact');
const nested = { closest: selector => selector.includes('button') ? {} : null };
wrap.listeners.click({ target: nested });
wrap.listeners.keydown({ key: 'Enter', repeat: false, target: nested, preventDefault() { throw new Error('nested control key should be ignored'); } });
assert.equal(promoted.length, 3, 'nested controls are not double-activated');
console.log('queued bubble keyboard activation and mouse behavior ok');
