// Focused JS regressions. Clipboard behavior is simulated; native OS round trips
// belong to the desktop smoke test.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const repo = path.resolve(__dirname, '../..');

async function clipboardCase(mode) {
  const state = { editorOpen: true, wandMask: null, lassoPoints: [] };
  const toasts = [];
  let listener;
  let written = null;
  const canvas = () => ({
    width: 4, height: 4,
    getContext: () => ({ drawImage() {} }),
    toBlob(callback) { this.encode = callback; },
  });
  const source = canvas();
  const context = {
    state, Blob, Promise,
    navigator: mode === 'no-clipboard' ? {} : { clipboard: {
      write(items) {
        written = items;
        return mode === 'denied' ? Promise.reject(new Error('NotAllowedError')) : Promise.resolve();
      },
    } },
    document: { addEventListener(_type, callback) { listener = callback; }, createElement: canvas },
    isAltGrEvent: () => false,
  };
  if (mode !== 'no-constructor') context.ClipboardItem = class {
    constructor(data) {
      if (mode === 'constructor-error') throw new Error('Unsupported clipboard type');
      this.data = data;
    }
  };
  const code = fs.readFileSync(path.join(repo, 'static/js/editor/keyboard-shortcuts.js'), 'utf8')
    .replace(/^import .*;$/gm, '')
    .replace('export function wireKeyboardShortcuts', 'function wireKeyboardShortcuts');
  vm.createContext(context);
  vm.runInContext(code, context);
  context.wireKeyboardShortcuts({
    activeLayer: () => ({ canvas: source }),
    uiModule: { showToast: text => toasts.push(text) },
  });
  listener({ key: 'c', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false,
    target: { tagName: 'BODY' }, preventDefault() {} });
  assert.notEqual(state.internalClipboard, source, 'Internal copy must be a snapshot, not the editable source');
  assert.equal(state.internalClipboard.width, 4);
  if (mode === 'success') assert.ok(written, 'Write must start before the PNG callback, during the key event');
  if (state.internalClipboard.encode) state.internalClipboard.encode(new Blob(['png'], { type: 'image/png' }));
  await new Promise(resolve => setImmediate(resolve));
  if (mode === 'success') {
    assert.ok(written, 'Write starts inside the key event, before PNG encoding finishes');
    assert.ok(written[0].data['image/png'] instanceof Promise);
    assert.equal((await written[0].data['image/png']).type, 'image/png');
    assert.deepEqual(toasts, ['Layer copied to clipboard']);
  } else assert.deepEqual(toasts, ['Layer copied (editor only)']);
}

async function downloadCase(file, ok) {
  const code = fs.readFileSync(path.join(repo, file), 'utf8');
  const match = code.match(/dlBtn\.addEventListener\('click', (async \(e\) => \{[\s\S]*?\})\);\s*actions\.appendChild\(dlBtn\)/);
  assert.ok(match, `${file}: download callback found`);
  const anchors = [];
  const timers = [];
  const revoked = [];
  let blobs = 0;
  const context = {
    prompt: 'Example', imageUrl: '/image.png', imgD: { url: '/image.png', prompt: 'Example' },
    dlBtn: { textContent: '' },
    fetch: async () => ({ ok, status: ok ? 200 : 403, blob: async () => { blobs++; return new Blob(['png']); } }),
    document: { body: { appendChild() {} }, createElement() {
      const anchor = { click() { this.clicked = true; }, remove() {} }; anchors.push(anchor); return anchor;
    } },
    URL: { createObjectURL: () => 'blob:example', revokeObjectURL: url => revoked.push(url) },
    setTimeout: (callback, delay) => timers.push({ callback, delay }),
  };
  vm.createContext(context);
  const handler = vm.runInContext(`(${match[1]})`, context);
  await handler({ stopPropagation() {} });
  if (!ok) {
    assert.equal(blobs, 0, `${file}: HTTP errors must not become downloaded images`);
    assert.equal(anchors.length, 0);
    assert.equal(context.dlBtn.textContent, '✗');
  } else {
    assert.equal(anchors.length, 1);
    assert.equal(anchors[0].clicked, true);
    assert.equal(anchors[0].download, 'Example.png');
    assert.equal(revoked.length, 0, 'Blob URL must survive the click');
    timers.find(timer => timer.delay === 1000).callback();
    assert.deepEqual(revoked, ['blob:example']);
  }
}
async function editorDownloadCase(mode) {
  const source = fs.readFileSync(path.join(repo, 'static/js/galleryEditor.js'), 'utf8');
  const match = source.match(/export (async function downloadPNG\(\) \{[\s\S]*?\n\})/);
  assert.ok(match, 'Production PNG download function found');
  const anchors = [];
  const toasts = [];
  const timers = [];
  const revoked = [];
  const context = {
    flatten: () => ({ toBlob(callback, mime) {
      assert.equal(mime, 'image/png');
      if (mode === 'encoding-error') throw new Error('Tainted canvas');
      callback(mode === 'empty' ? null : new Blob(['png'], { type: mime }));
    } }),
    uiModule: { showToast: text => toasts.push(text) },
    document: { body: { appendChild(anchor) { anchor.appended = true; } }, createElement() {
      const anchor = { click() { assert.equal(this.appended, true); this.clicked = true; }, remove() {} };
      anchors.push(anchor); return anchor;
    } },
    URL: { createObjectURL(blob) { assert.equal(blob.type, 'image/png'); return 'blob:editor'; }, revokeObjectURL: url => revoked.push(url) },
    setTimeout: (callback, delay) => timers.push({ callback, delay }),
  };
  vm.createContext(context);
  await vm.runInContext(`(${match[1]})`, context)();
  if (mode === 'success') {
    assert.equal(anchors.length, 1);
    assert.equal(anchors[0].href, 'blob:editor');
    assert.equal(anchors[0].download, 'edited-image.png');
    assert.equal(anchors[0].clicked, true);
    assert.equal(toasts.length, 0);
    assert.equal(revoked.length, 0);
    timers.find(timer => timer.delay === 1000).callback();
    assert.deepEqual(revoked, ['blob:editor']);
  } else {
    assert.equal(anchors.length, 0);
    assert.deepEqual(toasts, ['Could not prepare the PNG download. Try again.']);
  }
}

(async () => {
  for (const mode of ['success', 'denied', 'no-constructor', 'no-clipboard', 'constructor-error']) await clipboardCase(mode);
  for (const file of ['static/js/chatRenderer.js', 'static/js/compare/stream.js']) {
    await downloadCase(file, false);
    await downloadCase(file, true);
  }
  for (const mode of ['success', 'empty', 'encoding-error']) await editorDownloadCase(mode);
  console.log('PASS: image clipboard capability/error fallbacks, internal snapshot, promise PNG, HTTP download failures, delayed blob release, editor blob download/encoding errors');
})().catch(error => { console.error(error); process.exitCode = 1; });
