const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

const repo = path.resolve(__dirname, '../..');
const ids = ['failed-latest', 'success-once', 'superseded-once', 'active-task', 'paused-task', 'pending-task', 'queued-retry', 'waiting-retry'];
const tasks = [
  { id: ids[0], name: 'Failed once latest', status: 'completed', schedule: 'once', task_type: 'action', action: 'test', can_run_again: true, last_run_status: 'error', last_run_result: 'Synthetic latest failure', run_count: 1 },
  { id: ids[1], name: 'Successful once', status: 'completed', schedule: 'once', task_type: 'action', action: 'test', can_run_again: false, last_run_status: 'success', last_run_result: 'Synthetic success', run_count: 1 },
  { id: ids[2], name: 'Superseded failure', status: 'completed', schedule: 'once', task_type: 'action', action: 'test', can_run_again: false, last_run_status: 'success', last_run_result: 'Later success', run_count: 2 },
  { id: ids[3], name: 'Active recurring', status: 'active', schedule: 'daily', task_type: 'action', action: 'test', can_run_again: true, last_run_status: 'success', last_run_result: 'Synthetic success', run_count: 1 },
  { id: ids[4], name: 'Paused recurring', status: 'paused', schedule: 'daily', task_type: 'action', action: 'test', can_run_again: true, last_run_status: 'error', last_run_result: 'Synthetic failure', run_count: 1 },
  { id: ids[5], name: 'Pending recurring', status: 'active', schedule: 'daily', task_type: 'action', action: 'test', can_run_again: true, can_force_run: true, last_run_status: 'queued', last_run_result: '_Queued — waiting for a free slot…_', run_count: 0 },
  { id: ids[6], name: 'Queued once retry', status: 'completed', schedule: 'once', task_type: 'action', action: 'test', can_run_again: true, can_force_run: false, last_run_status: 'queued', last_run_result: '_Queued — waiting for a free slot…_', run_count: 1 },
  { id: ids[7], name: 'Waiting failed retry', status: 'completed', schedule: 'once', task_type: 'action', action: 'test', can_run_again: true, can_force_run: false, last_run_status: 'error', last_run_result: 'Waiting for Novum to be idle', run_count: 1 },
];
const runs = [
  { task_id: ids[0], task_name: tasks[0].name, task_type: 'action', status: 'error', result: 'Latest synthetic failure', can_run_again: true, started_at: '2026-10-18T08:00:00Z', finished_at: '2026-10-18T08:01:00Z' },
  { task_id: ids[1], task_name: tasks[1].name, task_type: 'action', status: 'success', result: 'Synthetic success output', can_run_again: false, started_at: '2026-10-18T07:00:00Z', finished_at: '2026-10-18T07:01:00Z' },
  { task_id: ids[2], task_name: tasks[2].name, task_type: 'action', status: 'success', result: 'Later success output', can_run_again: false, started_at: '2026-10-18T06:00:00Z', finished_at: '2026-10-18T06:01:00Z' },
  { task_id: ids[2], task_name: tasks[2].name, task_type: 'action', status: 'error', result: 'Older failure output', can_run_again: false, started_at: '2026-10-18T05:00:00Z', finished_at: '2026-10-18T05:01:00Z' },
  { task_id: ids[3], task_name: tasks[3].name, task_type: 'action', status: 'success', result: 'Recurring output', can_run_again: true, started_at: '2026-10-18T04:00:00Z', finished_at: '2026-10-18T04:01:00Z' },
  { task_id: ids[4], task_name: tasks[4].name, task_type: 'action', status: 'error', result: 'Paused recurring failure', can_run_again: true, started_at: '2026-10-18T03:00:00Z', finished_at: '2026-10-18T03:01:00Z' },
  { task_id: ids[5], task_name: tasks[5].name, task_type: 'action', status: 'queued', result: '_Queued — waiting for a free slot…_', can_run_again: true, can_force_run: true, started_at: '2026-10-18T02:00:00Z' },
  { task_id: ids[6], task_name: tasks[6].name, task_type: 'action', status: 'queued', result: '_Queued — waiting for a free slot…_', can_run_again: true, can_force_run: false, started_at: '2026-10-18T01:00:00Z' },
  { task_id: ids[7], task_name: tasks[7].name, task_type: 'action', status: 'error', result: 'Waiting for Novum to be idle', can_run_again: true, can_force_run: false, started_at: '2026-10-18T00:00:00Z', finished_at: '2026-10-18T00:01:00Z' },
];
let runCalls = [];
const raceDetail = 'Retry no longer eligible after a newer successful run';

const html = `<!doctype html><meta charset="utf-8"><body>
<div id="toast" role="status"></div><button id="tool-tasks-btn"></button><button id="rail-tasks"></button>
<script type="module">
  import { openTasks } from '/static/js/tasks.js';
  window.openTasks = openTasks; window.fixtureReady = true;
</script></body>`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const send = (status, payload) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(payload === null ? '' : JSON.stringify(payload));
  };
  if (url.pathname === '/') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(html); }
  if (url.pathname.startsWith('/static/')) {
    const filename = path.resolve(repo, url.pathname.slice(1));
    if (!filename.startsWith(repo + path.sep)) return send(403, {});
    res.writeHead(200, { 'Content-Type': filename.endsWith('.js') ? 'text/javascript' : 'text/css' });
    return fs.createReadStream(filename).pipe(res);
  }
  if (url.pathname === '/api/tasks' && req.method === 'GET') return send(200, { tasks });
  if (url.pathname === '/api/tasks/meta/actions') return send(200, { actions: [] });
  if (url.pathname === '/api/tasks/meta/output-targets') return send(200, { targets: [{ value: 'session', label: 'Session' }] });
  if (url.pathname === '/api/tasks/onboarding' && req.method === 'GET') return send(200, { opened: true });
  if (url.pathname === '/api/auth/status') return send(200, { username: 'synthetic-owner' });
  if (url.pathname === '/api/tasks/notification-feed') return send(200, { notifications: [], cursor: 0 });
  if (url.pathname === '/api/tasks/runs/recent') return send(200, { runs, has_more: false });
  if (url.pathname === '/api/tasks/notification-logs' && req.method === 'POST') return send(204, null);
  const runMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/run$/);
  if (runMatch && req.method === 'POST') {
    runCalls.push({ id: runMatch[1], force: url.searchParams.get('force') === 'true' });
    if (runMatch[1] === ids[0]) return send(409, { detail: raceDetail });
    return send(200, { ok: true });
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
    await page.locator('.task-card').first().waitFor();
    await page.locator('#tasks-filter-chips .task-filter-chip').first().click();
    await page.locator(`.task-card[data-id="${ids[0]}"]`).waitFor();

    const taskActionCounts = {};
    for (const task of tasks) {
      const card = page.locator(`.task-card[data-id="${task.id}"]`);
      await card.locator('.memory-item-title').click();
      taskActionCounts[task.id] = {
        run: await card.locator('.task-detail-run-btn').count(),
        force: await card.locator('.task-detail-force-run-btn').count(),
      };
    }
    assert.deepEqual(taskActionCounts[ids[0]], { run: 1, force: 0 });
    assert.deepEqual(taskActionCounts[ids[1]], { run: 0, force: 0 });
    assert.deepEqual(taskActionCounts[ids[2]], { run: 0, force: 0 });
    assert.deepEqual(taskActionCounts[ids[3]], { run: 1, force: 0 });
    assert.deepEqual(taskActionCounts[ids[4]], { run: 1, force: 0 });
    assert.deepEqual(taskActionCounts[ids[5]], { run: 1, force: 1 });
    assert.deepEqual(taskActionCounts[ids[6]], { run: 1, force: 0 });
    assert.deepEqual(taskActionCounts[ids[7]], { run: 1, force: 0 });

    const failedCard = page.locator(`.task-card[data-id="${ids[0]}"]`);
    await failedCard.locator('.task-detail-run-btn').click();
    await page.getByText(raceDetail, { exact: true }).waitFor();
    assert.equal(runCalls.length, 1, 'one failed-card click produces one run request');
    assert.equal(runCalls[0].id, ids[0]);

    await page.locator('.tasks-tab[data-tab="activity"]').click();
    await page.locator('.task-log-row').first().waitFor();
    const activityButtons = await page.evaluate(() => [...document.querySelectorAll('.task-log-row')].map(row => ({
      name: row.querySelector('.task-log-name')?.textContent.trim(),
      result: row.querySelector('.task-log-row-body')?.textContent.trim() || row.textContent.trim(),
      runAgain: row.querySelectorAll('.task-log-run-again:not(.task-log-force-run)').length,
      runAnyway: row.querySelectorAll('.task-log-force-run').length,
    })));
    const hasButton = name => activityButtons.find(row => row.name === name)?.runAgain || 0;
    assert.equal(hasButton(tasks[0].name), 1, 'latest eligible failed one-shot exposes Run again');
    assert.equal(hasButton(tasks[1].name), 0, 'successful one-shot does not expose Run again');
    const supersededRows = activityButtons.filter(row => row.name === tasks[2].name);
    assert.equal(supersededRows.length, 2);
    assert(supersededRows.every(row => row.runAgain === 0), 'neither superseded failure nor later success is retryable');
    assert.equal(hasButton(tasks[3].name), 1, 'active recurring run remains runnable');
    assert.equal(hasButton(tasks[4].name), 1, 'paused recurring run remains runnable');
    assert.equal(hasButton(tasks[5].name), 0, 'queued result does not show completed Run again');
    assert.equal(activityButtons.find(row => row.name === tasks[5].name)?.runAnyway, 1, 'existing queued Run anyway path remains available');
    assert.equal(activityButtons.find(row => row.name === tasks[6].name)?.runAnyway, 0, 'completed queued retry cannot bypass the idle gate');
    assert.equal(activityButtons.find(row => row.name === tasks[7].name)?.runAnyway, 0, 'failed completed retry with waiting text cannot bypass the idle gate');

    const latestFailureRow = page.locator('.task-log-row').filter({ hasText: tasks[0].name }).first();
    await latestFailureRow.locator('.task-log-run-again').click();
    await page.getByText(raceDetail, { exact: true }).waitFor();
    assert.equal(runCalls.length, 2, 'one Activity click produces one run request');
    assert.equal(runCalls[1].id, ids[0]);
    const raceToast = await page.locator('#toast').innerText();
    assert(raceToast.includes(raceDetail), '409 server detail is shown as the recovery reason');

    const activeRow = page.locator('.task-log-row').filter({ hasText: tasks[3].name }).first();
    await activeRow.locator('.task-log-run-again').click();
    await page.getByText('Task triggered', { exact: true }).waitFor();
    assert.equal(runCalls.length, 3, 'eligible Activity action performs exactly one API call');
    assert.equal(runCalls[2].id, ids[3]);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({
      pass: true,
      taskActionCounts,
      activityButtons,
      runCallIds: runCalls.map(call => call.id),
      raceDetailDisplayed: raceToast,
      pageErrors: errors,
    }, null, 2));
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
