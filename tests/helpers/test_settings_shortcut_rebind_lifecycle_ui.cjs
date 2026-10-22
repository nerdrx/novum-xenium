const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || '/run/media/nerdrx/Lex/novum-xenium/node_modules/playwright');

const repo = path.resolve(process.env.SOURCE_ROOT || path.join(__dirname, '../..'));
const sourceFiles = ['static/index.html', 'static/js/settings.js', 'static/js/settings/api.js', 'static/js/settings/registry.js', 'static/js/keyboard-shortcuts.js', 'static/js/ui.js'];
const sourceHashes = Object.fromEntries(sourceFiles.map(name => [name, crypto.createHash('sha256').update(fs.readFileSync(path.join(repo, name))).digest('hex')]));
const requests = [];
const posts = [];
const heldPostResponses = [];
let heldPostIndexes = new Set();
const externalRequests = [];
const pageErrors = [];
const results = {};
const seeded = { search: 'ctrl+shift+u', focus_input: 'alt+shift+q', plugin_action: 'ctrl+shift+j', toggle_sidebar: 'ctrl+b' };
let readPlan = { mode: 'success', value: { keybinds: seeded }, status: 200 };
let postPlan = { status: 200 };
let stored = { keybinds: structuredClone(seeded) };
let heldRead;
const notificationLogs = [];

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
      const postIndex = posts.length;
      posts.push({ body: parsed, status: postPlan.status });
      if (postPlan.status >= 200 && postPlan.status < 300) {
        Object.assign(stored, parsed);
        if (Object.hasOwn(parsed, 'keybinds')) stored.keybinds = structuredClone(parsed.keybinds);
      }
      if (heldPostIndexes.has(postIndex)) {
        heldPostResponses[postIndex] = res;
        return;
      }
      json(res, { ok: postPlan.status >= 200 && postPlan.status < 300 }, postPlan.status);
    });
    return;
  }
  if (url.pathname === '/api/tasks/notification-logs' && req.method === 'POST') {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => { notificationLogs.push(JSON.parse(body)); json(res, { ok: true }); });
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
      if (!url.includes('/api/auth/settings')) return nativeFetch(input, init);
      const stack = new Error().stack || '';
      const caller = ['initShortcuts', 'initUtilityModel', 'initVisionSettings', 'initResearchSettings', 'initResearchSearchSettings', 'initDefaultChat'].find(name => stack.includes(`at ${name} (`)) || 'other';
      if (url.includes('/api/auth/settings') && init?.method === 'POST') {
        window.__shortcutPostCalls ||= [];
        window.__shortcutPostCalls.push(JSON.parse(init.body).keybinds);
        return nativeFetch(input, init);
      }
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
  heldPostIndexes = new Set();
  heldPostResponses.length = 0;
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

async function rebind(page, action, combo, postIndex, toastText) {
  const row = page.locator(`#shortcuts-list .shortcut-row[data-action="${action}"]`);
  await row.locator('.shortcut-key').click();
  await page.keyboard.press(combo);
  await row.locator('.shortcut-action-btn:visible').click();
  await waitFor(() => posts.length === postIndex + 1, `settings POST ${postIndex + 1}`);
  await page.waitForFunction(text => document.querySelector('#toast')?.textContent.includes(text), toastText, { timeout: 10000 });
}

function releasePost(postIndex, status = posts[postIndex].status) {
  const response = heldPostResponses[postIndex];
  assert.ok(response, `settings POST ${postIndex} is held`);
  heldPostResponses[postIndex] = null;
  json(response, { ok: status >= 200 && status < 300 }, status);
}

(async () => {
  let browser;
  let contexts = [];
  const observations = {};
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || '/opt/google/chrome/chrome', args: ['--no-sandbox', '--disable-gpu', '--disable-service-worker'] });

    // No-capture control: ordinary typing reaches the chat composer.
    let opened = await openCase(browser, origin, { mode: 'success', value: { keybinds: seeded }, status: 200 });
    contexts.push(opened.context);
    const normalMessage = opened.page.locator('#message');
    await normalMessage.focus();
    await opened.page.keyboard.type('n');
    observations.normalControl = { composerValue: await normalMessage.inputValue() };
    assert.equal(observations.normalControl.composerValue, 'n');
    await opened.context.close(); contexts = contexts.filter(c => c !== opened.context);

    async function observeKey(page, key) {
      await page.evaluate(k => {
        document.addEventListener('keydown', event => {
          if (event.key.toLowerCase() === k.toLowerCase()) (window.__shortcutLifecycleKeys ||= []).push({ key: event.key, defaultPrevented: event.defaultPrevented });
        }, true);
      }, key);
    }
    async function beginRebind(page, action) {
      const row = page.locator(`#shortcuts-list .shortcut-row[data-action="${action}"]`);
      await row.locator('.shortcut-key').click();
      await row.locator('.shortcut-key.listening').waitFor({ state: 'attached' });
      return row;
    }
    async function typeChatAfterClose(page, char, label) {
      const input = page.locator('#message');
      await input.fill('');
      await input.focus();
      await observeKey(page, char);
      await page.keyboard.press(char.toUpperCase());
      const value = await input.inputValue();
      const events = await page.evaluate(() => window.__shortcutLifecycleKeys || []);
      const event = events.at(-1);
      observations[label] = { composerValue: value, observedDefaultPrevented: event?.defaultPrevented ?? null };
      return { value, prevented: event?.defaultPrevented };
    }

    // Close/reopen path: closing Settings cancels capture before chat typing.
    opened = await openCase(browser, origin, { mode: 'success', value: { keybinds: seeded }, status: 200 });
    contexts.push(opened.context);
    await beginRebind(opened.page, 'open_library');
    await opened.page.locator('#settings-modal .close-btn').click();
    await opened.page.locator('#settings-modal.hidden').waitFor({ state: 'attached' });
    let outcome = await typeChatAfterClose(opened.page, 'x', 'closeButtonBeforeReopen');
    assert.equal(outcome.value, 'X', 'chat typing works after close-button dismissal');
    assert.equal(outcome.prevented, false, 'close removed the capture listener');
    await opened.page.locator('#user-bar-settings').click();
    await opened.page.locator('#settings-modal:not(.hidden)').waitFor({ state: 'visible' });
    observations.closeReopen = {
      rowStillListening: await opened.page.locator('#shortcuts-list .shortcut-row[data-action="open_library"] .shortcut-key').evaluate(button => button.classList.contains('listening')),
      keyText: await opened.page.locator('#shortcuts-list .shortcut-row[data-action="open_library"] .shortcut-key').innerText(),
    };
    assert.equal(observations.closeReopen.rowStillListening, false);
    assert.equal(observations.closeReopen.keyText, 'Set', 'cancelled preview returns to the saved unbound state');
    await beginRebind(opened.page, 'open_library');
    await opened.page.keyboard.press('Escape');
    observations.escapeCleanup = {
      rowListening: await opened.page.locator('#shortcuts-list .shortcut-row[data-action="open_library"] .shortcut-key').evaluate(button => button.classList.contains('listening')),
      keyText: await opened.page.locator('#shortcuts-list .shortcut-row[data-action="open_library"] .shortcut-key').innerText(),
    };
    assert.equal(observations.escapeCleanup.rowListening, false);
    assert.equal(observations.escapeCleanup.keyText, 'Set');
    await opened.page.locator('#settings-modal.hidden').waitFor({ state: 'attached' });
    outcome = await typeChatAfterClose(opened.page, 'q', 'closeReopen');
    assert.equal(outcome.value, 'Q', 'typing works after Escape cancels rebind');
    assert.equal(outcome.prevented, false);
    assert.equal(posts.length, 0, 'close and Escape cancellation do not save a preview');
    await opened.context.close(); contexts = contexts.filter(c => c !== opened.context);

    // Tab path: switching panels cancels capture so Appearance actions work.
    opened = await openCase(browser, origin, { mode: 'success', value: { keybinds: seeded }, status: 200 });
    contexts.push(opened.context);
    await beginRebind(opened.page, 'open_library');
    await opened.page.locator('[data-settings-tab="appearance"]').click();
    observations.tabSwitchRowListening = await opened.page.locator('#shortcuts-list .shortcut-row[data-action="open_library"] .shortcut-key').evaluate(button => button.classList.contains('listening'));
    assert.equal(observations.tabSwitchRowListening, false);
    const resetAppearance = opened.page.locator('[data-settings-panel="appearance"] [data-vis-reset]').first();
    await resetAppearance.waitFor({ state: 'visible' });
    await resetAppearance.focus();
    await resetAppearance.evaluate(button => {
      button.dataset.shortcutTestClicks = '0';
      button.addEventListener('click', () => { button.dataset.shortcutTestClicks = String(Number(button.dataset.shortcutTestClicks) + 1); });
    });
    await observeKey(opened.page, 'Enter');
    await opened.page.keyboard.press('Enter');
    const blockedClicks = Number(await resetAppearance.getAttribute('data-shortcut-test-clicks'));
    const tabKey = await opened.page.evaluate(() => (window.__shortcutLifecycleKeys || []).at(-1));
    observations.tabSwitch = { blockedClicks, observedDefaultPrevented: tabKey?.defaultPrevented ?? null };
    assert.equal(blockedClicks, 1, 'Enter activates the visible Appearance action after cancellation');
    assert.equal(tabKey?.defaultPrevented, false);
    assert.equal(posts.length, 0, 'tab cancellation does not save a preview');
    await opened.context.close(); contexts = contexts.filter(c => c !== opened.context);

    // Starting B cancels A's capture owner before registering B.
    posts.length = 0;
    opened = await openCase(browser, origin, { mode: 'success', value: { keybinds: seeded }, status: 200 });
    contexts.push(opened.context);
    const rowA = await beginRebind(opened.page, 'open_library');
    const rowB = await beginRebind(opened.page, 'open_skills');
    observations.secondRebindVisual = {
      rowAListening: await rowA.locator('.shortcut-key').evaluate(button => button.classList.contains('listening')),
      rowBListening: await rowB.locator('.shortcut-key').evaluate(button => button.classList.contains('listening')),
    };
    assert.deepEqual(observations.secondRebindVisual, { rowAListening: false, rowBListening: true });
    await opened.page.keyboard.press('Control+Alt+Shift+6');
    await opened.page.keyboard.press('Enter');
    await waitFor(() => posts.length >= 1, 'first rebind POST');
    await new Promise(resolve => setTimeout(resolve, 250));
    observations.rebindAThenB = {
      postCount: posts.length,
      combos: posts.map(post => ({ library: post.body.keybinds.open_library, skills: post.body.keybinds.open_skills })),
      liveMap: await opened.page.evaluate(() => ({ library: window._odysseusKeybinds.open_library, skills: window._odysseusKeybinds.open_skills })),
    };
    assert.equal(posts.length, 1, 'only new B capture commits on Enter');
    assert.deepEqual(observations.rebindAThenB.combos, [
      { library: '', skills: 'ctrl+alt+shift+6' },
    ]);
    assert.deepEqual(observations.rebindAThenB.liveMap, { library: '', skills: 'ctrl+alt+shift+6' });
    await opened.context.close(); contexts = contexts.filter(c => c !== opened.context);

    assert.deepEqual(externalRequests, [], `unexpected external requests: ${externalRequests.join(', ')}`);
    assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join('\n')}`);
    const result = {
      pass: true,
      sourceCommit: '7a67291b365c7a63bdca7535417a54759125bae3',
      sourceHashes,
      observations,
      requests: requests.map(({ method, caller, status }) => ({ method, caller, status })),
      posts: posts.map(({ body, status }) => ({ status, keybinds: body.keybinds })),
      externalRequests, pageErrors,
      scope: 'Actual full-app Settings UI on isolated source over synthetic loopback APIs; no live settings/accounts, no OS keyboard input.',
      cleanup: { browserClosed: false, contextsClosed: contexts.length === 0, serverClosed: false },
    };
    if (browser) { await browser.close(); browser = null; }
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
    result.cleanup = { browserClosed: true, contextsClosed: contexts.length === 0, serverClosed: true };
    const output = JSON.stringify(result, null, 2) + '\n';
    if (process.env.RESULT_PATH) fs.writeFileSync(process.env.RESULT_PATH, output, { mode: 0o600 });
    console.log(output);
  } finally {
    for (const context of contexts) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    if (server.listening) { server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); }
  }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
