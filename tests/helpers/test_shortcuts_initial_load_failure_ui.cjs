const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || '/run/media/nerdrx/Lex/novum-xenium/node_modules/playwright');

const repo = path.resolve(process.env.SOURCE_ROOT || path.join(__dirname, '../..'));
const sourceFiles = ['static/index.html', 'static/js/settings.js', 'static/js/settings/api.js', 'static/js/settings/registry.js'];
const sourceHashes = Object.fromEntries(sourceFiles.map(name => [name, crypto.createHash('sha256').update(fs.readFileSync(path.join(repo, name))).digest('hex')]));
const requests = [];
const posts = [];
const externalRequests = [];
const pageErrors = [];
const results = {};
const seeded = { search: 'ctrl+shift+u', focus_input: 'alt+shift+q', plugin_action: 'ctrl+shift+j', toggle_sidebar: 'ctrl+b' };
let readPlan = { mode: 'success', value: { keybinds: seeded }, status: 200 };
let stored = { keybinds: structuredClone(seeded) };
let heldRead;

function json(res, value, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

function callerFrom(req) {
  const caller = req.headers['x-fixture-caller'] || 'unclassified';
  return caller;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(fs.readFileSync(path.join(repo, 'static/index.html'), 'utf8').replaceAll('{{CSP_NONCE}}', 'fixture-nonce'));
  }
  if (url.pathname === '/api/auth/status') return json(res, { username: 'synthetic-admin', is_admin: true, privileges: {} });
  if (url.pathname === '/api/auth/features') return json(res, {});
  if (url.pathname === '/api/auth/settings' && req.method === 'GET') {
    const caller = callerFrom(req);
    const record = { method: 'GET', caller, status: readPlan.status ?? 200 };
    requests.push(record);
    if (caller !== 'initShortcuts') return json(res, {});
    if (readPlan.mode === 'headers' || readPlan.mode === 'body') {
      const held = { req, res, closed: false };
      heldRead = held;
      res.on('close', () => { held.closed = true; });
      if (readPlan.mode === 'body') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.flushHeaders();
      }
      return;
    }
    return json(res, readPlan.value, readPlan.status);
  }
  if (url.pathname === '/api/auth/settings' && req.method === 'POST') {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const parsed = JSON.parse(body);
      posts.push(parsed);
      Object.assign(stored, parsed);
      if (Object.hasOwn(parsed, 'keybinds')) stored.keybinds = structuredClone(parsed.keybinds);
      json(res, { ok: true });
    });
    return;
  }
  if (url.pathname === '/api/model-endpoints') return json(res, []);
  if (url.pathname === '/api/models') return json(res, { items: [] });
  if (url.pathname === '/api/sessions') return json(res, []);
  if (url.pathname === '/api/presets') return json(res, { custom_revision: 0, custom_save_revision_guard: false, custom_template_autosave: false, presets: [] });
  if (url.pathname === '/api/presets/templates') return json(res, []);
  if (url.pathname === '/api/default-chat') return json(res, {});
  if (url.pathname === '/api/usage') return json(res, { totals: {}, daily: [], models: [], recent_sessions: [], insights: {} });
  if (url.pathname.startsWith('/api/')) return json(res, {});

  const relative = decodeURIComponent(url.pathname.replace(/^\/static\//, ''));
  const staticRoot = path.resolve(repo, 'static');
  const file = path.resolve(staticRoot, relative);
  if (!file.startsWith(staticRoot + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404); return res.end('fixture not found');
  }
  const ext = path.extname(file);
  const mime = ({ '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2', '.json': 'application/json' })[ext] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
});

const waitFor = async (fn, label, timeout = 10000) => {
  const started = Date.now();
  while (!(await fn())) {
    if (Date.now() - started > timeout) throw new Error(`Timed out waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};

async function openSettings(browser, origin, { clock = false } = {}) {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  await context.addInitScript(() => {
    const nativeFetch = window.fetch.bind(window);
    window.fetch = function(input, init) {
      const url = typeof input === 'string' ? input : input.url;
      if (!url.includes('/api/auth/settings') || (init && init.method === 'POST')) return nativeFetch(input, init);
      const stack = new Error().stack || '';
      const caller = ['initShortcuts', 'initUtilityModel', 'initVisionSettings', 'initResearchSettings', 'initResearchSearchSettings', 'initDefaultChat'].find(name => stack.includes(`at ${name} (`)) || 'other';
      const headers = new Headers(init && init.headers || {});
      headers.set('X-Fixture-Caller', caller);
      if (caller === 'initShortcuts' && init?.signal) {
        window.__shortcutReadSignal = init.signal;
        init.signal.addEventListener('abort', () => { window.__shortcutReadAborted = true; });
      }
      return nativeFetch(input, { ...(init || {}), headers });
    };
  });
  await context.route('**/*', route => {
    const u = new URL(route.request().url());
    if (u.origin !== origin) { externalRequests.push(`${route.request().method()} ${u.href}`); return route.abort(); }
    return route.continue();
  });
  const page = await context.newPage();
  if (clock) await page.clock.install();
  page.on('pageerror', error => pageErrors.push(error.stack || error.message));
  await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.waitForFunction(() => window._isAdmin === true, null, { timeout: 15000 });
  await page.locator('#user-bar-settings').click();
  await page.locator('#settings-modal:not(.hidden)').waitFor({ state: 'visible', timeout: 15000 });
  await page.locator('[data-settings-tab="shortcuts"]').click();
  await waitFor(() => requests.some(r => r.caller === 'initShortcuts'), 'Shortcuts settings read');
  return { page, context };
}

const readStatus = page => page.locator('#shortcuts-list').innerText();
const rowCount = page => page.locator('#shortcuts-list .shortcut-row').count();
const reset = page => page.locator('#shortcuts-reset-btn');

async function openCase(browser, origin, plan, { clock = false } = {}) {
  readPlan = plan;
  heldRead = undefined;
  stored = { keybinds: structuredClone(seeded) };
  posts.length = 0;
  const { page, context } = await openSettings(browser, origin, { clock });
  return { page, context };
}

async function failClosed(browser, origin, label, value, status = 200) {
  requests.length = 0;
  const { page, context } = await openCase(browser, origin, { mode: 'immediate', value, status });
  const text = await readStatus(page);
  assert.match(text, /Could not load saved shortcuts/);
  assert.equal(await rowCount(page), 0, `${label}: no default-based writable rows`);
  assert.equal(await reset(page).isDisabled(), true, `${label}: Reset remains disabled`);
  await reset(page).evaluate(button => button.click());
  await page.waitForTimeout(50);
  assert.equal(posts.length, 0, `${label}: no POST after failed read`);
  results[label] = { statusText: text, rows: 0, resetDisabled: true, posts: posts.length };
  await context.close();
}

async function rebind(page) {
  const row = page.locator('#shortcuts-list .shortcut-row[data-action="new_session"]');
  await row.locator('.shortcut-key').click();
  await page.keyboard.press('Control+Alt+Shift+9');
  await row.locator('.shortcut-action-btn:visible').click();
  await waitFor(() => posts.length === 1, 'accepted synthetic settings POST');
  await page.waitForFunction(() => document.querySelector('#toast')?.classList.contains('show') && document.querySelector('#toast')?.textContent.includes('Shortcut saved'), null, { timeout: 10000 });
}

(async () => {
  let browser;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || '/opt/google/chrome/chrome', args: ['--no-sandbox', '--disable-gpu', '--disable-service-worker'] });

    requests.length = 0;
    await failClosed(browser, origin, 'http503', { detail: 'synthetic unavailable' }, 503);
    const failedRequests = requests.filter(r => r.caller === 'initShortcuts');
    assert.equal(failedRequests.length, 1);
    assert.equal(failedRequests[0].status, 503);

    await failClosed(browser, origin, 'arrayKeybindMap', { keybinds: [] });
    await failClosed(browser, origin, 'nullKeybindMap', { keybinds: null });
    await failClosed(browser, origin, 'nullSettings', null);

    for (const mode of ['headers', 'body']) {
      requests.length = 0;
      const { page, context } = await openCase(browser, origin, { mode }, { clock: true });
      await waitFor(() => heldRead && heldRead.res.headersSent === (mode === 'body'), `${mode} held settings read`);
      assert.equal(await page.locator('#shortcuts-list .shortcut-row').count(), 0);
      await page.clock.fastForward(15001);
      await page.waitForFunction(() => document.querySelector('#shortcuts-list')?.textContent.includes('Could not load saved shortcuts'), null, { timeout: 5000 });
      await waitFor(() => page.evaluate(() => window.__shortcutReadAborted === true), `${mode} request AbortSignal`);
      await waitFor(() => heldRead.closed, `${mode} response connection close`);
      assert.equal(await rowCount(page), 0);
      assert.equal(await reset(page).isDisabled(), true);
      await reset(page).evaluate(button => button.click());
      await page.waitForTimeout(50);
      assert.equal(posts.length, 0);
      results[`${mode}Timeout`] = { aborted: await page.evaluate(() => window.__shortcutReadAborted === true), responseClosed: heldRead.closed, rows: 0, resetDisabled: true, posts: posts.length };
      await context.close();
    }

    for (const validValue of [{}, { keybinds: {} }, { keybinds: seeded }]) {
      requests.length = 0;
      const caseName = !Object.hasOwn(validValue, 'keybinds') ? 'missingMapUsable' : Object.keys(validValue.keybinds || {}).length === 0 ? 'emptyMapUsable' : 'normalCustomMap';
      const { page, context } = await openCase(browser, origin, { mode: 'immediate', value: validValue });
      await page.locator('#shortcuts-list .shortcut-row[data-action="new_session"]').waitFor({ state: 'visible', timeout: 10000 });
      assert.equal(await reset(page).isDisabled(), false, `${caseName}: Reset enabled after valid read`);
      if (caseName === 'normalCustomMap') {
        await rebind(page);
        const map = posts[0].keybinds;
        assert.equal(map.search, seeded.search);
        assert.equal(map.focus_input, seeded.focus_input);
        assert.equal(map.plugin_action, seeded.plugin_action);
        assert.equal(map.toggle_sidebar, 'ctrl+alt+b', 'legacy ctrl+b migration preserved');
        assert.equal(map.new_session, 'ctrl+alt+shift+9');
        assert.deepEqual(stored.keybinds, map);
        await reset(page).click();
        await waitFor(() => posts.length === 2, 'intentional Reset settings POST');
        assert.equal(posts[1].keybinds.search, 'ctrl+k');
        assert.equal(posts[1].keybinds.new_session, 'ctrl+alt+n');
      } else {
        await rebind(page);
        assert.equal(posts.length, 1, `${caseName}: valid legacy map supports edits`);
        assert.equal(posts[0].keybinds.new_session, 'ctrl+alt+shift+9');
      }
      results[caseName] = { resetEnabled: true, postCount: posts.length, keybinds: posts[0].keybinds };
      await context.close();
    }

    requests.length = 0;
    const { page: clockPage, context: clockContext } = await openCase(browser, origin, { mode: 'immediate', value: { keybinds: seeded } }, { clock: true });
    await clockPage.clock.fastForward(15001);
    assert.equal(await clockPage.evaluate(() => window.__shortcutReadAborted === true), false, 'completed settings read clears deadline timer');
    const rowsAfterDeadline = await rowCount(clockPage);
    assert.ok(rowsAfterDeadline > 0, 'completed read stays rendered');
    results.successTimerCleanup = { aborted: false, rows: rowsAfterDeadline };
    await clockContext.close();

    assert.deepEqual(externalRequests, [], `unexpected external requests: ${externalRequests.join(', ')}`);
    assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join('\n')}`);
    const result = {
      pass: true,
      sourceCommit: '103db1a814021822db200f993aaf68079eabf11c',
      sourceHashes,
      adminFixture: 'synthetic only',
      externalRequests,
      pageErrors,
      results,
      cleanup: { browserClosed: true, serverClosed: true },
      scope: 'Actual full-app Settings UI over loopback. Synthetic admin and keybind maps only; no live settings/accounts or OS keyboard input.'
    };
    const output = JSON.stringify(result, null, 2) + '\n';
    if (process.env.RESULT_PATH) fs.writeFileSync(process.env.RESULT_PATH, output, { mode: 0o600 });
    console.log(output);
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server.listening) {
      server.closeAllConnections?.();
      await new Promise(resolve => server.close(resolve));
    }
  }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
