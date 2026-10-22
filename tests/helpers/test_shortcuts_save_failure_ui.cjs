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
        return nativeFetch(input, init).then(response => {
          window.__shortcutPostResponses = (window.__shortcutPostResponses || 0) + 1;
          return response;
        });
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
  let context;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || '/opt/google/chrome/chrome', args: ['--no-sandbox', '--disable-gpu', '--disable-service-worker'] });
    requests.length = 0; posts.length = 0; notificationLogs.length = 0; postPlan = { status: 200 };
    const opened = await openCase(browser, origin, { mode: 'success', value: { keybinds: seeded }, status: 200 });
    const page = opened.page; context = opened.context;

    // Accepted save establishes window._odysseusKeybinds from the closure map.
    await rebind(page, 'new_session', 'Control+Alt+Shift+9', 0, 'Shortcut saved');
    assert.equal(posts[0].status, 200);
    assert.equal(posts[0].body.keybinds.new_session, 'ctrl+alt+shift+9');
    assert.equal(await page.evaluate(() => window._odysseusKeybinds.new_session), 'ctrl+alt+shift+9');
    let acceptedMap = structuredClone(stored.keybinds);

    // Fail a different default row, avoiding a custom row's prior reset listener.
    postPlan = { status: 500 };
    await rebind(page, 'fav_session', 'Control+Alt+Shift+8', 1, 'Failed to save shortcut');
    assert.equal(posts.length, 2, 'one rebind confirmation must issue one POST');
    assert.equal(posts[1].status, 500);
    const liveAfter500 = await page.evaluate(() => ({ ...window._odysseusKeybinds }));
    assert.equal(liveAfter500.fav_session, acceptedMap.fav_session, 'failed 500 keeps the effective map at its last accepted snapshot');
    assert.equal(liveAfter500.fav_session, 'ctrl+alt+f');
    assert.equal(stored.keybinds.fav_session, seeded.fav_session || 'ctrl+alt+f');
    assert.deepEqual(stored.keybinds, acceptedMap, 'failed HTTP 500 must not update persisted fixture state');
    const failedFavDraft = await page.locator('#shortcuts-list .shortcut-row[data-action="fav_session"] .shortcut-key').innerText();
    assert.match(failedFavDraft, /8/, 'failed rebind remains visible as an editable local draft');
    postPlan = { status: 200 };
    await rebind(page, 'fav_session', 'Control+Alt+Shift+8', 2, 'Shortcut saved');
    assert.equal(posts[2].status, 200, 'explicit retry can save the retained draft');
    acceptedMap = structuredClone(stored.keybinds);

    postPlan = { status: 403 };
    await rebind(page, 'cancel', 'Control+Alt+Shift+7', 3, 'Admin access is required to change these settings.');
    assert.equal(posts.length, 4, 'one 403 rebind confirmation must issue one POST');
    assert.equal(posts[3].status, 403);
    const liveAfter403 = await page.evaluate(() => ({ ...window._odysseusKeybinds }));
    assert.equal(liveAfter403.cancel, acceptedMap.cancel, 'failed 403 keeps the effective map at its last accepted snapshot');
    assert.equal(liveAfter403.cancel, 'escape');
    assert.deepEqual(stored.keybinds, acceptedMap, 'failed HTTP 403 must not update persisted fixture state');
    await waitFor(() => notificationLogs.some(entry => entry.status === 'error') && notificationLogs.filter(entry => entry.body === 'Failed to save shortcut').every(entry => entry.status === 'error'), '403 and failed-save notification entries');
    const notificationsAfter403 = notificationLogs.map(entry => ({ status: entry.status, body: entry.body }));

    postPlan = { status: 500 };
    await reset(page).click();
    await waitFor(() => posts.length === 5, 'failed Reset POST');
    assert.equal(posts[4].status, 500);
    await page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('Failed to save shortcut'), null, { timeout: 10000 });
    await waitFor(() => notificationLogs.some(entry => entry.status === 'error' && entry.body === 'Failed to save shortcut'), 'Reset failure notification');
    assert.deepEqual(stored.keybinds, acceptedMap, 'failed Reset must not update persisted fixture state');
    const resetFinalToast = await page.locator('#toast').innerText();
    const liveAfterReset500 = await page.evaluate(() => ({ ...window._odysseusKeybinds }));
    assert.match(resetFinalToast, /Failed to save shortcut/);
    assert.doesNotMatch(notificationLogs.map(entry => entry.body).join('\n'), /Shortcuts reset to defaults/);
    assert.deepEqual(liveAfterReset500, acceptedMap, 'failed Reset leaves the effective keybind map unchanged');

    // Reset can be retried explicitly; successful persistence updates both maps.
    postPlan = { status: 200 };
    await reset(page).click();
    await waitFor(() => posts.length === 6, 'explicit Reset retry POST');
    await page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('Shortcuts reset to defaults'), null, { timeout: 10000 });
    assert.equal(posts[5].status, 200);
    assert.deepEqual(stored.keybinds, posts[5].body.keybinds);
    const resetRetryMap = await page.evaluate(() => ({ ...window._odysseusKeybinds }));
    assert.equal(resetRetryMap.new_session, 'ctrl+alt+n');

    // A newer success owns the effective map and the older Reset completion
    // must not repaint or claim that Reset succeeded.
    await context.close(); context = null;
    notificationLogs.length = 0;
    const heldOpen = await openCase(browser, origin, { mode: 'success', value: { keybinds: seeded }, status: 200 });
    const heldPage = heldOpen.page; context = heldOpen.context;
    heldPostIndexes = new Set([0, 1]);
    postPlan = { status: 200 };
    await reset(heldPage).click();
    await waitFor(() => posts.length === 1 && heldPostResponses[0], 'held older Reset save');
    const submittedFirst = structuredClone(posts[0].body.keybinds);
    const favRow = heldPage.locator('#shortcuts-list .shortcut-row[data-action="fav_session"]');
    await favRow.locator('.shortcut-key').click();
    await heldPage.keyboard.press('Control+Alt+Shift+8');
    await favRow.locator('.shortcut-action-btn:visible').click();
    await waitFor(() => posts.length === 2 && heldPostResponses[1], 'held newer shortcut save');
    const submittedSecond = structuredClone(posts[1].body.keybinds);
    assert.notDeepEqual(submittedFirst, submittedSecond, 'later edit has a distinct submitted snapshot');
    releasePost(1);
    await waitFor(() => notificationLogs.filter(entry => entry.body === 'Shortcut saved').length === 1, 'newer held save acknowledgement');
    const publishedSecond = await heldPage.evaluate(() => ({ ...window._odysseusKeybinds }));
    assert.deepEqual(publishedSecond, submittedSecond);
    releasePost(0);
    await waitFor(() => heldPage.evaluate(() => window.__shortcutPostResponses >= 2), 'both held fetch responses reached the page');
    await heldPage.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const publishedFirst = await heldPage.evaluate(() => ({ ...window._odysseusKeybinds }));
    assert.deepEqual(publishedFirst, submittedSecond, 'older success cannot replace a newer accepted map');
    assert.doesNotMatch(notificationLogs.map(entry => entry.body).join('\n'), /Shortcuts reset to defaults/, 'stale Reset completion cannot show success');
    assert.deepEqual(stored.keybinds, submittedSecond);
    const finalPublished = publishedFirst;
    await context.close(); context = null;

    // A newer failed request does not block an older successful response from
    // becoming the last accepted effective map.
    notificationLogs.length = 0;
    const failureRaceOpen = await openCase(browser, origin, { mode: 'success', value: { keybinds: seeded }, status: 200 });
    const failureRacePage = failureRaceOpen.page; context = failureRaceOpen.context;
    heldPostIndexes = new Set([0, 1]);
    postPlan = { status: 200 };
    const olderRow = failureRacePage.locator('#shortcuts-list .shortcut-row[data-action="new_session"]');
    await olderRow.locator('.shortcut-key').click();
    await failureRacePage.keyboard.press('Control+Alt+Shift+9');
    await olderRow.locator('.shortcut-action-btn:visible').click();
    await waitFor(() => posts.length === 1 && heldPostResponses[0], 'older successful rebind request held');
    const olderSuccessfulSnapshot = structuredClone(posts[0].body.keybinds);
    postPlan = { status: 500 };
    const failureRaceRow = failureRacePage.locator('#shortcuts-list .shortcut-row[data-action="cancel"]');
    await failureRaceRow.locator('.shortcut-key').click();
    await failureRacePage.keyboard.press('Control+Alt+Shift+7');
    await failureRaceRow.locator('.shortcut-action-btn:visible').click();
    await waitFor(() => posts.length === 2 && heldPostResponses[1], 'newer failing rebind request held');
    releasePost(1);
    await waitFor(() => notificationLogs.some(entry => entry.status === 'error' && entry.body === 'Failed to save shortcut'), 'newer failed-save notification');
    await waitFor(() => failureRacePage.evaluate(() => window.__shortcutPostResponses >= 1), 'newer failed response reached the page');
    const effectiveBeforeOlderSuccess = await failureRacePage.evaluate(() => ({ ...window._odysseusKeybinds }));
    releasePost(0);
    await waitFor(() => notificationLogs.some(entry => entry.status === 'success' && entry.body === 'Shortcut saved'), 'older successful-save notification');
    await waitFor(() => failureRacePage.evaluate(() => window.__shortcutPostResponses >= 2), 'older successful response reached the page');
    await failureRacePage.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const effectiveAfterOlderSuccess = await failureRacePage.evaluate(() => ({ ...window._odysseusKeybinds }));
    assert.notDeepEqual(effectiveBeforeOlderSuccess, olderSuccessfulSnapshot, 'newer failure leaves old accepted map active while older success is pending');
    assert.deepEqual(effectiveAfterOlderSuccess, olderSuccessfulSnapshot, 'older success applies because newer request failed and no newer success was accepted');
    assert.deepEqual(stored.keybinds, olderSuccessfulSnapshot);
    const failedNewerThenOlderSuccess = { olderSuccessfulSnapshot, effectiveBeforeOlderSuccess, effectiveAfterOlderSuccess, notifications: notificationLogs.map(entry => ({ status: entry.status, body: entry.body })) };
    await context.close(); context = null;

    // A row already marked custom must have only its Confirm action after
    // startRebind changes the button state.
    postPlan = { status: 200 };
    notificationLogs.length = 0;
    const customOpen = await openCase(browser, origin, { mode: 'success', value: { keybinds: seeded }, status: 200 });
    const customPage = customOpen.page; context = customOpen.context;
    const searchRow = customPage.locator('#shortcuts-list .shortcut-row[data-action="search"]');
    await searchRow.locator('.shortcut-key').click();
    await customPage.keyboard.press('Control+Alt+Shift+6');
    await searchRow.locator('.shortcut-action-btn:visible').click();
    const clientPostCount = await customPage.evaluate(() => window.__shortcutPostCalls?.length || 0);
    await waitFor(() => posts.length === clientPostCount, `all ${clientPostCount} custom-row POSTs received by fixture`);
    await waitFor(() => notificationLogs.filter(entry => entry.body === 'Shortcut saved').length === clientPostCount, 'custom-row save feedback');
    assert.equal(clientPostCount, 1, 'custom-row confirmation issues exactly one POST');
    const customRowCase = {
      postCount: clientPostCount,
      posts: posts.map(({ body, status }) => ({ status, search: body.keybinds.search })),
      finalLiveSearch: await customPage.evaluate(() => window._odysseusKeybinds.search),
      finalPersistedSearch: stored.keybinds.search,
    };
    await context.close(); context = null;

    assert.deepEqual(externalRequests, [], `unexpected external requests: ${externalRequests.join(', ')}`);
    assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join('\n')}`);
    const result = {
      pass: true, sourceCommit: '7a67291b365c7a63bdca7535417a54759125bae3', productParent: '08415d336c01a1130fe7d48247586ca9507650ca', sourceHashes,
      syntheticOnly: true,
      normalSuccessControl: { status: 200, liveBinding: 'ctrl+alt+shift+9', persistedBinding: acceptedMap.new_session },
      failedRebind500: { status: 500, liveBinding: liveAfter500.fav_session, persistedBinding: stored.keybinds.fav_session },
      failedRebind403: { status: 403, liveBinding: liveAfter403.cancel, persistedBinding: stored.keybinds.cancel, notificationLogs: notificationsAfter403 },
      failedWholeReset500: { status: 500, finalToast: resetFinalToast, persistedMapUnchanged: true, effectiveMapUnchanged: true },
      successfulResetRetry: { status: 200, liveMap: resetRetryMap },
      heldAcknowledgementSnapshots: { submittedOlderReset: submittedFirst, submittedNewerEdit: submittedSecond, publishedAfterNewer: publishedSecond, publishedAfterOlder: finalPublished, staleResetSuccessToast: false },
      failedNewerThenOlderSuccess,
      customRowRebind: customRowCase,
      posts: posts.map(({ body, status }) => ({ status, keybinds: body.keybinds })), notificationLogs, externalRequests, pageErrors,
      cleanup: { browserClosed: false, contextClosed: false, serverClosed: false },
      scope: 'Actual full-app Settings UI over loopback. Synthetic admin, settings map, POST statuses, and notification sink only; no live accounts/settings or OS keyboard input.'
    };
    if (context) { await context.close(); context = null; }
    if (browser) { await browser.close(); browser = null; }
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
    result.cleanup = { browserClosed: true, contextClosed: true, serverClosed: true };
    const output = JSON.stringify(result, null, 2) + '\n';
    if (process.env.RESULT_PATH) require('node:fs').writeFileSync(process.env.RESULT_PATH, output, { mode: 0o600 });
    console.log(output);
  } finally {
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    if (server.listening) { server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); }
  }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
