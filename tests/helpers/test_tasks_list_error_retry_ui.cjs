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
<button id="tool-tasks-btn"></button><button id="rail-tasks"></button>
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
let notificationOwner = 'alice';
let feedNotifications = [];
const feedRequests = [];
const notificationDetails = {
  '42': { id: 42, kind: 'email', title: 'New mail', body: 'Hello', route: '#email=INBOX:7:account-1', created_at: '2026-10-16T10:00:00Z' },
  '43': { id: 43, kind: 'task', status: 'success', title: 'Task success', body: 'Done', route: '#tasks', created_at: '2026-10-16T10:00:01Z' },
};
const notificationDetailRequests = [];
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
    return res.end(JSON.stringify({ requests, createIdempotencyKeys, feedRequests, notificationDetailRequests }));
  }
  if (url.pathname === '/__feed' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => { feedNotifications = JSON.parse(body); res.writeHead(204); res.end(); });
    return;
  }
  if (url.pathname === '/__owner' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => { notificationOwner = JSON.parse(body).owner; res.writeHead(204); res.end(); });
    return;
  }
  if (url.pathname === '/api/auth/status') {
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ username: notificationOwner }));
  }
  if (url.pathname === '/api/tasks/notification-feed') {
    const after = url.searchParams.get('after');
    feedRequests.push({ owner: notificationOwner, after, email: url.searchParams.get('email') });
    res.setHeader('Content-Type', 'application/json');
    // No `after` is the no-history bootstrap. Later cursors read new events.
    return res.end(JSON.stringify(after == null
      ? { notifications: [], cursor: notificationOwner === 'alice' ? 40 : 5 }
      : { notifications: feedNotifications.filter(item => Number(item.id) > Number(after)), cursor: feedNotifications.at(-1)?.id || Number(after) }));
  }
  if (url.pathname.startsWith('/api/tasks/notification-feed/')) {
    const id = url.pathname.split('/').at(-1);
    notificationDetailRequests.push({ owner: notificationOwner, id });
    res.setHeader('Content-Type', 'application/json');
    const item = notificationDetails[id];
    res.writeHead(item ? 200 : 404);
    return res.end(JSON.stringify(item || { detail: 'not found' }));
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
  res.setHeader('Content-Type', (file.endsWith('.js') || file.endsWith('.mjs')) ? 'text/javascript' : 'text/plain');
  if (url.pathname === '/static/js/tasks.js') {
    const source = fs.readFileSync(file, 'utf8')
      .replace('function startNotificationPolling()', 'window.__pollTaskNotifications = _pollTaskNotifications;\nfunction startNotificationPolling()')
      .replace('export function openTasks(focusId, opts)', 'window.__createTask = _createTask;\nwindow.__showTaskForm = _showForm;\nwindow.__loadTasks = _fetchTasks;\nwindow.__renderTasks = _renderList;\nexport function openTasks(focusId, opts)');
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

    // The first feed read seeds this owner/device cursor without replaying history.
    await page.evaluate(() => {
      localStorage.clear();
      window.__pushBridgeMessages = [];
      window.NovumPushBridge = { postMessage: message => window.__pushBridgeMessages.push(JSON.parse(message)) };
      window.tasksModule.startNotificationPolling();
    });
    await page.evaluate(() => window.__pollTaskNotifications());
    await page.waitForFunction(() => Object.keys(localStorage).some(key => key.startsWith('odysseus-notification-cursor:alice:')));
    await page.waitForFunction(() => window.__pushBridgeMessages.some(message => message.method === 'feed-ready' && message.ready === true));
    assert.equal(await page.evaluate(() => window.__pushBridgeMessages.find(message => message.method === 'feed-ready' && message.ready).owner), 'alice', 'native background cursor is scoped to authenticated owner');
    let feedState = await (await page.request.get(`http://127.0.0.1:${server.address().port}/__state`)).json();
    assert.deepEqual(feedState.feedRequests[0], { owner: 'alice', after: null, email: null }, 'first authenticated poll requests no history or email watcher before permission');
    assert.equal(await page.locator('#tool-tasks-btn.task-completion-pending, #tool-tasks-btn.task-failure-pending').count(), 0);

    await page.evaluate(() => fetch('/__feed', { method: 'POST', body: JSON.stringify([
      { id: 41, kind: 'task', status: 'error', title: 'Task error: fixture task', body: 'failed', route: null },
      { id: 42, kind: 'email', title: 'New mail', body: 'Hello', route: '#email=INBOX:7:account-1' },
    ]) }));
    await page.evaluate(() => window.__pollTaskNotifications());
    await page.waitForFunction(() => document.getElementById('tool-tasks-btn')?.classList.contains('task-failure-pending'));
    assert.match(await page.locator('#toast').textContent(), /New mail/);
    feedState = await (await page.request.get(`http://127.0.0.1:${server.address().port}/__state`)).json();
    assert.deepEqual(feedState.feedRequests.map(request => request.after), [null, '40']);
    const savedCursors = await page.evaluate(() => Array.from({ length: localStorage.length }, (_, index) => {
      const key = localStorage.key(index); return [key, localStorage.getItem(key)];
    }));
    assert.ok(savedCursors.some(([key, value]) => key.startsWith('odysseus-notification-cursor:alice:') && value === '42'));

    // Account changes get an independent bootstrap cursor; taps resolve through authenticated detail.
    await page.evaluate(() => fetch('/__owner', { method: 'POST', body: JSON.stringify({ owner: 'bob' }) }));
    await page.evaluate(() => window.__pollTaskNotifications());
    await page.waitForFunction(async () => (await (await fetch('/__state')).json()).feedRequests.length === 3);
    feedState = await (await page.request.get(`http://127.0.0.1:${server.address().port}/__state`)).json();
    assert.deepEqual(feedState.feedRequests[2], { owner: 'bob', after: null, email: null }, 'cursor is independent per authenticated owner and device');
    await page.evaluate(() => fetch('/__owner', { method: 'POST', body: JSON.stringify({ owner: 'alice' }) }));
    await page.evaluate(() => { window.location.hash = '#notification-42'; });
    await page.waitForFunction(() => window.location.hash === '#email=INBOX:7:account-1');
    feedState = await (await page.request.get(`http://127.0.0.1:${server.address().port}/__state`)).json();
    assert.deepEqual(feedState.notificationDetailRequests.at(-1), { owner: 'alice', id: '42' });

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

    await page.evaluate(() => {
      class FixtureNotification {
        static permission = 'default';
        static requestPermission() { FixtureNotification.permission = 'granted'; return Promise.resolve('granted'); }
      }
      Object.defineProperty(window, 'Notification', { configurable: true, value: FixtureNotification });
      window.tasksModule.openTasks();
    });
    const permissionButton = page.locator('#tasks-notification-permission');
    await permissionButton.waitFor();
    assert.equal(await permissionButton.textContent(), 'Enable notifications', 'permission is opt-in and not requested during startup');
    await permissionButton.click();
    await page.waitForFunction(() => document.getElementById('tasks-notification-permission')?.textContent === 'Notifications enabled');
    await page.evaluate(() => window.__pollTaskNotifications());
    await page.waitForFunction(async () => (await (await fetch('/__state')).json()).feedRequests.some(request => request.email === 'true'));
    feedState = await (await page.request.get(`http://127.0.0.1:${server.address().port}/__state`)).json();
    assert.ok(feedState.feedRequests.some(request => request.owner === 'alice' && request.after === '42' && request.email === 'true'), 'email watcher lease is refreshed only after permission is granted');
    await page.evaluate(() => { window.location.hash = '#notification-43'; });
    await page.waitForFunction(() => window.location.hash === '#tasks');
    await page.evaluate(() => window.tasksModule.stopNotificationPolling());
    assert.ok(await page.evaluate(() => window.__pushBridgeMessages.some(message => message.method === 'feed-ready' && message.ready === false)), 'native foreground suppression resets when feed polling stops');

    console.log('PASS: durable notification feed bootstrap/cursor/owner/tap routing; create retries and task-list recovery');
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
