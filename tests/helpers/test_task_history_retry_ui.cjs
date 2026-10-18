const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

const repo = path.resolve(__dirname, '../..');
const html = `<!doctype html><meta charset="utf-8"><body>
<div id="tasks-filter-chips"></div><div id="tasks-list"></div>
<div id="tasks-tab-count"></div><div id="tasks-head-count"></div>
<button id="tool-tasks-btn"></button><button id="rail-tasks"></button><div id="toast"></div>
<script type="module">
  import { openTasks, closeTasks } from '/static/js/tasks.js';
  window.openTasks = openTasks; window.closeTasks = closeTasks;
  window.fixtureReady = true;
</script></body>`;

const task = {
  id: 'synthetic-task', name: 'Synthetic task', prompt: 'safe fixture prompt',
  task_type: 'llm', schedule: 'daily', scheduled_time: '09:00',
  status: 'active', run_count: 1, last_run_status: 'error',
  last_run_result: 'Synthetic failed result',
};
let historyMode = 'http-error';
let historyCount = 0;
let releaseHistory = null;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const send = (status, payload) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  };
  if (url.pathname === '/') return res.end(html);
  if (url.pathname === '/static/js/tasks.js' || url.pathname.startsWith('/static/')) {
    const filename = path.join(repo, url.pathname.replace(/^\//, ''));
    if (!filename.startsWith(repo)) return send(403, {});
    res.writeHead(200, { 'Content-Type': filename.endsWith('.js') ? 'text/javascript' : 'text/css' });
    return fs.createReadStream(filename).pipe(res);
  }
  if (url.pathname === '/api/tasks' && req.method === 'GET') return send(200, { tasks: [task] });
  if (url.pathname === '/api/tasks/meta/actions') return send(200, { actions: [] });
  if (url.pathname === '/api/tasks/meta/output-targets') return send(200, { targets: [{ value: 'session', label: 'Session' }] });
  if (url.pathname === '/api/tasks/onboarding') return send(200, { opened: true });
  if (url.pathname === '/api/auth/status') return send(200, { username: 'synthetic-owner' });
  if (url.pathname === '/api/tasks/notification-feed') return send(200, { notifications: [], cursor: 0 });
  if (url.pathname === '/api/tasks/runs/recent') return send(200, { runs: [], has_more: false });
  if (url.pathname === '/__history-mode' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => { historyMode = JSON.parse(body).mode; send(204, {}); });
    return;
  }
  if (url.pathname === '/__release-history') {
    releaseHistory?.(); releaseHistory = null;
    return send(204, {});
  }
  if (url.pathname === '/__history-count') return send(200, { count: historyCount });
  if (url.pathname === '/api/tasks/synthetic-task/runs') {
    historyCount++;
    const mode = historyMode;
    if (mode === 'hold') {
      return new Promise(resolve => {
        releaseHistory = () => { send(200, { runs: [{ status: 'success', result: 'Stale result' }] }); resolve(); };
      });
    }
    if (mode === 'http-error') return send(503, { detail: 'synthetic unavailable' });
    if (mode === 'empty') return send(200, { runs: [] });
    if (mode === 'success') return send(200, { runs: [{ status: 'success', started_at: '2026-10-18T08:00:00Z', result: 'Recovered run' }] });
    return send(200, { runs: [{ status: 'success', result: `run-${historyCount}` }] });
  }
  return send(200, {});
});

async function main() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    await page.goto(base);
    await page.waitForFunction(() => window.fixtureReady);
    await page.evaluate(() => window.openTasks());
    await page.locator('.task-card').waitFor();

    const openHistory = async () => {
      await page.locator('.task-card .memory-item-title').click();
      await page.locator('.task-card-detail [title="Open full history"]').click();
    };
    const waitForHistoryCount = count => page.waitForFunction(async expected => {
      const response = await fetch('/__history-count');
      return (await response.json()).count >= expected;
    }, count);
    await openHistory();
    await page.locator('#task-history-retry').waitFor();
    assert.match(await page.locator('[role="alert"]').innerText(), /HTTP 503/);
    await page.evaluate(() => fetch('/__history-mode', { method: 'POST', body: JSON.stringify({ mode: 'success' }) }));
    await page.locator('#task-history-retry').click();
    await page.getByText('Recovered run').waitFor();

    await page.locator('#task-history-back').click();
    await page.locator('.task-card').waitFor();
    await page.evaluate(() => fetch('/__history-mode', { method: 'POST', body: JSON.stringify({ mode: 'empty' }) }));
    await openHistory();
    await page.getByText('No runs yet.').waitFor();

    await page.locator('#task-history-back').click();
    await page.locator('.task-card').waitFor();
    await page.evaluate(() => fetch('/__history-mode', { method: 'POST', body: JSON.stringify({ mode: 'hold' }) }));
    await openHistory();
    await waitForHistoryCount(4);
    await page.locator('.tasks-tab[data-tab="activity"]').click();
    await page.evaluate(() => fetch('/__release-history'));
    await page.waitForTimeout(50);
    assert.equal(await page.locator('.task-history-header').count(), 0, 'stale history must not replace Activity view');

    await page.locator('.tasks-tab[data-tab="tasks"]').click();
    await page.locator('.task-card').waitFor();
    await page.evaluate(() => fetch('/__history-mode', { method: 'POST', body: JSON.stringify({ mode: 'hold' }) }));
    await openHistory();
    await waitForHistoryCount(5);
    await page.evaluate(() => { window.__historyBody = document.querySelector('#tasks-modal .modal-body'); window.__historyBeforeClose = window.__historyBody.innerText; window.closeTasks(); });
    await page.evaluate(() => fetch('/__release-history'));
    await page.waitForTimeout(50);
    assert.equal(await page.evaluate(() => window.__historyBody.innerText), await page.evaluate(() => window.__historyBeforeClose), 'closed modal body must not receive stale history');
    assert.deepEqual(errors, []);
    console.log('PASS: task history retry, empty state, and stale response guards');
  } finally {
    releaseHistory?.();
    await browser.close();
    server.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
