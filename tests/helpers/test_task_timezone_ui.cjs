const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

const repo = path.resolve(__dirname, '../..');
const evidenceDir = process.env.EVIDENCE_DIR || '/tmp/novum-task-timezone-ui';
fs.mkdirSync(evidenceDir, { recursive: true });
const html = `<!doctype html><meta charset="utf-8">
<link rel="stylesheet" href="/static/css/00-tokens.css">
<link rel="stylesheet" href="/static/css/11-tasks.css">
<link rel="stylesheet" href="/static/css/email-calendar-notes-tasks.css">
<link rel="stylesheet" href="/static/nx-ui.css">
<body class="theme-novum-xenium">
<div id="tasks-filter-chips"></div><div id="tasks-list"></div>
<div id="tasks-tab-count"></div><div id="tasks-head-count"></div>
<button id="tool-tasks-btn"></button><button id="rail-tasks"></button><div id="toast"></div>
<script type="module">
  import { openTasks, closeTasks } from '/static/js/tasks.js';
  window.openTasks = openTasks; window.closeTasks = closeTasks;
  window.fixtureReady = true;
</script></body>`;

let activeTask;
let savedPayload;
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
  if (url.pathname === '/api/tasks' && req.method === 'GET') return send(200, { tasks: [activeTask] });
  if (url.pathname === '/__saved') return send(200, { payload: savedPayload });
  if (url.pathname === '/api/tasks' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => { savedPayload = JSON.parse(body); send(200, { ...activeTask, ...savedPayload }); });
    return;
  }
  if (url.pathname === '/api/tasks/synthetic-task' && req.method === 'PUT') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => { savedPayload = JSON.parse(body); send(200, { ...activeTask, ...savedPayload }); });
    return;
  }
  if (url.pathname === '/api/tasks/meta/actions') return send(200, { actions: [] });
  if (url.pathname === '/api/tasks/meta/output-targets') return send(200, { targets: [{ value: 'session', label: 'Session' }] });
  if (url.pathname === '/api/tasks/onboarding') return send(200, { opened: true });
  if (url.pathname === '/api/auth/status') return send(200, { username: 'synthetic-owner' });
  if (url.pathname === '/api/tasks/notification-feed') return send(200, { notifications: [], cursor: 0 });
  if (url.pathname === '/api/tasks/runs/recent') return send(200, { runs: [], has_more: false });
  if (url.pathname === '/api/tasks/parse' && req.method === 'POST') {
    return send(200, { success: true, draft: { task_type: 'llm', trigger_type: 'schedule', schedule: 'daily', scheduled_time: '09:00', prompt: 'Synthetic draft' } });
  }
  if (url.pathname === '/api/tasks/synthetic-task/runs') return send(200, { runs: [] });
  return send(200, {});
});

function task(overrides = {}) {
  return {
    id: 'synthetic-task', name: 'Synthetic scheduled task', prompt: 'Fixture prompt',
    task_type: 'llm', trigger_type: 'schedule', schedule: 'daily', scheduled_time: '09:00',
    status: 'active', run_count: 0, ...overrides,
  };
}

async function openFixture(browser, value) {
  activeTask = value;
  savedPayload = null;
  const context = await browser.newContext({ timezoneId: 'America/Los_Angeles', locale: 'en-US', viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') console.error('PAGE', message.text()); });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  console.log('fixture navigating', value.schedule, value.schedule_timezone || 'legacy');
  await page.waitForFunction(() => window.fixtureReady);
  await page.evaluate(() => window.openTasks());
  await page.locator('.task-card .memory-item-meta').waitFor();
  const scheduleLabel = await page.locator('.task-card .memory-item-meta').first().innerText();
  await page.locator('.task-card .memory-item-title').click();
  await page.locator('.task-detail-edit-btn').click();
  await page.locator('#task-form-schedule').waitFor();
  return { page, context, errors, scheduleLabel };
}

async function save(page) {
  await page.locator('#task-form-save').click();
  await page.waitForFunction(() => document.querySelector('.task-form') === null);
  await page.waitForFunction(async () => (await (await fetch('/__saved')).json()).payload !== null);
  return page.evaluate(async () => (await (await fetch('/__saved')).json()).payload);
}

async function main() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE });
  const results = [];
  try {
    const literalPrompt = 'Draft HTML: </textarea><span id="fixture-markup">demo</span> & keep "quotes".';
    const linked = await openFixture(browser, task({ schedule_timezone: 'Europe/Berlin', scheduled_time: '09:13', prompt: literalPrompt }));
    let { page, context, errors } = linked;
    assert.equal(await page.locator('#task-form-prompt').inputValue(), literalPrompt);
    assert.equal(await page.locator('#fixture-markup').count(), 0, 'prompt markup must remain text');
    assert.match(linked.scheduleLabel, /Daily at 09:13 \(Europe\/Berlin\)/);
    assert.equal(await page.locator('#task-form-time-wrap-hour').inputValue(), '9');
    assert.equal(await page.locator('#task-form-time-wrap-min').inputValue(), '13');
    assert.match(await page.locator('.task-schedule-timezone-hint').innerText(), /09:13 in Europe\/Berlin/);
    await page.locator('#task-form-time-wrap-hour').selectOption('10');
    await page.locator('#task-form-time-wrap-min').selectOption('17');
    assert.match(await page.locator('.task-schedule-timezone-hint').innerText(), /10:17 in Europe\/Berlin/);
    await page.locator('#task-form-time-wrap-hour').selectOption('9');
    await page.locator('#task-form-time-wrap-min').selectOption('13');
    await page.locator('#tasks-modal .modal-body').evaluate(el => el.scrollTo(0, 0));
    await page.waitForTimeout(50);
    await page.locator('.task-form').screenshot({ path: path.join(evidenceDir, 'task-timezone-linked-berlin-editor.png') });
    const berlinPayload = await save(page);
    assert.equal(berlinPayload.prompt, literalPrompt);
    assert.equal(berlinPayload.scheduled_time, '09:13');
    assert.equal(berlinPayload.schedule_timezone, undefined, 'server owns linked timezone');
    results.push({ case: 'linked daily Berlin roundtrip', label: linked.scheduleLabel, picker: '09:13', payload: berlinPayload });
    await page.screenshot({ path: path.join(evidenceDir, 'task-timezone-linked-berlin.png') });
    assert.deepEqual(errors, []);
    await context.close();

    const weekly = await openFixture(browser, task({ schedule: 'weekly', scheduled_day: 2, scheduled_time: '21:35', schedule_timezone: 'Asia/Tokyo' }));
    ({ page, context, errors } = weekly);
    assert.match(weekly.scheduleLabel, /21:35 \(Asia\/Tokyo\)/);
    assert.equal(await page.locator('#task-form-time-wrap-hour').inputValue(), '21');
    assert.match(await page.locator('.task-schedule-timezone-hint').innerText(), /21:35 in Asia\/Tokyo/);
    const tokyoPayload = await save(page);
    assert.equal(tokyoPayload.scheduled_time, '21:35');
    assert.equal(tokyoPayload.schedule_timezone, undefined, 'server owns linked timezone');
    assert.equal(tokyoPayload.scheduled_day, 2);
    results.push({ case: 'linked weekly Tokyo roundtrip', picker: '21:35', payload: tokyoPayload });
    assert.deepEqual(errors, []);
    await context.close();

    const cron = await openFixture(browser, task({ schedule: 'cron', scheduled_time: '09:00', schedule_timezone: 'Europe/Berlin', cron_expression: '15 9 * * 1,3,5' }));
    ({ page, context, errors } = cron);
    assert.match(cron.scheduleLabel, /Cron \(Europe\/Berlin\): 15 9 \* \* 1,3,5/);
    assert.equal(await page.locator('#task-form-cron').inputValue(), '15 9 * * 1,3,5');
    assert.match(await page.locator('.task-schedule-timezone-hint').innerText(), /Cron runs in Europe\/Berlin/);
    const cronPayload = await save(page);
    assert.equal(cronPayload.cron_expression, '15 9 * * 1,3,5');
    assert.equal(cronPayload.schedule_timezone, undefined, 'server owns linked timezone');
    results.push({ case: 'linked cron remains raw', label: cron.scheduleLabel, expression: cronPayload.cron_expression, zone: 'Europe/Berlin' });
    assert.deepEqual(errors, []);
    await context.close();

    const legacy = await openFixture(browser, task({ scheduled_time: '20:13' }));
    ({ page, context, errors } = legacy);
    const expectedLegacy = await page.evaluate(() => { const d = new Date(); d.setUTCHours(20, 13, 0, 0); return { hour: String(d.getHours()).padStart(2, '0'), minute: String(d.getMinutes()).padStart(2, '0') }; });
    assert.equal(await page.locator('#task-form-time-wrap-hour').inputValue(), String(Number(expectedLegacy.hour)));
    assert.equal(await page.locator('#task-form-time-wrap-min').inputValue(), String(Number(expectedLegacy.minute)));
    assert.doesNotMatch(await page.locator('.task-schedule-timezone-hint').innerText(), /Europe|Tokyo/);
    const legacyPayload = await save(page);
    assert.equal(legacyPayload.scheduled_time, '20:13');
    assert.equal(legacyPayload.schedule_timezone, undefined);
    results.push({ case: 'legacy remains UTC to device-local in en-US locale', displayedTime: expectedLegacy, savedTime: legacyPayload.scheduled_time });
    assert.deepEqual(errors, []);
    await context.close();

    const onceDate = '2026-10-20T16:17:00.000Z';
    const once = await openFixture(browser, task({ schedule: 'once', scheduled_time: '20:00', scheduled_date: onceDate, schedule_timezone: 'Europe/Berlin' }));
    ({ page, context, errors } = once);
    assert.match(await page.locator('.task-schedule-timezone-hint').innerText(), /device timezone.*absolute instant/);
    assert.equal(await page.locator('#task-form-time-wrap-hour').inputValue(), '9', 'one-time picker uses absolute instant in Los Angeles');
    assert.equal(await page.locator('#task-form-time-wrap-min').inputValue(), '17', 'one-time picker keeps absolute minute in Los Angeles');
    const oncePayload = await save(page);
    assert.equal(oncePayload.scheduled_date, onceDate);
    assert.equal(oncePayload.schedule_timezone, undefined);
    results.push({ case: 'once stays absolute and device-local', savedDate: oncePayload.scheduled_date });
    assert.deepEqual(errors, []);
    await context.close();

    const switching = await openFixture(browser, task({ schedule_timezone: 'Europe/Berlin', scheduled_time: '09:00' }));
    ({ page, context, errors } = switching);
    await page.locator('#task-form-time-wrap-hour').selectOption('12');
    await page.locator('#task-form-time-wrap-min').selectOption('17');
    await page.locator('#task-form-schedule').selectOption('once');
    assert.match(await page.locator('.task-schedule-timezone-hint').innerText(), /device timezone.*absolute instant/);
    assert.equal(await page.locator('#task-form-time-wrap-hour').inputValue(), '12', 'frequency change keeps chosen hour');
    assert.equal(await page.locator('#task-form-time-wrap-min').inputValue(), '17', 'frequency change keeps chosen minute');
    await page.locator('#task-form-schedule').selectOption('daily');
    assert.equal(await page.locator('#task-form-time-wrap-hour').inputValue(), '12', 'frequency change keeps chosen hour');
    assert.equal(await page.locator('#task-form-time-wrap-min').inputValue(), '17', 'frequency change keeps chosen minute');
    assert.match(await page.locator('.task-schedule-timezone-hint').innerText(), /12:17 in Europe\/Berlin/);
    results.push({ case: 'daily to once and back preserves chosen clock', chosenClock: '12:17', zoneHint: 'Europe/Berlin' });
    assert.deepEqual(errors, []);
    await page.locator('#task-form-cancel').click();
    await page.locator('.tasks-tab[data-tab="new"]').click();
    await page.locator('#task-ai-input').fill('fixture only');
    await page.locator('#task-ai-btn').click();
    await page.locator('#task-form-schedule').waitFor();
    assert.equal(await page.locator('#task-form-time-wrap-hour').inputValue(), '9', 'AI draft local time converts to UTC and back exactly once');
    assert.match(await page.locator('.task-schedule-timezone-hint').innerText(), /device timezone/);
    const aiPayload = await save(page);
    const expectedAiUtc = await page.evaluate(() => { const d = new Date(); d.setHours(9, 0, 0, 0); return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`; });
    assert.equal(aiPayload.scheduled_time, expectedAiUtc);
    results.push({ case: 'AI draft remains single local-to-UTC conversion', picker: '09:00', savedUtc: aiPayload.scheduled_time });
    assert.deepEqual(errors, []);
    await context.close();

    fs.writeFileSync(path.join(evidenceDir, 'task-timezone-ui-results.json'), JSON.stringify({ timezoneId: 'America/Los_Angeles', results }, null, 2));
    console.log('PASS linked daily/weekly/cron, legacy, and daily-once frequency switching');
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
