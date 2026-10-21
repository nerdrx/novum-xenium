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
const targetCall = "await startGroup(picked, 'group-' + Date.now());";
assert.equal(originalGroup.split(targetCall).length - 1, 1, 'source seam must remain unique');
const servedGroup = originalGroup.replace(targetCall, 'await globalThis.__mockStartGroup(picked);');
const sourceHash = crypto.createHash('sha256').update(originalGroup).digest('hex');
let scenario = '';
let savedGroups = [];
let postedGroups = null;
let sessionRequests = 0;
let getRequests = 0;
let postRequests = 0;
let ambientApiRequests = [];
let externalRequests = [];
let pageErrors = [];
let browser;
let server;
let origin;

const html = `<!doctype html><meta charset="utf-8">
<div id="custom-preset-modal"></div>
<div class="preset-tab active" data-chartab="group"></div>
<div id="group-participants"></div>
<button id="group-add-btn" type="button">Add participant</button>
<button id="group-mode-btn" type="button">Mode</button>
<button id="save-custom-preset" type="button">Start</button>
<textarea id="message"></textarea>
<div id="chat-history"></div>
<div class="chat-input-right"><button class="mode-toggle" type="button"></button></div>
<div id="toast" role="status"></div>
<script type="module">
import group from '/static/js/group.js';
window.modelsModule = { getCachedItems: () => [{
  endpoint_id: 'synthetic-endpoint', endpoint_name: 'Fixture',
  url: 'http://model.invalid', models: ['fixture-a', 'fixture-b'],
  models_display: ['Fixture A', 'Fixture B']
}] };
window.__startGroupCalls = [];
window.__mockStartGroup = async picked => {
  window.__startGroupCalls.push({ models: picked.map(m => m.mid), active: group.isActive() });
};
group.init(location.origin);
window.groupReady = true;
</script>`;

function startServer() {
  return new Promise(resolve => {
    server = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        return res.end(html);
      }
      if (url.pathname.startsWith('/static/')) {
        const filename = path.resolve(staticRoot, '.' + url.pathname.slice('/static'.length));
        if (!filename.startsWith(staticRoot + path.sep) || !fs.existsSync(filename)) {
          res.writeHead(404).end();
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
        return res.end(filename === groupPath ? servedGroup : fs.readFileSync(filename));
      }
      if (url.pathname === '/api/presets/templates') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end('[]');
      }
      if (url.pathname.startsWith('/api/session')) {
        sessionRequests++;
        res.writeHead(500).end();
        return;
      }
      if (url.pathname === '/api/presets/groups' && req.method === 'GET') {
        getRequests++;
        if (scenario === 'get-failure') {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ detail: 'synthetic temporary list failure' }));
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ groups: savedGroups }));
      }
      if (url.pathname === '/api/presets/groups' && req.method === 'POST') {
        postRequests++;
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        postedGroups = JSON.parse(Buffer.concat(chunks).toString('utf8')).groups;
        if (scenario === 'post-failure') {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ detail: 'Failed to save group presets' }));
        }
        savedGroups = postedGroups;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true }));
      }
      if (url.pathname.startsWith('/api/')) {
        ambientApiRequests.push(url.pathname);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end('{}');
      }
      res.writeHead(404).end();
    });
    server.listen(0, '127.0.0.1', () => {
      origin = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
}

async function runScenario(name) {
  scenario = name;
  postedGroups = null;
  sessionRequests = 0;
  getRequests = 0;
  postRequests = 0;
  ambientApiRequests = [];
  savedGroups = ['get-failure', 'dedup'].includes(name)
    ? [{ id: 'prior', name: 'Existing synthetic preset', participants: [] }]
    : [];
  if (name === 'dedup') {
    savedGroups[0].participants = ['fixture-a', 'fixture-b'].map(mid => ({
      modelKey: JSON.stringify(['synthetic-endpoint', mid]), characterId: null,
    }));
  }
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
  await page.goto(origin);
  await page.waitForFunction(() => window.groupReady === true);

  for (let i = 0; i < 2; i++) {
    await page.locator('#group-add-btn').click();
    await page.locator('.group-participant-model').waitFor();
    await page.locator('.group-participant-model').selectOption({ index: i + 1 });
  }
  assert.equal(await page.locator('.group-participant-entry').count(), 2);
  await page.locator('#save-custom-preset').click();
  await page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('Group chat ready'));
  const shownToast = await page.locator('#toast').innerText();
  const state = await page.evaluate(() => ({ startCalls: window.__startGroupCalls, active: window.groupModule.isActive() }));
  await context.close();
  return { scenario: name, shownToast, ...state, postedGroups, persistedGroups: savedGroups,
    sessionRequests, getRequests, postRequests };
}

async function main() {
  await startServer();
  try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || '/opt/google/chrome/chrome' });
    const getFailure = await runScenario('get-failure');
    assert.ok(getFailure.shownToast.includes('Group chat ready'));
    assert.ok(getFailure.shownToast.includes('preset could not be saved'));
    assert.deepEqual(getFailure.startCalls, [{ models: ['fixture-a', 'fixture-b'], active: true }]);
    assert.equal(getFailure.active, true);
    assert.equal(getFailure.getRequests, 1);
    assert.equal(getFailure.postRequests, 0, 'Do not replace groups when their list could not be read');
    assert.equal(getFailure.persistedGroups[0].id, 'prior');
    assert.equal(getFailure.postedGroups, null);

    const postFailure = await runScenario('post-failure');
    assert.ok(postFailure.shownToast.includes('Group chat ready'));
    assert.ok(postFailure.shownToast.includes('could not confirm whether the preset was saved'));
    assert.deepEqual(postFailure.startCalls, [{ models: ['fixture-a', 'fixture-b'], active: true }]);
    assert.equal(postFailure.active, true, 'Preset failure must not stop the group chat');
    assert.equal(postFailure.getRequests, 2, 'Ambiguous POST failure is reconciled before mutations unlock');
    assert.equal(postFailure.postRequests, 1);
    assert.equal(postFailure.postedGroups.length, 1);
    assert.deepEqual(postFailure.persistedGroups, []);

    const success = await runScenario('success');
    assert.equal(success.shownToast, 'Group chat ready — 2 participants×');
    assert.deepEqual(success.startCalls, [{ models: ['fixture-a', 'fixture-b'], active: true }]);
    assert.equal(success.getRequests, 2, 'Accepted autosave refreshes the visible preset list');
    assert.equal(success.postRequests, 1);
    assert.equal(success.persistedGroups.length, 1);
    assert.equal(success.persistedGroups[0].participants.length, 2);

    const dedup = await runScenario('dedup');
    assert.equal(dedup.shownToast, 'Group chat ready — 2 participants×');
    assert.deepEqual(dedup.startCalls, [{ models: ['fixture-a', 'fixture-b'], active: true }]);
    assert.equal(dedup.getRequests, 1);
    assert.equal(dedup.postRequests, 0, 'Do not save duplicate group presets');
    assert.equal(dedup.persistedGroups[0].id, 'prior');

    assert.equal(sessionRequests, 0, 'startGroup is replaced by stub; no session API calls');
    assert.deepEqual(externalRequests, []);
    assert.deepEqual(pageErrors, []);
    console.log(JSON.stringify({
      pass: true,
      base: 'c58b104e1a98e4cda5d20ff11b2f9a6e729fc4d8',
      source: { path: 'static/js/group.js', sha256: sourceHash, transform: 'only internal startGroup call replaced with async fixture stub' },
      getFailure,
      postFailure,
      success,
      dedup,
      isolation: { sessionRequests, externalRequests, pageErrors, ambientApiRequests, network: 'loopback fixture only' },
    }, null, 2));
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server) {
      server.closeAllConnections?.();
      await new Promise(resolve => server.close(resolve));
    }
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
