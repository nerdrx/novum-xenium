// Reproduce the task list presenting a failed first load as a truly empty account.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

const repo = path.resolve(__dirname, '../..');
const html = `<!doctype html><meta charset="utf-8"><body>
<div id="tasks-list"></div><div id="tasks-tab-count"></div><div id="tasks-head-count"></div>
<div id="tasks-modal"><div class="modal-body"></div></div>
<div id="toast"></div>
<script type="module">
  import '/static/js/tasks.js';
  window.fixtureTask = { id: 'fixture-task', name: 'Fixture task', prompt: 'safe fixture data', status: 'paused', schedule_type: 'daily', schedule_time: '09:00', days_of_week: [], task_type: 'llm' };
  window.loadAndRenderTasks = async () => { const result = await window.__loadTasks(); window.__renderTasks(); return result; };
  window.fixtureReady = true;
</script></body>`;
const task = { id: 'fixture-task', name: 'Fixture task', prompt: 'safe fixture data', status: 'paused', schedule_type: 'daily', schedule_time: '09:00', days_of_week: [], task_type: 'llm' };
let plans = [];
let createPlans = [];
let requests = 0;
const createIdempotencyKeys = [];
let releaseOld = null;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/') return res.end(html);
  if (url.pathname === '/api/tasks') {
    requests++;
    const isCreate = req.method === 'POST';
    if (isCreate) createIdempotencyKeys.push(req.headers['idempotency-key'] || null);
    const plan = (isCreate ? createPlans : plans).shift() || { payload: { tasks: [task] } };
    const respond = () => {
      res.writeHead(plan.status || 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(plan.payload || { tasks: [task] }));
    };
    if (plan.hold) return new Promise(resolve => { releaseOld = () => { respond(); resolve(); }; });
    return respond();
  }
  if (url.pathname === '/__plan' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => { plans = JSON.parse(body); res.writeHead(204); res.end(); });
    return;
  }
  if (url.pathname === '/__plan-create' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => { createPlans = JSON.parse(body); res.writeHead(204); res.end(); });
    return;
  }
  if (url.pathname === '/__release-old') {
    releaseOld?.(); res.writeHead(204); return res.end();
  }
  if (url.pathname === '/__state') {
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ requests, createIdempotencyKeys }));
  }
  if (url.pathname === '/api/models') {
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ items: [] }));
  }
  if (url.pathname === '/api/tasks/meta/output-targets') {
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ targets: [] }));
  }
  const file = path.resolve(repo, `.${url.pathname}`);
  if (!file.startsWith(repo + path.sep) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
  res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : 'text/plain');
  if (url.pathname === '/static/js/tasks.js') {
    const source = fs.readFileSync(file, 'utf8').replace('export function openTasks(focusId, opts)', 'window.__createTask = _createTask;\nwindow.__showTaskForm = _showForm;\nwindow.__loadTasks = _fetchTasks;\nwindow.__renderTasks = _renderList;\nexport function openTasks(focusId, opts)');
    return res.end(source);
  }
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
    await page.waitForFunction(() => window.fixtureReady);

    await page.evaluate(() => fetch('/__plan', { method: 'POST', body: JSON.stringify([{ status: 503, payload: { detail: 'temporary task service outage' } }]) }));
    await page.evaluate(() => window.loadAndRenderTasks());
    assert.match(await page.locator('.task-load-error').textContent(), /Could not load tasks/);
    assert.doesNotMatch(await page.locator('#tasks-list').textContent(), /No tasks yet/);
    assert.equal(await page.locator('.task-load-retry').count(), 1, 'failed initial load offers retry');

    await page.evaluate(() => fetch('/__plan', { method: 'POST', body: JSON.stringify([{ payload: { tasks: [{ ...window.fixtureTask, name: 'Loaded task' }] } }]) }));
    await page.locator('.task-load-retry').click();
    await page.waitForFunction(() => document.querySelector('.task-card .memory-item-title')?.textContent === 'Loaded task');
    assert.equal(await page.locator('.task-load-error').count(), 0);

    await page.evaluate(() => fetch('/__plan', { method: 'POST', body: JSON.stringify([{ status: 503, payload: { detail: 'temporary outage' } }]) }));
    await page.evaluate(() => window.loadAndRenderTasks());
    assert.equal(await page.locator('.task-card .memory-item-title').textContent(), 'Loaded task', 'failed refresh preserves last successful tasks');
    assert.match(await page.locator('.task-load-error').textContent(), /Showing the last loaded list/);

    // Two overlapping loads model closing and reopening the panel. An older reply must not replace newer tasks.
    await page.evaluate(() => fetch('/__plan', { method: 'POST', body: JSON.stringify([
      { hold: true, payload: { tasks: [{ ...window.fixtureTask, name: 'Stale task' }] } },
      { payload: { tasks: [{ ...window.fixtureTask, name: 'Latest task' }] } },
    ]) }));
    await page.evaluate(() => { window.oldLoad = window.__loadTasks(); window.newLoad = window.__loadTasks(); });
    await page.evaluate(() => window.newLoad);
    await page.evaluate(() => window.__renderTasks());
    assert.equal(await page.locator('.task-card .memory-item-title').textContent(), 'Latest task');
    await page.evaluate(() => fetch('/__release-old'));
    await page.evaluate(() => window.oldLoad);
    await page.evaluate(() => window.__renderTasks());
    assert.equal(await page.locator('.task-card .memory-item-title').textContent(), 'Latest task', 'stale replies cannot replace a newer list');
    assert.deepEqual(errors, [], `page errors: ${errors.join('\n')}`);

    await page.evaluate(() => window.__createTask({ prompt: 'fixture create' }, 'fixture-idempotency-key'));
    assert.deepEqual((await (await page.request.get(`http://127.0.0.1:${server.address().port}/__state`)).json()).createIdempotencyKeys, ['fixture-idempotency-key']);

    await page.evaluate(() => window.__showTaskForm(null, 'llm', 'webhook'));
    await page.locator('#task-form-prompt').fill('same create intent');
    await page.evaluate(() => fetch('/__plan-create', { method: 'POST', body: JSON.stringify([{ hold: true, status: 503, payload: { detail: 'uncertain create result' } }]) }));
    await page.evaluate(() => {
      const button = document.getElementById('task-form-save');
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await page.waitForFunction(async () => (await (await fetch('/__state')).json()).createIdempotencyKeys.length === 2);
    const createState = async () => (await (await page.request.get(`http://127.0.0.1:${server.address().port}/__state`)).json());
    const heldKey = (await createState()).createIdempotencyKeys[1];
    assert.ok(heldKey, 'create form attaches an idempotency key');
    await page.evaluate(() => fetch('/__release-old'));
    await page.waitForFunction(() => !document.getElementById('task-form-save')?.disabled);

    await page.evaluate(() => fetch('/__plan-create', { method: 'POST', body: JSON.stringify([
      { status: 503, payload: { detail: 'retry fixture' } },
      { status: 503, payload: { detail: 'retry fixture' } },
      { status: 503, payload: { detail: 'changed fixture' } },
    ]) }));
    await page.locator('#task-form-save').click();
    await page.waitForFunction(async () => (await (await fetch('/__state')).json()).createIdempotencyKeys.length === 3);
    await page.waitForFunction(() => !document.getElementById('task-form-save')?.disabled);
    await page.locator('#task-form-save').click();
    await page.waitForFunction(async () => (await (await fetch('/__state')).json()).createIdempotencyKeys.length === 4);
    const retryKeys = (await createState()).createIdempotencyKeys;
    assert.equal(retryKeys[2], heldKey, 'retrying unchanged content reuses the same key');
    await page.waitForFunction(() => !document.getElementById('task-form-save')?.disabled);

    await page.locator('#task-form-prompt').fill('changed create intent');
    await page.locator('#task-form-save').click();
    await page.waitForFunction(async () => (await (await fetch('/__state')).json()).createIdempotencyKeys.length === 5);
    const changedKeys = (await createState()).createIdempotencyKeys;
    assert.notEqual(changedKeys[4], heldKey, 'editing the request starts a fresh idempotency operation in the same form');
    await page.waitForFunction(() => !document.getElementById('task-form-save')?.disabled);

    await page.evaluate(() => window.__showTaskForm(null, 'llm', 'webhook'));
    await page.locator('#task-form-prompt').fill('late completion source');
    await page.evaluate(() => fetch('/__plan-create', { method: 'POST', body: JSON.stringify([{ hold: true, status: 200, payload: { id: 'fixture-created' } }]) }));
    await page.locator('#task-form-save').dispatchEvent('click');
    await page.waitForFunction(async () => (await (await fetch('/__state')).json()).createIdempotencyKeys.length === 6);
    await page.evaluate(() => window.__showTaskForm(null, 'llm', 'webhook'));
    await page.locator('#task-form-prompt').fill('new form survives old reply');
    await page.evaluate(() => fetch('/__release-old'));
    await page.waitForTimeout(100);
    assert.equal(await page.locator('#task-form-prompt').inputValue(), 'new form survives old reply', 'late create completion leaves a newly opened form intact');

    console.log('PASS: create guard/key retry/change and late form completion; task-list retry and stale-load behavior');
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
