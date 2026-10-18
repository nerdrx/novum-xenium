// Synthetic keyboard, focus-return, and mobile reachability regression for Notes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

const repo = path.resolve(__dirname, '../..');
const evidenceDir = process.env.EVIDENCE_DIR || os.tmpdir();
const output = path.join(evidenceDir, 'notes-accessibility-results.json');
const { withAppStyles } = require('./app_styles.cjs');
const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><!-- APP_STYLESHEET_LINKS --><body><aside id="sidebar"></aside><button id="tool-notes-btn">Notes</button><div id="chat-container"></div><div id="toast"></div><script type="module">import notes from '/static/js/notes.js'; notes.openPanel(); window.fixtureReady=true;</script></body>`;
let note = { id: 'synthetic-note', title: 'Keyboard test note', content: 'Local fixture only.', note_type: 'note', label: '', color: '', pinned: false, archived: false, due_date: null, repeat: 'none', items: [], created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' };
const writes = [];
let holdNoteReads = false;
const heldNoteReadContinuations = [];
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const json = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
  if (url.pathname === '/') return res.end(await withAppStyles(html));
  if (url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
  if (url.pathname === '/api/notes' && req.method === 'GET') {
    if (holdNoteReads) await new Promise(resolve => heldNoteReadContinuations.push(resolve));
    return json(200, { notes: [note] });
  }
  if (url.pathname === '/fixture/hold-reads') { holdNoteReads = true; return json(200, {}); }
  if (url.pathname === '/fixture/release-reads') {
    holdNoteReads = false;
    while (heldNoteReadContinuations.length) heldNoteReadContinuations.shift()();
    return json(200, {});
  }
  if (url.pathname === '/fixture/read-state') return json(200, { pending: heldNoteReadContinuations.length });
  if (url.pathname === '/fixture/write-state') return json(200, { count: writes.length });
  if (url.pathname === '/api/notes/synthetic-note' && req.method === 'PUT') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const patch = JSON.parse(body || '{}');
      writes.push(patch);
      note = { ...note, ...patch, id: note.id };
      json(200, note);
    });
    return;
  }
  const file = path.resolve(repo, `.${url.pathname}`);
  if (!file.startsWith(path.join(repo, 'static') + path.sep) || !fs.existsSync(file)) return json(404, {});
  res.setHeader('Content-Type', file.endsWith('.js') || file.endsWith('.mjs') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
});

async function main() {
  fs.mkdirSync(evidenceDir, { recursive: true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE, args: ['--no-sandbox', '--disable-gpu'] });
  const results = {};
  try {
    for (const viewport of [{ width: 320, height: 720 }, { width: 390, height: 844 }, { width: 600, height: 320 }]) {
      note = { ...note, title: 'Keyboard test note', content: 'Local fixture only.', pinned: false };
      writes.length = 0;
      const context = await browser.newContext({ viewport, isMobile: true, hasTouch: true });
      const page = await context.newPage();
      const pageErrors = [];
      const externalRequests = [];
      page.on('pageerror', error => pageErrors.push(error.stack || error.message));
      page.on('request', request => { if (new URL(request.url()).hostname !== '127.0.0.1') externalRequests.push(request.url()); });
      page.setDefaultTimeout(7000);
      await page.goto(`http://127.0.0.1:${server.address().port}/`);
      await page.waitForFunction(() => window.fixtureReady && !!document.querySelector('.note-card[data-note-id="synthetic-note"]'));
      await page.waitForTimeout(600);
      const stylesheetCounts = await page.locator('link[rel="stylesheet"]').evaluateAll(links => ({ total: links.length, loaded: links.filter(link => !!link.sheet).length }));
      const title = page.locator('.note-card[data-note-id="synthetic-note"] .note-card-title[data-action="edit"]');
      const initial = await title.evaluate(el => ({
        tag: el.tagName,
        role: el.getAttribute('role'),
        name: el.getAttribute('aria-label'),
        tabindex: el.tabIndex,
        parentButton: !!el.closest('button:not(.note-card-title)'),
        box: (() => { const r = el.getBoundingClientRect(); return { width: r.width, height: r.height }; })(),
      }));
      assert.ok(stylesheetCounts.total > 0 && stylesheetCounts.loaded === stylesheetCounts.total, 'complete app stylesheet order loads');
      assert.equal(initial.tag, 'BUTTON', 'note open action is native button');
      assert.equal(initial.parentButton, false, 'open action is not nested in another button');
      assert.match(initial.name, /^Open note: Keyboard test note$/);

      await page.evaluate(() => {
        window.noteOverlayOpenCount = 0;
        new MutationObserver(records => records.forEach(record => record.addedNodes.forEach(node => {
          if (node.nodeType === 1 && node.matches('.note-fullscreen-overlay')) window.noteOverlayOpenCount++;
        }))).observe(document.body, { childList: true });
      });
      let tabFoundTitle = false;
      for (let i = 0; i < 50; i++) {
        await page.keyboard.press('Tab');
        if (await page.evaluate(() => document.activeElement?.matches('.note-card-title[data-action="edit"]'))) { tabFoundTitle = true; break; }
      }
      assert.equal(tabFoundTitle, true, 'Tab reaches note open action');
      await page.keyboard.press('Enter');
      await page.waitForSelector('.note-fullscreen-overlay.open');
      await page.waitForTimeout(350);
      assert.equal(await page.evaluate(() => window.noteOverlayOpenCount), 1, 'Enter opens the editor once');
      assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Back to notes', 'mobile editor focuses its Back control');
      const open = await page.evaluate(() => {
        const back = document.querySelector('.note-fullscreen-back').getBoundingClientRect();
        const body = document.querySelector('.note-fullscreen-body');
        return { back: { width: back.width, height: back.height }, body: { scrollHeight: body.scrollHeight, clientHeight: body.clientHeight }, documentWidth: document.documentElement.scrollWidth };
      });
      assert.ok(open.documentWidth <= viewport.width, `editor overflows at ${viewport.width}px`);
      if (viewport.width === 390 || viewport.width === 600) await page.screenshot({ path: path.join(evidenceDir, `notes-${viewport.width}x${viewport.height}-keyboard-open.png`), fullPage: false, animations: 'disabled' });

      const saveResponse = page.waitForResponse(response => response.url().endsWith('/api/notes/synthetic-note') && response.request().method() === 'PUT');
      await page.locator('.note-fullscreen-back').click();
      await saveResponse;
      await page.waitForFunction(() => !document.querySelector('.note-fullscreen-overlay'));
      await page.waitForFunction(() => document.activeElement?.matches('.note-card[data-note-id="synthetic-note"] .note-card-title'));
      assert.equal(writes.length, 1, 'Back keeps its existing save behavior');

      // A delayed refresh must not steal focus from a newer Notes control.
      await page.request.get(`http://127.0.0.1:${server.address().port}/fixture/hold-reads`);
      await title.focus();
      await page.keyboard.press('Enter');
      await page.waitForSelector('.note-fullscreen-overlay.open');
      const writesBeforeDelayedSave = writes.length;
      await page.locator('.note-fullscreen-back').click();
      await page.waitForFunction(async count => (await fetch('/fixture/write-state').then(r => r.json())).count > count, writesBeforeDelayedSave);
      await page.waitForFunction(() => !document.querySelector('.note-fullscreen-overlay'));
      await page.waitForFunction(async () => (await fetch('/fixture/read-state').then(r => r.json())).pending > 0);
      await page.locator('#notes-search').focus();
      assert.equal(await page.evaluate(() => document.activeElement?.id), 'notes-search');
      await page.request.get(`http://127.0.0.1:${server.address().port}/fixture/release-reads`);
      await page.waitForSelector('.note-card[data-note-id="synthetic-note"] .note-card-title');
      assert.equal(await page.evaluate(() => document.activeElement?.id), 'notes-search', 'delayed refresh does not steal newer search focus');

      await title.focus();
      await page.keyboard.press('Space');
      await page.waitForSelector('.note-fullscreen-overlay.open');
      await page.waitForTimeout(350);
      assert.equal(await page.evaluate(() => window.noteOverlayOpenCount), 3, 'Space opens the editor once');
      const body = page.locator('.note-fullscreen-body');
      await page.locator('.note-form-cancel').scrollIntoViewIfNeeded();
      const cancelResponseCount = writes.length;
      await page.locator('.note-form-cancel').click();
      await page.waitForFunction(() => !document.querySelector('.note-fullscreen-overlay'));
      await page.waitForFunction(() => document.activeElement?.matches('.note-card[data-note-id="synthetic-note"] .note-card-title'));
      assert.equal(writes.length, cancelResponseCount, 'Cancel closes without saving');

      await title.focus();
      await page.locator('#notes-select-btn').click();
      assert.equal(await title.getAttribute('aria-pressed'), 'false');
      assert.match(await title.getAttribute('aria-label'), /^Select note: Keyboard test note$/);
      await title.focus();
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.querySelector('.note-card-cb')?.checked);
      assert.equal(await title.getAttribute('aria-pressed'), 'true', 'select mode announces selected state');
      assert.equal(await page.locator('.note-fullscreen-overlay').count(), 0, 'selection does not open editor');
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => !document.querySelector('.note-card-cb')?.checked);
      assert.equal(await title.getAttribute('aria-pressed'), 'false', 'keyboard selection toggles once');
      await page.locator('#notes-select-btn').click();

      // When refresh/filter removes the source card, Cancel returns focus to Notes search.
      await title.focus();
      await page.keyboard.press('Enter');
      await page.waitForSelector('.note-fullscreen-overlay.open');
      await page.locator('#notes-search').fill('no matching synthetic note');
      await page.waitForFunction(() => !document.querySelector('.note-card[data-note-id="synthetic-note"]'));
      await page.locator('.note-form-cancel').click();
      await page.waitForFunction(() => !document.querySelector('.note-fullscreen-overlay'));
      assert.equal(await page.evaluate(() => document.activeElement?.id), 'notes-search', 'removed opener uses a visible Notes fallback');

      // Short landscape actions must fit after scrolling the actual editor body.
      await page.locator('#notes-search').fill('');
      await page.waitForSelector('.note-card-title[data-action="edit"]');
      await page.locator('.note-card-title[data-action="edit"]').click();
      await page.waitForSelector('.note-fullscreen-overlay.open');
      const actions = page.locator('.note-fullscreen-body');
      await actions.evaluate(el => { el.scrollTop = el.scrollHeight; });
      const footer = await page.evaluate(() => {
        const visible = el => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; };
        return { saveVisible: visible(document.querySelector('.note-form-save')), cancelVisible: visible(document.querySelector('.note-form-cancel')), scrollTop: document.querySelector('.note-fullscreen-body').scrollTop };
      });
      assert.equal(footer.saveVisible, true, 'Save reaches the viewport after scrolling');
      assert.equal(footer.cancelVisible, true, 'Cancel reaches the viewport after scrolling');
      assert.ok(await page.evaluate(width => document.documentElement.scrollWidth <= width, viewport.width), 'page has no horizontal overflow');
      await page.locator('.note-form-cancel').click();
      await page.waitForFunction(() => !document.querySelector('.note-fullscreen-overlay'));
      let replacementTimerOverlayPreserved = null;
      if (viewport.width === 390) {
        replacementTimerOverlayPreserved = await page.evaluate(async () => {
          const { createMobileEditor } = await import('/static/js/features/notes/ui/mobileEditor.js');
          const note = { id: 'timer-fixture', content: '', note_type: 'note' };
          const state = { notes: [note], open: true, editingId: null };
          const editor = createMobileEditor({
            _applyDraftToNote: value => ({ note: value, restored: false }),
            _buildForm: () => {
              const form = document.createElement('form');
              form.className = 'note-form';
              form.innerHTML = '<button type="button" class="note-form-save">Save</button><button type="button" class="note-form-cancel">Cancel</button>';
              return form;
            },
            _fetchNotes: async () => {}, _linkify: value => value, _renderNotes: () => {}, _uid: () => 'row',
            _wireChecklistTouchReorder: () => {}, _wireRow: () => {}, app: { setEditingId: value => { state.editingId = value; } },
            state, uiModule: { showToast: () => {} },
          });
          editor._openMobileFullscreenEdit(note.id, null);
          document.querySelector('.note-fullscreen-overlay .note-form-save').click();
          document.querySelector('.note-fullscreen-overlay .note-form-cancel').click();
          editor._openMobileFullscreenEdit(note.id, null);
          await new Promise(resolve => setTimeout(resolve, 400));
          const preserved = !!document.querySelector('.note-fullscreen-overlay.open');
          const editingId = state.editingId;
          editor._closeMobileFullscreenEdit({ save: false });
          await new Promise(resolve => setTimeout(resolve, 230));
          return { preserved, editingId };
        });
        assert.deepEqual(replacementTimerOverlayPreserved, { preserved: true, editingId: 'timer-fixture' }, 'old Save timer leaves replacement editor and editing state intact');
      }
      assert.deepEqual(pageErrors, []);
      assert.deepEqual(externalRequests, []);
      results[`${viewport.width}x${viewport.height}`] = { stylesheetCounts, initial, tabFoundTitle, enterOpenCount: 1, spaceOpenCount: 1, open, backSaved: true, cancelDidNotSave: true, selectedPressedState: true, staleOpenerFallback: 'notes-search', footer, replacementTimerOverlayPreserved, writes: writes.length, pageErrors, externalRequests };
      await context.close();
    }
    fs.writeFileSync(output, JSON.stringify(results, null, 2));
    console.log('PASS Notes keyboard open, focus return, save boundaries, and mobile reachability');
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
