const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

const repo = path.resolve(__dirname, '../..');
const staticRoot = path.join(repo, 'static');
const groupPath = path.join(staticRoot, 'js/group.js');
const originalGroup = fs.readFileSync(groupPath, 'utf8');
const startCall = "await startGroup(picked, 'group-' + Date.now());";
assert.equal(originalGroup.split(startCall).length - 1, 1, 'fixture seam must remain unique');
const servedGroup = originalGroup.replace(startCall, 'await globalThis.__mockStartGroup(picked);');
const sourceHash = crypto.createHash('sha256').update(originalGroup).digest('hex');

const initialGroups = [
  { id: 'fixture-a', name: 'Synthetic A', participants: [] },
  { id: 'fixture-b', name: 'Synthetic B', participants: [] },
];
let savedGroups = structuredClone(initialGroups);
let getCount = 0;
let postBodies = [];
let holdNextGet = '';
let heldGetCount = 0;
let heldGetBodyCount = 0;
let releaseHeldGet = null;
let failNextGet = false;
let holdNextPost = false;
let releaseHeldPost = null;
let browser;
let server;
let origin;
const externalRequests = [];
const pageErrors = [];
let sessionRequests = 0;

const html = `<!doctype html><meta charset="utf-8">
<div id="custom-preset-modal"><div class="preset-tab active" data-chartab="group">Group</div><div id="group-participants"><span>Ready</span></div><button id="group-add-btn" type="button">Add participant</button></div>
<button id="group-mode-btn" type="button">Mode</button><button id="save-custom-preset" type="button">Start</button>
<textarea id="message"></textarea><div id="chat-history"></div><div class="chat-input-right"><button class="mode-toggle" type="button"></button></div><div id="toast" role="status"></div>
<script type="module">
import group from '/static/js/group.js';
window.modelsModule = { getCachedItems: () => [{
 endpoint_id: 'synthetic-endpoint', endpoint_name: 'Fixture', url: 'http://model.invalid',
 models: ['fixture-a', 'fixture-b'], models_display: ['Fixture A', 'Fixture B']
}] };
window.groupModule = group;
window.__startCalls = [];
window.__mockStartGroup = async picked => { window.__startCalls.push(picked.map(model => model.mid)); };
group.init(location.origin);
window.groupReady = true;
document.querySelector('.preset-tab[data-chartab="group"]').click();
</script>`;

function json(res, value, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(value));
}

function startServer() {
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(html);
    }
    if (url.pathname === '/__hold-next-get') {
      holdNextGet = url.searchParams.get('phase') || 'headers';
      req.resume();
      return json(res, { ok: true });
    }
    if (url.pathname === '/__release-get') {
      releaseHeldGet?.();
      releaseHeldGet = null;
      req.resume();
      return json(res, { ok: true });
    }
    if (url.pathname === '/__hold-next-post') {
      holdNextPost = true;
      req.resume();
      return json(res, { ok: true });
    }
    if (url.pathname === '/__replace-list-and-fail-next-get') {
      savedGroups = [
        { id: 'fixture-b', name: 'Synthetic B', participants: [] },
        { id: 'fixture-c', name: 'Synthetic C', participants: [] },
      ];
      failNextGet = true;
      req.resume();
      return json(res, { ok: true });
    }
    if (url.pathname === '/api/presets/groups' && req.method === 'GET') {
      getCount++;
      const snapshot = structuredClone(savedGroups);
      req.resume();
      if (failNextGet) {
        failNextGet = false;
        return json(res, { detail: 'synthetic unavailable' }, 503);
      }
      if (holdNextGet) {
        const phase = holdNextGet;
        holdNextGet = '';
        heldGetCount++;
        if (phase === 'body') {
          heldGetBodyCount++;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.write('{"groups":');
        }
        let release;
        const released = new Promise(resolve => { release = resolve; });
        releaseHeldGet = release;
        res.once('close', () => {
          release();
          if (releaseHeldGet === release) releaseHeldGet = null;
        });
        await released;
        if (res.destroyed) return;
      }
      return json(res, { groups: snapshot });
    }
    if (url.pathname === '/api/presets/groups' && req.method === 'POST') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const groups = JSON.parse(Buffer.concat(chunks).toString('utf8')).groups;
      postBodies.push(groups.map(group => group.name));
      savedGroups = groups;
      if (holdNextPost) {
        holdNextPost = false;
        let release;
        const released = new Promise(resolve => { release = resolve; });
        releaseHeldPost = release;
        res.once('close', () => {
          release();
          if (releaseHeldPost === release) releaseHeldPost = null;
        });
        await released;
        if (res.destroyed) return;
      }
      return json(res, { ok: true });
    }
    if (url.pathname.startsWith('/api/session')) {
      sessionRequests++;
      return json(res, {});
    }
    if (url.pathname.startsWith('/static/')) {
      const filename = path.resolve(staticRoot, '.' + url.pathname.slice('/static'.length));
      if (!filename.startsWith(staticRoot + path.sep) || !fs.existsSync(filename)) return res.writeHead(404).end();
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
      return res.end(filename === groupPath ? servedGroup : fs.readFileSync(filename));
    }
    if (url.pathname.startsWith('/api/')) return json(res, {});
    res.writeHead(404).end();
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    origin = `http://127.0.0.1:${server.address().port}`;
    resolve();
  }));
}

async function newPage() {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(7000);
  page.on('pageerror', error => pageErrors.push(String(error)));
  await page.route('**/*', route => {
    const requested = new URL(route.request().url());
    if (requested.origin !== origin) {
      externalRequests.push(requested.href);
      return route.abort();
    }
    return route.continue();
  });
  await page.addInitScript(() => {
    window.__groupJsonStarted = 0;
    window.__groupJsonCompleted = 0;
    window.__groupRequestSignals = [];
    window.__groupDeadlineTimers = [];
    const json = Response.prototype.json;
    Response.prototype.json = async function (...args) {
      const isGroupList = this.url.includes('/api/presets/groups');
      if (isGroupList) window.__groupJsonStarted++;
      const data = await json.apply(this, args);
      if (isGroupList) window.__groupJsonCompleted++;
      return data;
    };
    const fetch = window.fetch.bind(window);
    window.fetch = (input, init = {}) => {
      if (String(input).includes('/api/presets/groups')) {
        const signal = init.signal;
        const record = { method: init.method || 'GET', hasAbortSignal: signal instanceof AbortSignal, aborted: false };
        signal?.addEventListener('abort', () => { record.aborted = true; });
        window.__groupRequestSignals.push(record);
      }
      return fetch(input, init);
    };
  });
  await page.goto(origin);
  await page.waitForFunction(() => window.groupReady && window.__groupJsonCompleted === 1);
  await page.waitForFunction(() => document.querySelectorAll('#group-presets-list button').length === 2);
  return { context, page };
}

async function waitFor(predicate, label) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > 9000) throw new Error('timeout waiting for ' + label);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

async function addParticipants(page) {
  for (let index = 0; index < 2; index++) {
    await page.locator('#group-add-btn').click();
    await page.locator('.group-participant-model').waitFor();
    await page.locator('.group-participant-model').selectOption({ index: index + 1 });
  }
  assert.equal(await page.locator('.group-participant-entry').count(), 2);
}

async function installDeadlineObserver(page) {
  await page.clock.install();
  await page.evaluate(() => {
    const set = window.setTimeout;
    const clear = window.clearTimeout;
    const timers = window.__groupDeadlineTimers;
    window.setTimeout = (callback, delay, ...args) => {
      if (delay !== 15000) return set(callback, delay, ...args);
      const item = { fired: false, cleared: false };
      const id = set(() => { item.fired = true; callback(...args); }, delay);
      item.id = id;
      timers.push(item);
      return id;
    };
    window.clearTimeout = id => {
      const item = timers.find(timer => timer.id === id);
      if (item) item.cleared = true;
      return clear(id);
    };
  });
}

async function timeoutCase(phase) {
  savedGroups = structuredClone(initialGroups);
  getCount = 0; postBodies = []; holdNextGet = ''; heldGetCount = 0; heldGetBodyCount = 0; releaseHeldGet = null; failNextGet = false;
  const { context, page } = await newPage();
  try {
    await addParticipants(page);
    await installDeadlineObserver(page);
    await page.request.get(`${origin}/__hold-next-get?phase=${phase}`);
    await page.locator('#save-custom-preset').click();
    await waitFor(() => phase === 'headers' ? heldGetCount === 1 : heldGetBodyCount === 1, `GET held at ${phase}`);
    if (phase === 'body') await page.waitForFunction(() => window.__groupJsonStarted === 2);
    await page.clock.fastForward(15001);
    await page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('preset could not be saved'));
    await waitFor(() => releaseHeldGet === null, 'aborted server request cleanup');
    const observations = await page.evaluate(() => ({ signals: window.__groupRequestSignals, timers: window.__groupDeadlineTimers }));
    const aborted = observations.signals.find(record => record.method === 'GET' && record.aborted);
    assert.ok(aborted?.hasAbortSignal, `${phase}: native AbortSignal is passed and fired`);
    assert.equal(observations.timers.length, 1, `${phase}: one per-request deadline was created`);
    assert.deepEqual({ fired: observations.timers[0].fired, cleared: observations.timers[0].cleared }, { fired: true, cleared: true }, `${phase}: fired deadline is cleared in finally`);
    assert.equal(postBodies.length, 0, `${phase}: expired prewrite read must not POST`);
    await page.locator('#group-presets-list button').first().locator('span').nth(1).dispatchEvent('click');
    await page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('needs to reload'));
    assert.equal(postBodies.length, 0, `${phase}: stale chips cannot write after timeout`);
    await page.locator('.preset-tab[data-chartab="group"]').click();
    await page.waitForFunction(() => window.__groupJsonCompleted >= 2 && document.querySelector('#group-presets-list button span')?.textContent === 'Synthetic A');
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.locator('#group-presets-list button').first().locator('span').nth(1).dispatchEvent('click');
    await waitFor(() => postBodies.length === 1 && savedGroups.length === 1, `${phase}: delete after successful reload`);
    return { phase, abortObserved: true, deadlineFiredAndCleared: true, staleWriteBlocked: true, recoveredAfterReload: true };
  } finally {
    releaseHeldGet?.();
    await context.close().catch(() => {});
  }
}

async function failedReadInvalidatesOldList() {
  savedGroups = structuredClone(initialGroups);
  getCount = 0; postBodies = []; holdNextGet = ''; heldGetCount = 0; heldGetBodyCount = 0; releaseHeldGet = null; failNextGet = false;
  const { context, page } = await newPage();
  try {
    await page.request.get(`${origin}/__hold-next-get?phase=headers`);
    await page.locator('.preset-tab[data-chartab="group"]').click();
    await waitFor(() => heldGetCount === 1, 'old list response held');
    await page.request.get(`${origin}/__replace-list-and-fail-next-get`);
    await addParticipants(page);
    await page.locator('#save-custom-preset').click();
    await page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('preset could not be saved'));
    assert.equal(postBodies.length, 0);
    await page.request.get(`${origin}/__release-get`);
    releaseHeldGet = null;
    await page.waitForFunction(() => window.__groupJsonCompleted >= 2);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.deepEqual(await page.locator('#group-presets-list button span:first-child').allTextContents(), ['Synthetic A', 'Synthetic B'], 'invalidated old response must not repaint');
    await page.locator('#group-presets-list button').first().locator('span').nth(1).dispatchEvent('click');
    await page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('needs to reload'));
    assert.equal(postBodies.length, 0, 'failed autosave GET marks existing chips stale');
    await page.locator('.preset-tab[data-chartab="group"]').click();
    await page.waitForFunction(() => window.__groupJsonCompleted >= 3 && document.querySelectorAll('#group-presets-list button').length === 2);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.deepEqual(await page.locator('#group-presets-list button span:first-child').allTextContents(), ['Synthetic B', 'Synthetic C']);
    await page.locator('#group-presets-list button').first().locator('span').nth(1).dispatchEvent('click');
    await waitFor(() => postBodies.length === 1, 'delete from refreshed list');
    assert.deepEqual(postBodies[0], ['Synthetic C'], 'reloaded fresh snapshot preserves newer server entry');
    return { failedAutosaveGet: true, oldResponseIgnored: true, staleDeleteBlocked: true, reloadRestoredMutations: true };
  } finally {
    releaseHeldGet?.();
    await context.close().catch(() => {});
  }
}

async function deleteAndReconciliationTimeout() {
  savedGroups = structuredClone(initialGroups);
  getCount = 0; postBodies = []; holdNextGet = ''; heldGetCount = 0; heldGetBodyCount = 0; releaseHeldGet = null; failNextGet = false;
  holdNextPost = false; releaseHeldPost = null;
  const { context, page } = await newPage();
  try {
    await installDeadlineObserver(page);
    await page.request.get(`${origin}/__hold-next-post`);
    await page.request.get(`${origin}/__hold-next-get?phase=headers`);
    await page.locator('#group-presets-list button').first().locator('span').nth(1).dispatchEvent('click');
    await waitFor(() => releaseHeldPost !== null && postBodies.length === 1, 'delete POST held after server accepted the write');

    await page.clock.fastForward(15001);
    await waitFor(() => releaseHeldPost === null && heldGetCount === 1, 'timed-out POST starts bounded reconciliation GET');
    await page.clock.fastForward(15001);
    await page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('Reopen the Group tab to reload'));
    await waitFor(() => releaseHeldGet === null, 'timed-out reconciliation GET cleanup');

    const observations = await page.evaluate(() => ({ signals: window.__groupRequestSignals, timers: window.__groupDeadlineTimers }));
    for (const method of ['POST', 'GET']) {
      const request = observations.signals.find(item => item.method === method && item.aborted);
      assert.ok(request?.hasAbortSignal, `${method} timeout aborts its native request signal`);
    }
    assert.equal(observations.timers.length, 2, 'delete and reconciliation each own a deadline');
    assert.deepEqual(observations.timers.map(({ fired, cleared }) => ({ fired, cleared })), [
      { fired: true, cleared: true }, { fired: true, cleared: true },
    ], 'both per-request timers fire and clear through finally');
    assert.deepEqual(postBodies, [['Synthetic B']], 'the accepted but unconfirmed deletion is reconciled, not replayed');

    await page.locator('#group-presets-list button').first().locator('span').nth(1).dispatchEvent('click');
    await page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('needs to reload'));
    assert.equal(postBodies.length, 1, 'stale chips remain non-mutating after both timeouts');
    await page.locator('.preset-tab[data-chartab="group"]').click();
    await page.waitForFunction(() => window.__groupJsonCompleted >= 2 && document.querySelector('#group-presets-list button span')?.textContent === 'Synthetic B');
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.locator('#group-presets-list button').first().locator('span').nth(1).dispatchEvent('click');
    await waitFor(() => postBodies.length === 2 && savedGroups.length === 0, 'delete succeeds after reload and mutation lock release');
    return { deletePostAborted: true, reconciliationGetAborted: true, bothTimersCleared: true, staleBlocked: true, recoveredAfterReload: true };
  } finally {
    releaseHeldGet?.();
    releaseHeldPost?.();
    await context.close().catch(() => {});
  }
}

async function main() {
  await startServer();
  try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || '/opt/google/chrome/chrome', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const headerTimeout = await timeoutCase('headers');
    const bodyTimeout = await timeoutCase('body');
    const failedReadRecovery = await failedReadInvalidatesOldList();
    const deleteAndReconciliation = await deleteAndReconciliationTimeout();
    assert.equal(sessionRequests, 0);
    assert.deepEqual(externalRequests, []);
    assert.deepEqual(pageErrors, []);
    console.log(JSON.stringify({
      pass: true,
      baseHead: '360aa59323a5f1f84cb0b312d0b6c8f323b6f0d2',
      source: { path: 'static/js/group.js', sha256: sourceHash, transform: 'only internal startGroup call replaced with fixture stub' },
      controls: { headerTimeout, bodyTimeout, failedReadRecovery, deleteAndReconciliation },
      clock: 'Playwright synthetic browser clock advanced 15,001 ms per deadline',
      isolation: { sessionRequests, externalRequests, pageErrors, network: 'guarded loopback fixture only; no session APIs, real accounts, models, or inference' },
    }, null, 2));
  } finally {
    releaseHeldGet?.();
    releaseHeldPost?.();
    if (browser) await browser.close().catch(() => {});
    if (server) {
      server.closeAllConnections?.();
      await new Promise(resolve => server.close(resolve));
    }
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
