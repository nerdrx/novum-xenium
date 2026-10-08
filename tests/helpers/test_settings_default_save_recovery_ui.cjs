// Default-model settings must report HTTP failures and serialize queued choices.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

const repo = path.resolve(__dirname, '../..');
const source = fs.readFileSync(path.join(repo, 'static/js/settings.js'), 'utf8');
const postStart = source.indexOf('async function _postSettings(body)');
const queueStart = source.indexOf('function _createSettingsSaver(', postStart);
const helpersEnd = source.indexOf('const el = byId;', queueStart);
const initStart = source.indexOf('async function initDefaultChat()');
const initEnd = source.indexOf('/* ── Utility Model ── */', initStart);
assert(postStart >= 0 && queueStart > postStart && helpersEnd > queueStart && initStart >= 0 && initEnd > initStart);
const settingsHelpers = source.slice(postStart, helpersEnd);
const initializer = source.slice(initStart, initEnd);
let postCalls = [];
let pendingResponses = new Map();

const html = `<!doctype html><meta charset="utf-8"><body>
<select id="set-defaultEpSelect"></select><select id="set-defaultModelSelect"></select><div id="set-defaultChatMsg"></div>
<script type="module" src="/fixture.js"></script></body>`;
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/') return res.end(html);
  if (url.pathname === '/api/auth/settings' && req.method === 'GET') {
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ default_endpoint_id: 'ep', default_model: 'm0' }));
  }
  if (url.pathname === '/api/auth/settings' && req.method === 'POST') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const index = postCalls.length;
    postCalls.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    pendingResponses.set(index, status => {
      res.writeHead(status, { 'Content-Type': 'text/plain' });
      res.end(status === 200 ? 'ok' : 'fixture save failure');
    });
    return;
  }
  if (url.pathname === '/__calls') {
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify(postCalls));
  }
  if (url.pathname.startsWith('/__release/')) {
    const [, , index, status] = url.pathname.split('/');
    const respond = pendingResponses.get(Number(index));
    if (!respond) { res.writeHead(404); return res.end(); }
    pendingResponses.delete(Number(index));
    respond(Number(status));
    res.writeHead(204); return res.end();
  }
  if (url.pathname === '/fixture.js') {
    res.setHeader('Content-Type', 'text/javascript');
    return res.end(`
      const byId = id => document.getElementById(id);
      const el = byId;
      const invalidateSettings = () => { window.__invalidations = (window.__invalidations || 0) + 1; };
      ${settingsHelpers}
      const endpoints = [{ id: 'ep', name: 'Endpoint', models: ['m0', 'm1'] }];
      const _fetchModelEndpoints = async () => endpoints;
      const _fillEndpointSelect = (select, list, selected) => {
        select.replaceChildren(...list.map(item => { const option = document.createElement('option'); option.value = item.id; option.textContent = item.name; return option; }));
        if (selected) select.value = selected;
      };
      const _fillModelSelect = (select, list, selected) => {
        select.replaceChildren(...list.map(item => { const option = document.createElement('option'); option.value = item; option.textContent = item; return option; }));
        if (selected) select.value = selected;
      };
      const _registerAiEndpointRefresh = () => {};
      const providerLogo = () => '';
      ${initializer}
      await initDefaultChat(); window.fixtureReady = true;
    `);
  }
  const file = path.resolve(repo, `.${url.pathname}`);
  if (!file.startsWith(repo + path.sep) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
  res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : 'text/plain');
  fs.createReadStream(file).pipe(res);
});

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE,
    args: ['--no-sandbox', '--disable-gpu'] });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.stack || error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForFunction(() => window.fixtureReady, null, { timeout: 3000 })
      .catch(() => { throw new Error(`fixture did not initialize: ${errors.join('\n')}`); });
    const model = page.locator('#set-defaultModelSelect');
    const status = page.locator('#set-defaultChatMsg');
    const release = (index, code) => page.evaluate(([i, s]) => fetch(`/__release/${i}/${s}`), [index, code]);
    const calls = () => page.evaluate(async () => (await fetch('/__calls')).json());

    await model.selectOption('m1');
    await page.waitForFunction(async () => (await (await fetch('/__calls')).json()).length === 1);
    await page.waitForFunction(() => document.getElementById('set-defaultChatMsg').textContent === 'Saving…');
    assert.equal((await calls()).length, 1, 'first change starts one save');
    await release(0, 503);
    await page.waitForFunction(() => document.getElementById('set-defaultChatMsg').textContent === 'Failed to save');

    await model.selectOption('m0');
    await page.waitForFunction(async () => (await (await fetch('/__calls')).json()).length === 2);
    assert.deepEqual((await calls())[1], { default_endpoint_id: 'ep', default_model: 'm0' });
    await release(1, 200);
    await page.waitForFunction(() => document.getElementById('set-defaultChatMsg').textContent === 'Saved');

    // A newer choice waits behind the in-flight request. It remains the final
    // persisted request even if its predecessor fails later.
    await model.selectOption('m1');
    await page.waitForFunction(async () => (await (await fetch('/__calls')).json()).length === 3);
    await model.selectOption('m0');
    await page.waitForTimeout(200);
    assert.equal((await calls()).length, 3, 'concurrent model edits are serialized');
    assert.equal(await status.textContent(), 'Saving…');
    await release(2, 503);
    await page.waitForFunction(async () => (await (await fetch('/__calls')).json()).length === 4);
    assert.deepEqual((await calls())[3], { default_endpoint_id: 'ep', default_model: 'm0' });
    assert.equal(await status.textContent(), 'Saving…', 'old failure does not replace the latest pending status');
    await release(3, 200);
    await page.waitForFunction(() => document.getElementById('set-defaultChatMsg').textContent === 'Saved');
    assert.equal(await page.evaluate(() => window.__invalidations), 4, 'each completed write invalidates the settings cache');
    assert.deepEqual(errors, [], `page errors: ${errors.join('\n')}`);
    console.log('PASS: Settings HTTP failure, retry, queued snapshot order, and truthful status');
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
