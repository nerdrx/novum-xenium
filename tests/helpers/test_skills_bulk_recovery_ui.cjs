// Exercise captured skill bulk targets, partial failures, retry selection, and duplicate clicks.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

const repo = path.resolve(__dirname, '../..');
const html = `<!doctype html><meta charset="utf-8"><body>
  <button id="skills-select-btn">Select</button>
  <div id="skills-bulk-bar" class="hidden">
    <input type="checkbox" id="skills-select-all">
    <span id="skills-selected-count"></span>
    <button id="skills-bulk-publish"></button><button id="skills-bulk-audit"></button>
    <button id="skills-bulk-delete-nonpassing"></button><button id="skills-bulk-delete"></button>
    <button id="skills-bulk-cancel"></button>
  </div>
  <div id="skills-list"></div><div id="skills-count"></div><div id="skills-count-h2"></div>
  <script type="module">
    import skills from '/static/js/skills.js';
    window.skillsModule = skills;
    window.fixtureErrors = [];
    window.fixtureToasts = [];
    window.fixtureReady = true;
  </script>
</body>`;
let skills = [
  { name: 'alpha', description: 'Alpha', status: 'draft', confidence: 0.8 },
  { name: 'beta', description: 'Beta', status: 'draft', confidence: 0.8 },
  { name: 'gamma', description: 'Gamma', status: 'draft', confidence: 0.8 },
];
let deletes = [];
let publishes = [];
let gets = [];
let deleteCalls = [];
let publishCalls = [];
let heldResponse = null;

const reply = (res, plan, value = { ok: true }) => {
  res.writeHead(plan.status || 200, { 'Content-Type': 'application/json' });
  res.end(plan.raw || JSON.stringify(plan.payload ?? value));
};
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/') { res.setHeader('Content-Type', 'text/html'); return res.end(html); }
  if (url.pathname === '/__plan' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const plan = JSON.parse(body);
      deletes = plan.deletes || [];
      publishes = plan.publishes || [];
      gets = plan.gets || [];
      res.writeHead(204); res.end();
    });
    return;
  }
  if (url.pathname === '/__release') {
    heldResponse?.(); heldResponse = null; res.writeHead(204); return res.end();
  }
  if (url.pathname === '/__state') {
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ deleteCalls, publishCalls, names: skills.map(sk => sk.name) }));
  }
  if (url.pathname === '/api/skills' && req.method === 'GET') return reply(res, gets.shift() || {}, { skills });
  if (url.pathname.endsWith('/markdown') && req.method === 'GET') return reply(res, {}, { markdown: 'fixture' });
  if (url.pathname === '/api/prefs') return reply(res, {}, {});
  if (url.pathname === '/api/skills/audit-all/status') return reply(res, {}, { status: 'none' });
  const match = url.pathname.match(/^\/api\/skills\/([^/]+)$/);
  if (match && req.method === 'DELETE') {
    const name = decodeURIComponent(match[1]);
    const plan = deletes.shift() || {};
    deleteCalls.push(name);
    const send = () => {
      if (!plan.status || plan.status < 400) skills = skills.filter(sk => sk.name !== name);
      reply(res, plan);
    };
    if (plan.hold) { heldResponse = send; return; }
    return send();
  }
  if (match && req.method === 'PUT') {
    const name = decodeURIComponent(match[1]);
    const plan = publishes.shift() || {};
    publishCalls.push(name);
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const send = () => {
        if (!plan.status || plan.status < 400) {
          const skill = skills.find(sk => sk.name === name);
          if (skill) skill.status = JSON.parse(body).status;
        }
        reply(res, plan);
      };
      if (plan.hold) { heldResponse = send; return; }
      send();
    });
    return;
  }
  const file = path.resolve(repo, `.${url.pathname}`);
  if (!file.startsWith(repo + path.sep) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
  if (url.pathname === '/static/js/ui.js') {
    res.setHeader('Content-Type', 'text/javascript');
    return res.end(`const esc=s=>String(s??''); export default {esc, showError:m=>window.fixtureErrors.push(String(m)), showToast:m=>window.fixtureToasts.push(String(m)), styledConfirm:async()=>true};`);
  }
  res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : 'text/plain');
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
    const pageErrors = [];
    page.on('pageerror', e => pageErrors.push(e.stack || e.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForFunction(() => window.fixtureReady && document.querySelector('.skill-card'));
    const setPlan = value => page.evaluate(plan => fetch('/__plan', { method: 'POST', body: JSON.stringify(plan) }), value);
    const state = () => page.evaluate(async () => (await (await fetch('/__state')).json()));
    const select = async name => {
      const cb = page.locator(`.skill-select-cb[data-name="${name}"]`);
      if (!await cb.isChecked()) await cb.check();
    };
    const selectMode = async () => {
      if (await page.locator('#skills-select-btn').textContent() !== 'Cancel') await page.locator('#skills-select-btn').click();
    };

    await selectMode();
    await select('alpha'); await select('beta');
    await setPlan({ deletes: [{ hold: true }, { status: 503 }, { status: 200 }] });
    await page.locator('#skills-bulk-delete').click();
    await page.waitForFunction(async () => (await (await fetch('/__state')).json()).deleteCalls.length === 1);
    assert.equal(await page.locator('#skills-bulk-delete').isDisabled(), true, 'duplicate bulk actions are disabled while pending');
    await page.locator('#skills-bulk-delete').dispatchEvent('click');
    assert.deepEqual((await state()).deleteCalls, ['alpha'], 'duplicate click does not start another bulk delete');
    await select('gamma');
    await page.evaluate(() => fetch('/__release'));
    await page.waitForFunction(() => window.fixtureErrors.some(text => text.includes('1 of 2 deleted')));
    assert.deepEqual((await state()).names, ['beta', 'gamma'], 'captured successful delete applies while later selection remains');
    assert.deepEqual(await page.locator('.skill-select-cb:checked').evaluateAll(nodes => nodes.map(n => n.dataset.name).sort()), ['beta', 'gamma'],
      'failed target and later-added selection remain selected');
    assert.match(await page.locator('#skills-selected-count').textContent(), /2 Selected/);
    assert.equal(await page.evaluate(() => window.fixtureToasts.some(text => text.startsWith('Deleted'))), false,
      'partial bulk failure is not reported as an all-success toast');

    await page.locator('.skill-select-cb[data-name="gamma"]').uncheck();
    await setPlan({ deletes: [{ status: 200 }], gets: [{ status: 503 }, {}] });
    await page.locator('#skills-bulk-delete').click();
    await page.waitForFunction(async () => !(await (await fetch('/__state')).json()).names.includes('beta'));
    await page.waitForSelector('#skills-load-error[role="alert"]');
    assert.deepEqual(await page.locator('.skill-card[data-skill-name]').evaluateAll(nodes => nodes.map(n => n.dataset.skillName)), ['gamma'],
      'confirmed delete stays removed from the cached list when refresh fails');
    await page.locator('#skills-load-error button').click();
    await page.waitForFunction(() => !document.querySelector('#skills-load-error'));
    await page.waitForFunction(() => document.querySelectorAll('.skill-select-cb:checked').length === 0);
    assert.deepEqual((await state()).names, ['gamma'], 'retry deletes the retained failed target');
    assert.equal(await page.locator('.skill-select-cb:checked').count(), 0, 'successful retry clears only its selection');

    await selectMode();
    await select('gamma');
    await setPlan({ publishes: [{ status: 503 }, { status: 200 }], gets: [{}, { status: 503 }, {}] });
    await page.locator('#skills-bulk-publish').click();
    await page.waitForFunction(() => window.fixtureErrors.some(text => text.includes('0 of 1 published')));
    assert.equal(await page.locator('.skill-select-cb[data-name="gamma"]').isChecked(), true,
      'all-failed publish retains selection for retry');
    assert.equal(await page.evaluate(() => window.fixtureToasts.some(text => text.startsWith('Published'))), false,
      'all-failed publish never reports success');
    await page.locator('#skills-bulk-publish').click();
    await page.waitForFunction(() => document.querySelector('.skill-status-pill')?.dataset.status === 'published');
    await page.waitForSelector('#skills-load-error[role="alert"]');
    assert.equal(await page.locator('.skill-status-pill').getAttribute('data-status'), 'published',
      'confirmed publish stays visible when list refresh fails');
    await page.locator('#skills-load-error button').click();
    await page.waitForFunction(() => !document.querySelector('#skills-load-error'));
    await page.waitForFunction(() => document.querySelectorAll('.skill-select-cb:checked').length === 0);
    assert.deepEqual((await state()).publishCalls, ['gamma', 'gamma'], 'retry sends only the retained target');
    assert.equal(await page.locator('.skill-select-cb:checked').count(), 0, 'successful publish clears its selection');
    assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join('\n')}`);
    console.log('PASS: skills bulk targets, mixed/all-failure retry, later selections, and duplicate-click guard');
  } finally {
    await browser.close();
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); server.closeAllConnections?.(); server.close(); process.exitCode = 1; });
