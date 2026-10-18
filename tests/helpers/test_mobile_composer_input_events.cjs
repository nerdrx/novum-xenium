const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('static/app.js', 'utf8');
function extract(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert(start >= 0 && end > start, `locate ${startMarker}`);
  return source.slice(start, end);
}
const helpers = [
  extract('function _shouldQueueFromMobileEnter(e, input) {', 'function _shouldQueueFromMobileLineBreak(input) {'),
  extract('function _isLineBreakInputEvent(e) {', 'function _submitMobileQueuedInput(input) {'),
  extract('function _submitMobileQueuedInput(input) {', 'function _syncMobileEnterKeyHint(input) {'),
  extract('function _shouldQueueFromMobileLineBreak(input) {', 'function _isLineBreakInputEvent(e) {'),
  extract('function _countLineBreaks(s) {', 'function initForegroundActivityHeartbeat() {'),
].join('\n');
const beforeinputHandler = extract("    textarea.addEventListener('beforeinput', (e) => {", "    textarea.addEventListener('input', (e) => {");
const inputHandler = extract("    textarea.addEventListener('input', (e) => {", "    textarea.addEventListener('paste', () => {");
const clipboardHandlers = extract("    textarea.addEventListener('paste', () => {", "    textarea.addEventListener('keydown', (e) => {");
const keydownHandler = extract("    textarea.addEventListener('keydown', (e) => {", '    });\n  }\n\n  // ── Ghost text autocomplete') + '    });';
const listenerState = extract("    let previousTextareaValue = textarea.value || '';", "    textarea.addEventListener('beforeinput', (e) => {");

function setup({ mobile = true, busy = true, initial = 'draft' } = {}) {
  let queued = 0, resized = 0, hinted = 0;
  let nextTimer = 0;
  const timers = new Map();
  class Textarea {
    constructor() { this.value = initial; this.dataset = {}; this.handlers = {}; }
    addEventListener(type, handler) { this.handlers[type] = handler; }
    setAttribute() {}
  }
  const textarea = new Textarea();
  const context = {
    textarea,
    window: { innerWidth: mobile ? 390 : 1280 },
    document: {},
    chatModule: { queueStreamingComposerRequest() { queued++; return true; } },
    uiModule: { autoResize() { resized++; } },
    _isMobileChatInput: () => mobile,
    _isForegroundChatBusy: () => busy,
    _syncMobileEnterKeyHint: () => { hinted++; },
    _submitChatFormDirect() {},
    el: () => ({}),
    setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, delay, cleared: false }); return id; },
    clearTimeout(id) { const timer = timers.get(id); if (timer) timer.cleared = true; },
    Date,
  };
  vm.createContext(context);
  vm.runInContext(`${helpers}\n${listenerState}\n${beforeinputHandler}\n${inputHandler}\n${clipboardHandlers}\n${keydownHandler}`, context);
  return {
    textarea, queued: () => queued, resized: () => resized, hinted: () => hinted,
    runTimers(delay) { for (const timer of timers.values()) if (!timer.cleared && timer.delay === delay) { timer.cleared = true; timer.callback(); } },
  };
}
function event(fields = {}) {
  return { defaultPrevented: false, stopped: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, ...fields };
}
function checkPaste(inputType, text) {
  const fixture = setup();
  fixture.textarea.handlers.paste(event());
  const before = event({ inputType, data: text });
  fixture.textarea.handlers.beforeinput(before);
  fixture.textarea.value = text;
  fixture.textarea.handlers.input(event({ inputType, data: text }));
  assert.equal(fixture.queued(), 0, `${inputType} must remain draft input`);
  assert.equal(before.defaultPrevented, false);
  assert.equal(fixture.textarea.value, text);
  assert.equal(fixture.resized(), 1, 'normal input resize path remains active');
}

checkPaste('insertFromPaste', 'first line\nsecond line');
checkPaste('insertFromPaste', '\n');
{
  const fixture = setup();
  fixture.textarea.handlers.drop(event());
  const before = event({ inputType: 'insertFromDrop', data: 'dropped\nlines' });
  fixture.textarea.handlers.beforeinput(before);
  fixture.textarea.value = 'dropped\nlines';
  fixture.textarea.handlers.input(event({ inputType: 'insertFromDrop', data: 'dropped\nlines' }));
  assert.equal(fixture.queued(), 0);
  assert.equal(fixture.textarea.value, 'dropped\nlines');
  assert.equal(fixture.resized(), 1);
}
for (const kind of ['paste', 'drop']) {
  const fixture = setup();
  fixture.textarea.handlers[kind](event());
  const before = event({ inputType: '', data: '\n' });
  fixture.textarea.handlers.beforeinput(before);
  fixture.textarea.value += '\n';
  fixture.textarea.handlers.input(event({ inputType: '', data: '\n' }));
  assert.equal(fixture.queued(), 0, `legacy ${kind} newline remains draft input`);
  assert.equal(before.defaultPrevented, false);
  assert.equal(fixture.textarea.value, 'draft\n');
  assert.equal(fixture.resized(), 1);
}
for (const kind of ['paste', 'drop']) {
  const fixture = setup();
  fixture.textarea.handlers[kind](event());
  const before = event({ inputType: 'insertLineBreak', data: '\n' });
  fixture.textarea.handlers.beforeinput(before);
  fixture.textarea.value += '\n';
  fixture.textarea.handlers.input(event({ inputType: 'insertLineBreak', data: '\n' }));
  assert.equal(fixture.queued(), 0, `${kind} marker suppresses its associated explicit linebreak event`);
  assert.equal(before.defaultPrevented, false);
  assert.equal(fixture.textarea.value, 'draft\n');
}
{
  const fixture = setup();
  fixture.textarea.handlers.paste(event()); // canceled paste: no beforeinput/input follows
  fixture.runTimers(0);
  const before = event({ inputType: '', data: '\n' });
  fixture.textarea.handlers.beforeinput(before);
  assert.equal(fixture.queued(), 1, 'expired clipboard suppression does not block the next legacy Enter');
  assert.equal(before.defaultPrevented, true);
}

{
  const fixture = setup();
  const before = event({ inputType: 'insertLineBreak', data: '\n', isComposing: true });
  fixture.textarea.handlers.beforeinput(before);
  fixture.textarea.value += '\n';
  fixture.textarea.handlers.input(event({ inputType: 'insertCompositionText', data: '\n', isComposing: true }));
  assert.equal(fixture.queued(), 0, 'composition must not queue');
  assert.equal(before.defaultPrevented, false);
  assert.equal(fixture.textarea.value, 'draft\n');
  assert.equal(fixture.resized(), 1);
}

for (const inputType of ['insertLineBreak', 'insertParagraph']) {
  const fixture = setup();
  const before = event({ inputType, data: '\n' });
  fixture.textarea.handlers.beforeinput(before);
  assert.equal(fixture.queued(), 1, `${inputType} queues exactly once`);
  assert.equal(before.defaultPrevented, true);
  assert.equal(before.stopped, true);
}

for (const modifier of ['shiftKey', 'ctrlKey', 'metaKey', 'altKey']) {
  const fixture = setup();
  const keydown = event({ key: 'Enter', [modifier]: true });
  fixture.textarea.handlers.keydown(keydown);
  assert.equal(keydown.defaultPrevented, false, `${modifier} Enter must retain its line break`);
  const before = event({ inputType: 'insertLineBreak', data: '\n' });
  fixture.textarea.handlers.beforeinput(before);
  fixture.textarea.value += '\n';
  fixture.textarea.handlers.input(event({ inputType: 'insertLineBreak', data: '\n' }));
  assert.equal(fixture.queued(), 0, `${modifier} Enter does not queue`);
  assert.equal(fixture.textarea.value, 'draft\n');
  assert.equal(fixture.resized(), 1);
  const normalEnter = event({ key: 'Enter' });
  fixture.textarea.handlers.keydown(normalEnter);
  assert.equal(fixture.queued(), 1, 'following ordinary Enter still queues');
}

{
  const fixture = setup();
  fixture.textarea.handlers.keydown(event({ key: 'Enter', shiftKey: true })); // canceled modifier: no edit events
  fixture.runTimers(0);
  const normalEnter = event({ key: 'Enter' });
  fixture.textarea.handlers.keydown(normalEnter);
  assert.equal(fixture.queued(), 1, 'modifier intent expires when no edit event follows');
}

{
  const fixture = setup();
  const before = event({ inputType: '', data: '\n' });
  fixture.textarea.handlers.beforeinput(before);
  assert.equal(fixture.queued(), 1, 'legacy beforeinput data fallback remains');
}
{
  const fixture = setup();
  fixture.textarea.handlers.beforeinput(event({ inputType: '', data: '' }));
  fixture.textarea.value += '\n';
  fixture.textarea.handlers.input(event({ inputType: '', data: '' }));
  assert.equal(fixture.queued(), 1, 'legacy input count fallback remains');
}
{
  const fixture = setup({ mobile: false, busy: false });
  const before = event({ inputType: 'insertParagraph', data: '\n' });
  fixture.textarea.handlers.beforeinput(before);
  fixture.textarea.value += '\n';
  fixture.textarea.handlers.input(event({ inputType: 'insertParagraph', data: '\n' }));
  assert.equal(fixture.queued(), 0, 'desktop idle line breaks are not queued');
  assert.equal(before.defaultPrevented, false);
  assert.equal(fixture.resized(), 1);
}

console.log('PASS: mobile composer paste/drop/composition, modified and ordinary Enter, legacy fallback, and desktop idle');
