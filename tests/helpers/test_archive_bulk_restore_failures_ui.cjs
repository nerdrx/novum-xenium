// Exercise the real archive bulk-restore handler against fixture-only API replies.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

const repo = path.resolve(__dirname, '../..');
let mode = 'partial';
const attempts = {};
let heldId = null;
let releaseHeld = null;
const html = `<!doctype html><body>
<script type="module">
  import * as sessions from '/static/js/sessions.js';
  import ui from '/static/js/ui.js';
  window.toasts = [];
  ui.showToast = message => window.toasts.push(message);
  ui.showError = message => window.toasts.push('ERROR:' + message);
  window.sessions = sessions;
  window.fixtureReady = true;
</script></body>`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/') return res.end(html);
  if (url.pathname === '/__mode') {
    mode = url.searchParams.get('value');
    res.writeHead(204);
    return res.end();
  }
  if (url.pathname === '/__hold') {
    heldId = url.searchParams.get('id');
    res.writeHead(204);
    return res.end();
  }
  if (url.pathname === '/__release') {
    const release = releaseHeld;
    releaseHeld = null;
    release?.();
    res.writeHead(204);
    return res.end();
  }
  if (url.pathname === '/__state') {
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ attempts }));
  }
  const match = url.pathname.match(/^\/api\/session\/([^/]+)\/unarchive$/);
  if (match) {
    const id = match[1];
    attempts[id] = (attempts[id] || 0) + 1;
    const fail = mode === 'all-fail' || (mode === 'partial' && id === 'fail');
    const respond = () => {
      res.writeHead(fail ? 503 : 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(fail ? { detail: 'fixture outage' } : { ok: true }));
    };
    if (id === heldId) { heldId = null; releaseHeld = respond; }
    else respond();
    return;
  }
  const file = path.resolve(repo, `.${url.pathname}`);
  if (!file.startsWith(repo + path.sep) || !fs.existsSync(file)) {
    res.writeHead(404);
    return res.end();
  }
  res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : 'text/plain');
  if (file === path.join(repo, 'static/js/sessions.js')) {
    let source = fs.readFileSync(file, 'utf8');
    const start = source.indexOf('async function _arcBulkRestore() {');
    const end = source.indexOf('\nfunction _arcToggleSelectMode', start);
    const handler = source.slice(start, end).replace('loadSessions();', '');
    const testSeam = `window.__setArchiveItems = ids => {
      _arc.data = ids.map(id => ({ id }));
      _arc.total = ids.length;
      _arc.selected = new Set(ids);
    };
    window.__getArchiveState = () => ({
      ids: _arc.data.map(item => item.id), total: _arc.total,
      selected: [..._arc.selected],
    });
    window.__addArchiveItem = id => {
      _arc.data.push({ id });
      _arc.total++;
      _arc.selected.add(id);
      _arcRefreshUI();
    };
    window.__runArchiveBulkRestore = _arcBulkRestore;
    `;
    source = source.slice(0, start) + testSeam + handler + source.slice(end);
    return res.end(source);
  }
  fs.createReadStream(file).pipe(res);
});

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.BROWSER_EXECUTABLE,
    args: ['--no-sandbox', '--disable-gpu'],
  });
  try {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForFunction(() => window.fixtureReady && window.__runArchiveBulkRestore);

    await page.evaluate(() => window.__setArchiveItems(['ok', 'fail']));
    await page.evaluate(() => fetch('/__hold?id=ok'));
    await page.evaluate(() => { window.firstRestore = window.__runArchiveBulkRestore(); });
    await page.waitForFunction(async () => (await (await fetch('/__state')).json()).attempts.ok === 1);
    await page.evaluate(() => window.__runArchiveBulkRestore()); // ignored while the first run owns this selection
    await page.evaluate(() => window.__addArchiveItem('new-selection'));
    assert.deepEqual((await page.evaluate(() => (window.__getArchiveState()))).selected,
      ['ok', 'fail', 'new-selection'], 'selection changes remain possible during a pending request');
    await page.evaluate(() => fetch('/__release'));
    await page.evaluate(() => window.firstRestore);
    assert.deepEqual(await page.evaluate(() => window.__getArchiveState()), {
      ids: ['fail', 'new-selection'], total: 2, selected: ['fail', 'new-selection'],
    }, 'only captured successes leave; failed and newly selected items remain selected');
    assert.deepEqual(await page.evaluate(() => window.toasts), [
      'ERROR:Restored 1 session · 1 failed',
    ]);

    await page.evaluate(() => fetch('/__mode?value=all-fail'));
    await page.evaluate(() => window.__setArchiveItems(['fail-a', 'fail-b']));
    await page.evaluate(() => window.__runArchiveBulkRestore());
    assert.deepEqual(await page.evaluate(() => window.__getArchiveState()), {
      ids: ['fail-a', 'fail-b'], total: 2, selected: ['fail-a', 'fail-b'],
    }, 'an all-failed attempt preserves every row and selection');
    assert.deepEqual(await page.evaluate(() => window.toasts), [
      'ERROR:Restored 1 session · 1 failed',
      'ERROR:Restored 0 sessions · 2 failed',
    ]);

    await page.evaluate(() => fetch('/__mode?value=success'));
    await page.evaluate(() => window.__runArchiveBulkRestore());
    assert.deepEqual(await page.evaluate(() => window.__getArchiveState()), {
      ids: [], total: 0, selected: [],
    }, 'retrying the retained selection removes it after success');
    assert.equal((await page.evaluate(() => window.toasts)).at(-1), '2 sessions restored');
    assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join('\n')}`);
    assert.deepEqual(attempts, { ok: 1, fail: 1, 'fail-a': 2, 'fail-b': 2 });
    console.log('PASS: archive bulk restore retains failures for retry and reports actual outcomes');
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => {
  console.error(error);
  server.close();
  process.exitCode = 1;
});
