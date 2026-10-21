'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');
const repo = path.resolve(__dirname, '../..');
const integrations = [
  { id: 'fixture-name', name: '<span data-fixture-marker="name">NAME</span>', base_url: '<span data-fixture-marker="detail">DETAIL</span> &amp;', enabled: true },
  { id: 'fixture-control', name: 'Plaintext control', base_url: 'https://fixture.invalid/plain', enabled: true },
  { id: 'fixture" data-fixture-marker="id', name: 'Quoted "name" & label', base_url: 'https://fixture.invalid/quoted', enabled: true },
];
const apiPaths = new Set([
  '/api/auth/integrations', '/api/calendar/config/accounts', '/api/contacts/config', '/api/contacts/list',
  '/api/email/accounts', '/api/mcp/servers', '/api/vault/config', '/api/tokens', '/api/calendar/calendars',
]);
const pageHtml = `<!doctype html><meta charset="utf-8"><body>
<div id="unified-integrations-list"></div><div id="unified-intg-form" style="display:none"></div>
<div><button id="unified-intg-add-btn">Add</button></div>
<script type="module">import settings from '/static/js/settings.js'; await settings.initUnifiedIntegrations(); window.fixtureReady = true;</script>`;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/') { res.writeHead(200, {'content-type':'text/html; charset=utf-8'}); return res.end(pageHtml); }
  if (apiPaths.has(url.pathname)) {
    const body = url.pathname === '/api/auth/integrations' ? { integrations }
      : url.pathname === '/api/calendar/config/accounts' ? { accounts: [] }
      : url.pathname === '/api/contacts/list' ? { contacts: [], count: 0 }
      : url.pathname === '/api/email/accounts' ? { accounts: [] }
      : url.pathname === '/api/mcp/servers' || url.pathname === '/api/tokens' ? [] : {};
    res.writeHead(200, {'content-type':'application/json','cache-control':'no-store'}); return res.end(JSON.stringify(body));
  }
  const file = path.resolve(repo, `.${decodeURIComponent(url.pathname)}`);
  if (!file.startsWith(repo + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, {'content-type': file.endsWith('.js') || file.endsWith('.mjs') ? 'text/javascript' : 'application/octet-stream'});
  fs.createReadStream(file).pipe(res);
});
(async () => {
  let browser;
  const externalRequests = [];
  const pageErrors = [];
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE, args: ['--no-sandbox', '--disable-gpu'] });
    const context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(7000);
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if ((url.protocol === 'http:' || url.protocol === 'https:') && url.origin !== origin) { externalRequests.push(url.href); return route.abort(); }
      return route.continue();
    });
    page.on('pageerror', error => pageErrors.push(error.stack || error.message));
    await page.goto(origin);
    await page.waitForFunction(() => window.fixtureReady);
    await page.waitForFunction(() => document.querySelectorAll('.intg-card').length === 3);
    const result = await page.evaluate(() => {
      const cards = [...document.querySelectorAll('.intg-card')];
      const card = id => cards.find(item => item.dataset.intgId === id);
      const marked = card('fixture-name');
      const plain = card('fixture-control');
      const quotedId = 'fixture" data-fixture-marker="id';
      const quoted = card(quotedId);
      const marker = document.querySelectorAll('[data-fixture-marker]');
      return {
        markerCount: marker.length,
        nameText: marked.querySelector('div[style*="font-size:12px"]').textContent,
        detailText: marked.querySelector('div[style*="font-size:11px"]').textContent,
        nameMarkupMarkerCount: marked.querySelectorAll('[data-fixture-marker="name"]').length,
        detailMarkupMarkerCount: marked.querySelectorAll('[data-fixture-marker="detail"]').length,
        quotedIdCardDataset: quoted?.dataset.intgId ?? null,
        quotedIdButtonDataset: quoted?.querySelector('.intg-del-btn')?.dataset.intgId ?? null,
        quotedIdBreakoutCount: document.querySelectorAll('[data-fixture-marker="id"]').length,
        quotedNameDataset: quoted?.querySelector('.intg-del-btn')?.dataset.intgName ?? null,
        plaintextCardText: plain.textContent,
        cardIconCount: cards.map(item => item.querySelectorAll('svg').length),
        activeIndicatorPresent: cards.map(item => !!item.querySelector('[title="Active"]')),
      };
    });
    assert.equal(result.markerCount, 0, 'inert HTML-like strings remain text');
    assert.ok(result.nameText.includes('<span data-fixture-marker="name">NAME</span> API'));
    assert.equal(result.detailText, '<span data-fixture-marker="detail">DETAIL</span> &amp;');
    assert.equal(result.nameMarkupMarkerCount, 0);
    assert.equal(result.detailMarkupMarkerCount, 0);
    assert.equal(result.quotedIdCardDataset, 'fixture" data-fixture-marker="id');
    assert.equal(result.quotedIdButtonDataset, 'fixture" data-fixture-marker="id');
    assert.equal(result.quotedIdBreakoutCount, 0);
    assert.equal(result.quotedNameDataset, 'Quoted "name" & label');
    assert.match(result.plaintextCardText, /Plaintext control API/);
    assert.deepEqual(result.cardIconCount, [2, 2, 2]);
    assert.deepEqual(result.activeIndicatorPresent, [true, true, true]);
    assert.deepEqual(externalRequests, []);
    assert.deepEqual(pageErrors, []);
    process.stdout.write('PASS settings integration markup escaping\n');
    process.stdout.write(JSON.stringify({result, externalRequests, pageErrors}, null, 2) + '\n');
    await context.close();
  } catch (error) { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; }
  finally { if (browser) await browser.close().catch(() => {}); if (server.closeAllConnections) server.closeAllConnections(); await new Promise(resolve => server.close(() => resolve())).catch(() => {}); }
})();
