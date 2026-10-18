const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

const repo = path.resolve(__dirname, '../..');
const statuses = ['success', 'error', 'skipped', 'aborted', 'queued', 'running'];
const tasks = statuses.map(status => ({
  id: `synthetic-${status}`, name: `Synthetic ${status}`, prompt: 'safe fixture prompt',
  task_type: 'llm', schedule: 'daily', scheduled_time: '09:00', status: 'active',
  run_count: 1, last_run_status: status, last_run_result: `Reason for ${status}`,
}));
const html = `<!doctype html><meta charset="utf-8"><body>
<div id="tasks-filter-chips"></div><div id="tasks-list"></div>
<div id="tasks-tab-count"></div><div id="tasks-head-count"></div>
<button id="tool-tasks-btn"></button><button id="rail-tasks"></button><div id="toast"></div>
<script type="module">
  import { openTasks } from '/static/js/tasks.js';
  window.openTasks = openTasks; window.fixtureReady = true;
</script></body>`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const send = (status, payload) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  };
  if (url.pathname === '/') return res.end(html);
  if (url.pathname.startsWith('/static/')) {
    const filename = path.join(repo, url.pathname.replace(/^\//, ''));
    if (!filename.startsWith(repo)) return send(403, {});
    res.writeHead(200, { 'Content-Type': filename.endsWith('.js') ? 'text/javascript' : 'text/css' });
    return fs.createReadStream(filename).pipe(res);
  }
  if (url.pathname === '/api/tasks' && req.method === 'GET') return send(200, { tasks });
  if (url.pathname === '/api/tasks/meta/actions') return send(200, { actions: [] });
  if (url.pathname === '/api/tasks/meta/output-targets') return send(200, { targets: [{ value: 'session', label: 'Session' }] });
  if (url.pathname === '/api/tasks/onboarding') return send(200, { opened: true });
  if (url.pathname === '/api/auth/status') return send(200, { username: 'synthetic-owner' });
  if (url.pathname === '/api/tasks/notification-feed') return send(200, { notifications: [], cursor: 0 });
  if (url.pathname === '/api/tasks/runs/recent') return send(200, { runs: [], has_more: false });
  const match = url.pathname.match(/^\/api\/tasks\/(synthetic-[a-z]+)\/runs$/);
  if (match) {
    const status = match[1].slice('synthetic-'.length);
    return send(200, { runs: [{ status, result: `Reason for ${status}` }] });
  }
  return send(200, {});
});

async function main() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE });
  const page = await browser.newPage();
  const errors = [];
  const observations = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForFunction(() => window.fixtureReady);
    await page.evaluate(() => window.openTasks());
    for (const status of statuses) {
      const card = page.locator(`.task-card:has-text("Synthetic ${status}")`);
      await card.locator('.memory-item-title').click();
      const summary = card.locator('.task-card-detail [title="Open full history"]');
      await summary.waitFor();
      assert.equal(await summary.locator('span').last().innerText(), `Reason for ${status}`, `${status} reason remains visible`);
      const color = await summary.evaluate(el => getComputedStyle(el).borderLeftColor);
      if (status === 'success') assert.notEqual(color, 'rgb(128, 128, 128)', 'success remains affirmative');
      if (status === 'error') assert.equal(color, 'rgb(224, 108, 117)', 'error remains red');
      if (status === 'skipped' || status === 'aborted') {
        assert.notEqual(color, 'rgb(80, 250, 123)', `${status} is not green`);
        assert.equal(await summary.locator('span').first().innerText(), '–', `${status} has neutral marker`);
      }
      if (status === 'queued' || status === 'running') {
        assert.equal(await summary.locator('.task-log-status').count(), 1, `${status} keeps busy marker`);
      }
      await summary.click();
      const run = page.locator('.task-run-item');
      await run.waitFor();
      assert.equal(await run.locator('.task-run-result').innerText(), `Reason for ${status}`);
      const expectedClass = status === 'success' ? 'task-run-success' : ['error'].includes(status) ? 'task-run-error' : ['queued', 'running'].includes(status) ? 'task-run-running' : '';
      const actualClass = await run.evaluate(el => el.className.split(/\s+/).filter(c => c.startsWith('task-run-') && c !== 'task-run-item').join(' '));
      assert.equal(actualClass, expectedClass, `${status} history classification`);
      observations.push({ status, cardBorderColor: color, historyClass: actualClass, reasonVisible: true });
      await page.locator('#task-history-back').click();
      await card.locator('.memory-item-title').waitFor();
    }
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ result: 'PASS', checks: observations, pageErrors: errors }));
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
