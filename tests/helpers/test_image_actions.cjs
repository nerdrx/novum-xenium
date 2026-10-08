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

async function imageClipboardCase(mode) {
  const writes = [];
  const png = new Blob(['png pixels'], { type: 'image/png' });
  const canvases = [];
  const context = {
    Blob, Promise,
    navigator: mode === 'unavailable' ? {} : { clipboard: {
      write(items) { writes.push(items); return Promise.resolve(); },
    } },
    ClipboardItem: class { constructor(data) { this.data = data; } },
    fetch: async () => ({ ok: mode !== 'http-error', status: 403,
      blob: async () => mode === 'jpeg' ? new Blob(['jpeg pixels'], { type: 'image/jpeg' }) : png }),
    createImageBitmap: async blob => {
      assert.equal(blob.type, 'image/jpeg');
      return { width: 2, height: 3, close() {} };
    },
    document: { createElement(tag) {
      assert.equal(tag, 'canvas');
      const canvas = { getContext: () => ({ drawImage(bitmap) { canvas.bitmap = bitmap; } }),
        toBlob(callback, type) { assert.equal(type, 'image/png'); callback(png); } };
      canvases.push(canvas); return canvas;
    } },
  };
  const source = fs.readFileSync(path.join(repo, 'static/js/imageClipboard.js'), 'utf8')
    .replace(/^export /gm, '') + '\nglobalThis.copyImageToClipboard = copyImageToClipboard;';
  vm.createContext(context);
  vm.runInContext(source, context);

  if (mode === 'unavailable') {
    await assert.rejects(context.copyImageToClipboard('/image.png'), /unavailable/);
    assert.equal(writes.length, 0);
    return;
  }

  const write = context.copyImageToClipboard('/image.png');
  assert.equal(writes.length, 1, 'OS clipboard write must start during the click handler');
  assert.deepEqual(Object.keys(writes[0][0].data), ['image/png']);
  await write;
  if (mode === 'http-error') {
    await assert.rejects(writes[0][0].data['image/png'], /HTTP 403/);
  } else if (mode === 'jpeg') {
    assert.equal((await writes[0][0].data['image/png']).type, 'image/png');
    assert.equal(canvases[0].width, 2);
    assert.equal(canvases[0].height, 3);
  } else {
    assert.equal((await writes[0][0].data['image/png']).type, 'image/png');
  }
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
  for (const mode of ['success', 'jpeg', 'unavailable', 'http-error']) await imageClipboardCase(mode);
  for (const file of ['static/js/chatRenderer.js', 'static/js/compare/stream.js']) {
    await downloadCase(file, false);
    await downloadCase(file, true);
  }
  for (const mode of ['success', 'empty', 'encoding-error']) await editorDownloadCase(mode);
  console.log('PASS: image clipboard capability/error fallbacks, PNG ClipboardItem Promise, internal snapshot, HTTP download failures, delayed blob release, editor blob download/encoding errors');
})().catch(error => { console.error(error); process.exitCode = 1; });
