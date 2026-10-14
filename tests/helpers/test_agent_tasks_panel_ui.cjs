// Exercise the shipped module panel HTML in its real sandboxed iframe.
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const panel = fs.readFileSync(path.resolve(__dirname, '../../modules/subagents/panel.html'), 'utf8');

(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.BROWSER_EXECUTABLE || undefined,
    headless: true,
  });
  try {
    const page = await browser.newPage({ viewport: { width: 560, height: 1200 } });
    await page.setContent('<body style="margin:0"><iframe style="width:100vw;height:1200px;border:0" sandbox="allow-scripts" title="Agent tasks"></iframe></body>');
    await page.evaluate(() => {
      window.requests = [];
      window.opens = [];
      addEventListener('message', event => {
        if (event.data?.type === 'novum:request') {
          window.requests.push({ ...event.data, source: event.source });
        }
        if (event.data?.type === 'novum:open') window.opens.push(event.data);
      });
      window.reply = (id, data) => {
        const request = window.requests.find(item => item.id === id);
        request.source.postMessage({ type: 'novum:response', id, data }, '*');
      };
    });
    await page.locator('iframe').evaluate((frame, html) => { frame.srcdoc = html; }, panel);
    const frame = page.frames()[1];
    await page.waitForFunction(() => window.requests.length === 2);
    const requests = await page.evaluate(() => window.requests.map(({ id, capability }) => ({ id, capability })));
    const runs = requests.find(item => item.capability === 'runs').id;
    const subs = requests.find(item => item.capability === 'subagents').id;

    // Runs may arrive first. Their active state must survive the later subagent snapshot.
    await page.evaluate(id => window.reply(id, { items: [
      { session_id: 'active', title: 'Active task', status: 'running', can_resume: true, updated: 1791930000 },
      { session_id: 'stale', title: 'Interrupted task', status: 'interrupted', can_resume: false },
      { session_id: 'broken', title: 'Failed task', status: 'failed', can_resume: false },
      { session_id: 'done', title: 'Finished task', status: 'finished', can_resume: false },
    ] }), runs);
    await frame.getByRole('heading', { name: 'Active task' }).waitFor();
    await page.evaluate(id => window.reply(id, { items: [
      { session_id: 'active', title: 'Active task', status: 'waiting', model: 'model-a' },
      { session_id: 'waiting', title: 'Waiting task', status: 'waiting_approval', model: 'model-b' },
    ] }), subs);
    await frame.getByRole('heading', { name: 'Waiting task' }).waitFor();
    assert.equal(await frame.locator('.agent').count(), 5);
    assert.equal(await frame.getByRole('button', { name: 'Resume stream' }).count(), 1);
    assert.equal(await frame.getByRole('button', { name: 'Resume stream' }).locator('xpath=..').locator('h2').textContent(), 'Active task');
    assert.equal(await frame.getByRole('button', { name: 'Open chat' }).count(), 4);

    await frame.getByLabel('Task status').selectOption('failed');
    assert.deepEqual(await frame.locator('.agent h2').allTextContents(), ['Failed task']);
    await frame.getByLabel('Task status').selectOption('waiting');
    assert.deepEqual((await frame.locator('.agent h2').allTextContents()).sort(), ['Interrupted task', 'Waiting task']);
    await frame.getByLabel('Task status').selectOption('all');
    await frame.getByLabel('Find a task').fill('model-b');
    assert.deepEqual(await frame.locator('.agent h2').allTextContents(), ['Waiting task']);
    await frame.getByLabel('Find a task').fill('');

    // Open chat remains available for waiting/interrupted work; it does not auto-resume.
    await frame.getByRole('button', { name: 'Open chat' }).first().click();
    await page.waitForFunction(() => window.opens.length === 1);
    assert.equal(await page.evaluate(() => window.opens[0].session_id), 'waiting');
    if (process.env.AGENT_TASKS_SCREENSHOT) {
      await page.screenshot({ path: process.env.AGENT_TASKS_SCREENSHOT, fullPage: true });
    }

    // A refresh keeps the old cards visible while both capability responses are pending.
    await frame.getByRole('button', { name: 'Refresh' }).click();
    await frame.getByText('Refreshing tasks…').waitFor();
    assert.equal(await frame.getByRole('heading', { name: 'Active task' }).count(), 1);
    assert.equal(await frame.getByRole('heading', { name: 'Waiting task' }).count(), 1);
    console.log('PASS: real Agent tasks panel response ordering, statuses, filters, searchable model, safe open action, and retained cards during refresh');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
