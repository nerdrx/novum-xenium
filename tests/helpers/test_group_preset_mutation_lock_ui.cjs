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
  { id: 'fixture-a', name: 'Synthetic A', mode: 'parallel', participants: [] },
  { id: 'fixture-b', name: 'Synthetic B', mode: 'parallel', participants: [] },
];
let savedGroups = structuredClone(initialGroups);
let getCount = 0;
let postBodies = [];
let heldGetCount = 0;
let holdNextGet = false;
let releaseHeldGet = null;
let holdNextPost = false;
let releaseHeldPost = null;
let failGetAt = 0;
let sessionRequests = 0;
let externalRequests = [];
let pageErrors = [];
let browser;
let server;
let origin;

const html = `<!doctype html><meta charset="utf-8">
<div id="custom-preset-modal"><div class="preset-tab active" data-chartab="group">Group</div><div id="group-participants"><span>Ready</span></div><button id="group-add-btn" type="button">Add participant</button></div>
<button id="group-mode-btn" type="button">Mode</button><button id="save-custom-preset" type="button">Start</button>
<button id="group-toggle-btn" type="button">Open group presets</button>
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
document.getElementById('group-toggle-btn').addEventListener('click', () => document.getElementById('custom-preset-modal').classList.remove('hidden'));
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
      holdNextGet = true;
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
    if (url.pathname === '/__release-post') {
      releaseHeldPost?.();
      releaseHeldPost = null;
      req.resume();
      return json(res, { ok: true });
    }
    if (url.pathname === '/api/presets/groups' && req.method === 'GET') {
      getCount++;
      const snapshot = structuredClone(savedGroups);
      req.resume();
      if (getCount === failGetAt) return json(res, { detail: 'synthetic refresh failure' }, 503);
      if (holdNextGet) {
        holdNextGet = false;
        heldGetCount++;
        await new Promise(resolve => { releaseHeldGet = resolve; });
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
        await new Promise(resolve => { releaseHeldPost = resolve; });
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

async function waitFor(predicate, label) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > 8000) throw new Error('timeout waiting for ' + label);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

async function newPage() {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(6000);
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
    window.__groupJsonCompleted = 0;
    const json = Response.prototype.json;
    Response.prototype.json = async function (...args) {
      const value = await json.apply(this, args);
      if (this.url.includes('/api/presets/groups')) window.__groupJsonCompleted++;
      return value;
    };
  });
  await page.goto(origin);
  await page.waitForFunction(() => window.groupReady && window.__groupJsonCompleted === 1);
  return { context, page };
}

async function addParticipants(page) {
  for (let index = 0; index < 2; index++) {
    await page.locator('#group-add-btn').click();
    await page.locator('.group-participant-model').waitFor();
    await page.locator('.group-participant-model').selectOption({ index: index + 1 });
  }
  assert.equal(await page.locator('.group-participant-entry').count(), 2);
}

async function releaseGet(page) {
  const expectedJsonCount = await page.evaluate(() => window.__groupJsonCompleted + 1);
  await page.request.get(`${origin}/__release-get`);
  await waitFor(() => releaseHeldGet === null, 'held group list response release');
  await page.waitForFunction(count => window.__groupJsonCompleted >= count, expectedJsonCount);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function main() {
  await startServer();
  try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || '/opt/google/chrome/chrome', args: ['--no-sandbox', '--disable-dev-shm-usage'] });

    // Autosave owns the shared mutation lock, so a chip delete cannot write its old snapshot afterward.
    savedGroups = structuredClone(initialGroups);
    getCount = 0; postBodies = []; heldGetCount = 0; holdNextGet = false; failGetAt = 0;
    const first = await newPage();
    await first.page.waitForFunction(() => document.querySelectorAll('#group-presets-list button').length === 2);
    await addParticipants(first.page);
    await first.page.request.get(`${origin}/__hold-next-get`);
    await first.page.locator('#save-custom-preset').click();
    await first.page.waitForFunction(() => window.groupModule.isActive() && window.__startCalls.length === 1);
    await waitFor(() => heldGetCount === 1, 'autosave list read held');
    await first.page.locator('#group-toggle-btn').click();
    await first.page.locator('#group-presets-list button').first().locator('span').nth(1).dispatchEvent('click');
    assert.equal(postBodies.length, 0, 'delete must not write while autosave owns the lock');
    await releaseGet(first.page);
    await waitFor(() => postBodies.length === 1 && getCount === 3, 'autosave write and list reconciliation');
    await first.page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('Group chat ready'));
    assert.deepEqual(postBodies[0].slice(0, 2), ['Synthetic A', 'Synthetic B']);
    assert.equal(savedGroups.length, 3);
    assert.deepEqual(await first.page.locator('#group-presets-list button span:first-child').allTextContents(), ['Synthetic A', 'Synthetic B', 'Fixture A & Fixture B']);
    assert.equal(await first.page.locator('#toast').innerText(), 'Group chat ready — 2 participants×');
    const autosaveThenDelete = { posts: postBodies.length, finalGroups: savedGroups.map(group => group.name) };
    await first.context.close();

    // A delete already in flight makes optional autosave warn and skip its GET/POST entirely.
    savedGroups = structuredClone(initialGroups);
    getCount = 0; postBodies = []; heldGetCount = 0; holdNextGet = false; holdNextPost = false; failGetAt = 0;
    const second = await newPage();
    await second.page.waitForFunction(() => document.querySelectorAll('#group-presets-list button').length === 2);
    await addParticipants(second.page);
    await second.page.request.get(`${origin}/__hold-next-post`);
    await second.page.locator('#group-presets-list button').first().locator('span').nth(1).dispatchEvent('click');
    await waitFor(() => postBodies.length === 1 && releaseHeldPost !== null, 'delete POST accepted and response held');
    const getsBeforeStart = getCount;
    await second.page.locator('#save-custom-preset').click();
    await second.page.waitForFunction(() => window.groupModule.isActive() && window.__startCalls.length === 1 && document.querySelector('#toast')?.textContent.includes('preset list is busy'));
    assert.equal(getCount, getsBeforeStart, 'busy autosave must not read or write a competing snapshot');
    assert.equal(postBodies.length, 1);
    await second.page.request.get(`${origin}/__release-post`);
    await waitFor(() => releaseHeldPost === null && getCount === getsBeforeStart + 1, 'delete refresh');
    await second.page.waitForFunction(() => window.__groupJsonCompleted >= 2);
    assert.deepEqual(savedGroups.map(group => group.name), ['Synthetic B']);
    const deleteThenAutosaveSkipped = {
      getCount: getsBeforeStart,
      toast: await second.page.locator('#toast').innerText(),
      finalGroups: savedGroups.map(group => group.name),
    };
    await second.context.close();

    // An accepted autosave invalidates older list reads before refreshing; failed refresh leaves mutations stale.
    savedGroups = structuredClone(initialGroups);
    getCount = 0; postBodies = []; heldGetCount = 0; holdNextGet = false; failGetAt = 0;
    const third = await newPage();
    await third.page.waitForFunction(() => document.querySelectorAll('#group-presets-list button').length === 2);
    savedGroups = [{ id: 'obsolete', name: 'Obsolete snapshot', participants: [] }];
    await third.page.request.get(`${origin}/__hold-next-get`);
    await third.page.locator('.preset-tab[data-chartab="group"]').click();
    await waitFor(() => heldGetCount === 1, 'older list response held');
    savedGroups = structuredClone(initialGroups);
    failGetAt = 4; // initial, held old read, autosave read, then post-write refresh.
    await addParticipants(third.page);
    await third.page.locator('#save-custom-preset').click();
    await third.page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('preset saved, but the list could not be refreshed'));
    assert.equal(savedGroups.length, 3, 'server accepted the autosave despite failed list refresh');
    await releaseGet(third.page);
    assert.deepEqual(await third.page.locator('#group-presets-list button span:first-child').allTextContents(), ['Synthetic A', 'Synthetic B'], 'obsolete list response must not repaint after accepted autosave');
    const postBeforeStaleDelete = postBodies.length;
    await third.page.locator('#group-presets-list button').first().locator('span').nth(1).dispatchEvent('click');
    await third.page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('needs to reload'));
    assert.equal(postBodies.length, postBeforeStaleDelete, 'stale list blocks delete until a reload');
    const acceptedAutosaveRefreshFailed = {
      staleResponseIgnored: true,
      obsoleteSnapshotRendered: false,
      staleDeleteBlocked: true,
      finalGroups: savedGroups.map(group => group.name),
    };
    await third.context.close();

    assert.equal(sessionRequests, 0, 'startGroup replaced by no-op seam');
    assert.deepEqual(externalRequests, []);
    assert.deepEqual(pageErrors, []);
    console.log(JSON.stringify({
      pass: true,
      baseHead: 'dd91476009e0ed73131ef945553b42022097bc06',
      source: { path: 'static/js/group.js', sha256: sourceHash, transform: 'only internal startGroup call replaced by fixture stub' },
      races: { autosaveThenDelete, deleteThenAutosaveSkipped, acceptedAutosaveRefreshFailed },
      isolation: { sessionRequests, externalRequests, pageErrors, network: 'guarded loopback fixture only; no session APIs, real accounts or inference' },
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
