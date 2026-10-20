import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import http from 'node:http';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

const source = await fs.readFile(new URL('../../static/js/slashAutocomplete.js', import.meta.url), 'utf8');
const registry = 'export const COMMANDS = {help:{handler(){},category:"Core",help:"Help",usage:"/help"}}; export const LEGACY_ALIASES = {};';
let scenario = 'http-retry';
let catalogRequests = 0;
let held = null;
let heldKind = null;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<textarea id="message"></textarea>'); }
  if (url.pathname === '/static/js/slashAutocomplete.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); return res.end(source); }
  if (url.pathname === '/static/js/slashCommands.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); return res.end(registry); }
  if (url.pathname === '/__mode') {
    scenario = url.searchParams.get('name'); catalogRequests = 0; held = null; heldKind = null;
    res.writeHead(204); return res.end();
  }
  if (url.pathname === '/__state') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ catalogRequests, held: Boolean(held) }));
  }
  if (url.pathname === '/__release') {
    const pending = held; held = null;
    const kind = heldKind; heldKind = null;
    if (pending && !pending.destroyed) {
      if (kind === 'failure') { pending.writeHead(503); pending.end('temporarily unavailable'); }
      else {
        pending.writeHead(200, { 'Content-Type': 'application/json' });
        pending.end(JSON.stringify({ skills: [{ name: 'synthetic-skill', token: '/synthetic-skill', category: 'Synthetic', help: 'synthetic only' }] }));
      }
    }
    res.writeHead(204); return res.end();
  }
  if (url.pathname === '/api/skills/slash-catalog') {
    catalogRequests++;
    if (scenario === 'http-retry' && catalogRequests <= 2) {
      held = res;
      heldKind = catalogRequests === 1 ? 'failure' : 'success';
      return;
    }
    if (scenario === 'malformed-retry' && catalogRequests === 1) {
      res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{invalid');
    }
    const skills = scenario === 'empty-success' ? [] : [
      { name: 'synthetic-skill', token: '/synthetic-skill', category: 'Synthetic', help: 'synthetic only' },
    ];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ skills }));
  }
  res.writeHead(404); res.end();
});

let browser;
let serverStarted = false;
const pageCatalogResponses = new WeakMap();
async function waitForState(predicate, timeout = 3000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const state = await (await fetch(`${origin}/__state`)).json();
    if (predicate(state)) return state;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for synthetic catalog state');
}
async function waitForCatalogResponse(page, index = 0) {
  const state = pageCatalogResponses.get(page);
  while (state.responses.length <= index) {
    await new Promise(resolve => state.waiters.push(resolve));
  }
  await state.responses[index];
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 0)));
}
async function newModulePage() {
  const page = await browser.newPage();
  const responseState = { responses: [], waiters: [] };
  pageCatalogResponses.set(page, responseState);
  page.on('response', response => {
    if (!response.url().includes('/api/skills/slash-catalog')) return;
    responseState.responses.push(response.finished());
    responseState.waiters.splice(0).forEach(resolve => resolve());
  });
  page.on('request', request => assert.ok(request.url().startsWith(origin), 'only loopback requests are allowed'));
  await page.addInitScript(() => {
    window.__testNow = 1000;
    window.__advanceTestClock = ms => { window.__testNow += ms; };
    Date.now = () => window.__testNow;
  });
  await page.goto(origin);
  await page.evaluate(async () => {
    const module = await import('/static/js/slashAutocomplete.js');
    module.initSlashAutocomplete(document.getElementById('message'));
  });
  return page;
}
async function setQuery(page, value, focus = false) {
  await page.evaluate(({ value, focus }) => {
    const input = document.getElementById('message');
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    if (focus) input.focus();
  }, { value, focus });
}
async function rows(page) { return page.locator('.slash-ac-row').allTextContents(); }

let origin;
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  serverStarted = true;
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({
    headless: true,
    ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}),
  });
  const results = {};

  await fetch(`${origin}/__mode?name=http-retry`);
  let page = await newModulePage();
  await waitForState(state => state.held);
  await setQuery(page, '/help');
  assert.ok((await rows(page)).some(row => row.includes('/help')), 'built-in suggestions stay available while request is pending');
  await setQuery(page, '/synthetic-skill', true);
  await setQuery(page, '/synthetic-skill', true);
  assert.equal((await waitForState(state => state.held)).catalogRequests, 1, 'concurrent interactions share one request');
  await fetch(`${origin}/__release`);
  await waitForCatalogResponse(page, 0);
  await waitForState(state => !state.held);
  await page.evaluate(() => window.__advanceTestClock(2001));
  await setQuery(page, '/', true);
  await waitForState(state => state.held && state.catalogRequests === 2);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#slash-autocomplete').evaluate(node => node.style.display), 'none');
  await fetch(`${origin}/__release`);
  await waitForCatalogResponse(page, 1);
  await waitForState(state => !state.held);
  assert.equal(await page.locator('#slash-autocomplete').evaluate(node => node.style.display), 'none', 'late recovery does not reopen dismissed popup');
  await setQuery(page, '/synthetic-skill', true);
  await page.waitForFunction(() => [...document.querySelectorAll('.slash-ac-row')].some(row => row.textContent.includes('/synthetic-skill')));
  results.httpFailureRetry = { requestCount: 2, skillSuggestionRecovered: true, builtinPreserved: true, inFlightDeduped: true, dismissedPopupStayedClosed: true };
  await page.close();

  await fetch(`${origin}/__mode?name=malformed-retry`);
  page = await newModulePage();
  await waitForState(state => state.catalogRequests === 1);
  await waitForCatalogResponse(page, 0);
  await page.evaluate(() => window.__advanceTestClock(2001));
  await setQuery(page, '/', true);
  await waitForState(state => state.catalogRequests === 2);
  await page.waitForTimeout(20);
  await setQuery(page, '/synthetic-skill', true);
  await page.waitForFunction(() => [...document.querySelectorAll('.slash-ac-row')].some(row => row.textContent.includes('/synthetic-skill')));
  results.malformedJsonRetry = { requestCount: 2, skillSuggestionRecovered: true };
  await page.close();

  await fetch(`${origin}/__mode?name=empty-success`);
  page = await newModulePage();
  await waitForState(state => state.catalogRequests === 1);
  await waitForCatalogResponse(page, 0);
  await page.evaluate(() => window.__advanceTestClock(100_000));
  for (let i = 0; i < 4; i++) await setQuery(page, i % 2 ? '/help' : '/synthetic-skill', true);
  const empty = await waitForState(state => state.catalogRequests === 1);
  assert.equal(empty.catalogRequests, 1, 'successful empty catalog does not refetch');
  results.emptySuccess = { requestCount: 1, builtinPreserved: (await rows(page)).some(row => row.includes('/help')) };
  await page.close();

  console.log(JSON.stringify({ results, loopbackOnly: true }));
} finally {
  await browser?.close().catch(() => {});
  if (serverStarted && server.closeAllConnections) server.closeAllConnections();
  if (serverStarted) await new Promise(resolve => server.close(resolve));
}
