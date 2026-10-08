// Exercise skill load, delete, and markdown-save recovery in the real module.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

const repo = path.resolve(__dirname, '../..');
const html = `<!doctype html><meta charset="utf-8"><body>
  <div id="skills-list"></div><div id="skills-count"></div><div id="skills-count-h2"></div>
  <div id="toast"></div>
  <script type="module">
    import skills from '/static/js/skills.js';
    window.skillsModule = skills;
    window.fixtureErrors = [];
    window.fixtureToasts = [];
    window.fixtureReady = true;
  </script>
</body>`;
const skill = { name: 'fixture-skill', description: 'Fixture skill', status: 'draft', confidence: 0.8, uses: 1 };
let getPlans = [];
let deletePlans = [];
let savePlans = [];
let statusPlans = [];
let heldSave = null;
let getCount = 0;
let deleteCount = 0;
let saveBodies = [];
let statusCount = 0;

const reply = (res, plan, defaultBody) => {
  res.writeHead(plan.status || 200, { 'Content-Type': 'application/json' });
  res.end(plan.raw || JSON.stringify(plan.payload ?? defaultBody));
};
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/') { res.setHeader('Content-Type', 'text/html'); return res.end(html); }
  if (url.pathname === '/__plan' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const value = JSON.parse(body);
      getPlans = value.gets || [];
      deletePlans = value.deletes || [];
      savePlans = value.saves || [];
      statusPlans = value.statuses || [];
      res.writeHead(204); res.end();
    });
    return;
  }
  if (url.pathname === '/__release-save') {
    heldSave?.(); heldSave = null; res.writeHead(204); return res.end();
  }
  if (url.pathname === '/__state') {
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ getCount, deleteCount, saveBodies, statusCount }));
  }
  if (url.pathname === '/api/skills' && req.method === 'GET') {
    getCount++;
    return reply(res, getPlans.shift() || {}, { skills: [skill] });
  }
  if (url.pathname === '/api/skills/fixture-skill/markdown' && req.method === 'GET') {
    return reply(res, {}, { markdown: 'original markdown' });
  }
  if (url.pathname === '/api/skills/fixture-skill/markdown' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const parsed = JSON.parse(body);
      saveBodies.push(parsed.markdown);
      const plan = savePlans.shift() || {};
      const send = () => reply(res, plan, { ok: true });
      if (plan.hold) { heldSave = send; return; }
      send();
    });
    return;
  }
  if (url.pathname === '/api/skills/fixture-skill' && req.method === 'DELETE') {
    deleteCount++;
    return reply(res, deletePlans.shift() || { status: 503, payload: { detail: 'fixture outage' } }, { ok: true });
  }
  if (url.pathname === '/api/skills/fixture-skill' && req.method === 'PUT') {
    statusCount++;
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const plan = statusPlans.shift() || {};
      const send = () => {
        if (!plan.status || plan.status < 400) skill.status = JSON.parse(body).status;
        reply(res, plan, { ok: true });
      };
      if (plan.hold) { heldSave = send; return; }
      send();
    });
    return;
  }
  if (url.pathname === '/api/skills/audit-all/status') return reply(res, {}, { status: 'none' });
  if (url.pathname === '/api/prefs') return reply(res, {}, {});

  const file = path.resolve(repo, `.${url.pathname}`);
  if (!file.startsWith(repo + path.sep) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
  res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : 'text/plain');
  if (url.pathname === '/static/js/ui.js') {
    return res.end(`const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
      export default { esc, showError: m => window.fixtureErrors.push(String(m)),
        showToast: m => window.fixtureToasts.push(String(m)), styledConfirm: async () => true };`);
  }
  fs.createReadStream(file).pipe(res);
});

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true,
    executablePath: process.env.BROWSER_EXECUTABLE || '/opt/google/chrome/chrome',
    args: ['--no-sandbox', '--disable-gpu'] });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.stack || error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForFunction(() => window.fixtureReady && document.querySelector('.skill-card'));
    const setPlan = plan => page.evaluate(value => fetch('/__plan', {
      method: 'POST', body: JSON.stringify(value),
    }), plan);
    const state = () => page.evaluate(async () => (await (await fetch('/__state')).json()));

    await setPlan({ gets: [{ status: 503, payload: { detail: 'temporary outage' } }, { payload: { skills: [skill] } }] });
    await page.evaluate(() => window.skillsModule.loadSkills());
    await page.waitForSelector('#skills-load-error[role="alert"]');
    assert.equal(await page.locator('#skills-load-error').getAttribute('class'), 'admin-error');
    assert.equal(await page.locator('#skills-load-error').evaluate(el => el.style.gridColumn), '1 / -1');
    assert.equal(await page.locator('#skills-load-error button').getAttribute('class'), 'admin-btn-sm');
    assert.equal(await page.locator('.skill-card[data-skill-name="fixture-skill"]').count(), 1,
      'failed list refresh preserves the last loaded skill');
    await page.locator('#skills-load-error button').click();
    await page.waitForFunction(() => !document.querySelector('#skills-load-error'));
    assert.equal(await page.locator('.skill-card[data-skill-name="fixture-skill"]').count(), 1,
      'retry restores the refreshed list');

    await setPlan({ gets: [{ payload: { skills: { malformed: true } } }, { payload: { skills: [skill] } }] });
    await page.evaluate(() => window.skillsModule.loadSkills());
    await page.waitForSelector('#skills-load-error[role="alert"]');
    assert.equal(await page.locator('.skill-card[data-skill-name="fixture-skill"]').count(), 1,
      'malformed successful response preserves the last loaded skills');
    await page.locator('#skills-load-error button').click();
    await page.waitForFunction(() => !document.querySelector('#skills-load-error'));

    await page.locator('.skill-card[data-skill-name="fixture-skill"]').click({ position: { x: 200, y: 10 } });
    await page.waitForSelector('.skill-card.doclib-card-expanded');
    await setPlan({ statuses: [{ status: 503, payload: { detail: 'fixture outage' } }, { status: 200 }] });
    const publish = page.locator('.skill-card.doclib-card-expanded .doclib-card-action-btn').filter({ hasText: 'Publish' });
    await publish.click();
    await page.waitForFunction(() => window.fixtureErrors.some(text => text.includes('Update failed')));
    assert.equal(await page.locator('.skill-status-pill').getAttribute('data-status'), 'draft',
      'failed status update retains confirmed draft state');
    assert.equal(await page.evaluate(() => window.fixtureToasts.some(text => text === 'Skill approved')), false,
      'failed status update never reports publish success');
    await page.locator('.skill-card.doclib-card-expanded .doclib-card-action-btn').filter({ hasText: 'Publish' }).click();
    await page.waitForFunction(() => document.querySelector('.skill-status-pill')?.dataset.status === 'published');
    assert.equal(await page.evaluate(() => window.fixtureToasts.some(text => text === 'Skill approved')), true,
      'successful retry reports publish success');
    assert.equal((await state()).statusCount, 2);

    await page.locator('.skill-card[data-skill-name="fixture-skill"]').click({ position: { x: 200, y: 10 } });
    await page.waitForSelector('.skill-card.doclib-card-expanded');
    await page.locator('.skill-card.doclib-card-expanded .doclib-card-action-btn').filter({ hasText: 'Delete' }).click();
    await page.waitForFunction(() => window.fixtureErrors.some(text => text.includes('Delete failed')));
    assert.equal(await page.locator('.skill-card[data-skill-name="fixture-skill"]').count(), 1,
      'failed DELETE keeps the skill card');
    assert.equal(await page.evaluate(() => window.fixtureToasts.some(text => text === 'Skill deleted')), false,
      'failed DELETE never reports success');
    assert.equal((await state()).deleteCount, 1);

    const edit = page.locator('.skill-card[data-skill-name="fixture-skill"] .doclib-card-action-btn').filter({ hasText: 'Edit' });
    await edit.click();
    const textarea = page.locator('.skill-md-editor');
    await textarea.waitFor();
    await textarea.fill('first submitted version');
    await setPlan({ saves: [{ hold: true, status: 200 }, { status: 200 }] });
    await page.locator('.skill-card.doclib-card-expanded .doclib-card-action-btn').filter({ hasText: 'Save' }).click();
    await page.waitForFunction(async () => (await (await fetch('/__state')).json()).saveBodies.length === 1);
    await textarea.fill('newer draft typed while saving');
    await page.locator('.skill-card.doclib-card-expanded .doclib-card-action-btn').filter({ hasText: 'Save' }).click();
    assert.deepEqual((await state()).saveBodies, ['first submitted version'],
      'duplicate save while the first request is pending is suppressed');
    await page.evaluate(() => fetch('/__release-save'));
    await page.waitForFunction(() => window.fixtureToasts.some(text => text.includes('newer edits still need saving')));
    assert.equal(await textarea.inputValue(), 'newer draft typed while saving',
      'completion of an older save keeps newer textarea edits');
    await page.locator('.skill-card.doclib-card-expanded .doclib-card-action-btn').filter({ hasText: 'Save' }).click();
    await page.waitForFunction(() => window.fixtureToasts.some(text => text === 'Saved'));
    assert.deepEqual((await state()).saveBodies, ['first submitted version', 'newer draft typed while saving'],
      'the newer version can be saved after the first request completes');
    assert.equal(await page.locator('.skill-md-editor').count(), 0, 'successful second save exits edit mode');
    await page.locator('.skill-card[data-skill-name="fixture-skill"]').click({ position: { x: 200, y: 10 } });
    await page.waitForSelector('.skill-card.doclib-card-expanded');
    assert.equal(await page.locator('.skill-md-pre').textContent(), 'newer draft typed while saving',
      'the refreshed preview reflects the newer saved version');
    assert.deepEqual(errors, [], `page errors: ${errors.join('\n')}`);
    console.log('PASS: skill list retry, delete failure, and concurrent markdown edit recovery');
  } finally {
    await browser.close();
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); server.closeAllConnections?.(); server.close(); process.exitCode = 1; });
