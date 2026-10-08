// The team editor must never autosave its fallback board after a failed load.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE ||
  '/home/nerdrx/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');

const repo = path.resolve(__dirname, '../..');
let scenario = '';
let initialGets = 0;
let putBodies = [];
let boards = {};
let releaseStaleA = null;
const html = `<!doctype html><meta charset="utf-8"><body><div id="team-root"></div>
<script type="module">
  import { createGroupTeam } from '/static/js/groupTeam.js';
  const params = new URLSearchParams(location.search);
  let parentId = params.get('case') === 'stale' ? 'A' : (params.get('case') === 'empty' ? 'empty' : 'parent1');
  for (const id of ['parent1', 'empty', 'A', 'B']) localStorage.setItem('odysseus-group-team-enabled:' + id, 'true');
  const team = createGroupTeam({ apiBase: '', getParentSessionId: () => parentId,
    getModels: () => [{ mid: 'builder-1', display: 'Builder' }, { mid: 'reviewer-1', display: 'Reviewer' }] });
  window.team = team;
  window.selectParent = id => { parentId = id; return team.mount(document.getElementById('team-root')); };
  window.initialDone = false;
  team.mount(document.getElementById('team-root')).then(() => { window.initialDone = true; });
  window.fixtureReady = true;
</script></body>`;

const json = (res, body, status = 200) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/') { res.setHeader('Content-Type', 'text/html'); return res.end(html); }
  const match = url.pathname.match(/^\/api\/groups\/([^/]+)\/team(?:\/run)?$/);
  if (match) {
    const id = decodeURIComponent(match[1]);
    if (url.pathname.endsWith('/run')) return json(res, {}, 404);
    if (req.method === 'PUT') {
      let body = ''; for await (const chunk of req) body += chunk;
      const board = JSON.parse(body).board;
      putBodies.push({ id, board }); boards[id] = board;
      return json(res, { board });
    }
    if (scenario === 'failed-retry' && id === 'parent1') {
      initialGets++;
      return initialGets === 1 ? json(res, { detail: 'temporary failure' }, 503) : json(res, { board: boards[id] });
    }
    if (scenario === 'malformed' && id === 'parent1') {
      return json(res, { board: { plan: 'Broken', participants: [], tasks: 'not-an-array' } });
    }
    if (scenario === 'empty' && id === 'empty') return json(res, { board: null });
    if (scenario === 'stale' && id === 'A') {
      return new Promise(resolve => { releaseStaleA = () => resolve(json(res, { detail: 'late failure' }, 503)); });
    }
    return json(res, { board: boards[id] || null });
  }
  const file = path.resolve(repo, `.${url.pathname}`);
  if (!file.startsWith(repo + path.sep) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
  res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : 'text/plain');
  fs.createReadStream(file).pipe(res);
});

const waitUntil = async (fn, timeoutMs = 3000) => {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { if (fn()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('Timed out waiting for fixture state');
};

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || '/opt/google/chrome/chrome',
    args: ['--no-sandbox', '--disable-gpu'] });
  try {
    async function openPage(which) {
      scenario = which; initialGets = 0; putBodies = []; releaseStaleA = null;
      boards = {
        parent1: { plan: 'Keep this existing plan', participants: [
          { id: 'builder-1', display: 'Builder', role: 'builder' },
          { id: 'reviewer-1', display: 'Reviewer', role: 'reviewer' },
        ], tasks: [{ id: 'existing', title: 'Important existing task', owner_id: 'builder-1', reviewer_id: 'reviewer-1', status: 'pending', work_result: '' }] },
        A: { plan: 'Old parent board', participants: [], tasks: [] },
        B: { plan: 'Selected parent board', participants: [], tasks: [] },
      };
      const page = await browser.newPage(); page.setDefaultTimeout(5000);
      const errors = []; page.on('pageerror', error => errors.push(error.stack || error.message));
      await page.goto(`http://127.0.0.1:${server.address().port}/?case=${which}`);
      await page.waitForFunction(() => window.fixtureReady);
      return { page, errors };
    }

    // Non-OK load preserves server state, disables editing/run/save, and retry restores the saved board.
    {
      const { page, errors } = await openPage('failed-retry');
      await page.waitForFunction(() => document.querySelector('[data-team-load-retry]'));
      assert.match(await page.locator('[role=alert]').textContent(), /Retry before editing or running/);
      assert.equal(await page.locator('[data-team-plan]').isDisabled(), true);
      assert.equal(await page.locator('[data-team-add]').isDisabled(), true);
      assert.equal(await page.locator('[data-team-run]').isDisabled(), true);
      await page.evaluate(() => window.team.setBoard({ plan: 'untrusted fallback', participants: [
        { id: 'builder-1', display: 'Builder', role: 'builder' },
      ], tasks: [{ id: 'replacement', title: 'Replacement', owner_id: 'builder-1', reviewer_id: '', status: 'pending', work_result: '' }] }));
      assert.equal(await page.evaluate(() => window.team.save()), false);
      await page.evaluate(() => window.team.runPass());
      assert.equal(putBodies.length, 0, 'failed board load blocks every write and run');

      await page.locator('[data-team-load-retry]').click();
      await page.waitForFunction(() => document.querySelector('[data-team-plan]')?.value === 'Keep this existing plan');
      assert.equal(await page.locator('[data-team-title]').inputValue(), 'Important existing task');
      assert.equal(await page.locator('[role=alert]').count(), 0);
      assert.equal(await page.locator('[data-team-add]').isDisabled(), false);
      assert.deepEqual(errors, []);
      await page.close();
    }

    // Malformed successful payloads use the same guarded recovery state as HTTP failures.
    {
      const { page, errors } = await openPage('malformed');
      await page.waitForFunction(() => document.querySelector('[data-team-load-retry]'));
      assert.match(await page.locator('[role=alert]').textContent(), /Could not load the team board/);
      assert.equal(await page.locator('[data-team-plan]').isDisabled(), true);
      assert.equal(await page.locator('[data-team-add]').isDisabled(), true);
      assert.equal(await page.evaluate(() => window.team.save()), false);
      assert.equal(putBodies.length, 0);
      assert.deepEqual(errors, []);
      await page.close();
    }

    // A genuine empty result is distinct from failure and remains editable.
    {
      const { page, errors } = await openPage('empty');
      await page.waitForFunction(() => window.initialDone);
      assert.equal(await page.locator('[role=alert]').count(), 0);
      assert.equal(await page.locator('[data-team-plan]').isDisabled(), false);
      assert.equal(await page.locator('[data-team-title]').count(), 0);
      await page.locator('[data-team-add]').click();
      await waitUntil(() => putBodies.length === 1);
      assert.equal(putBodies[0].board.plan, '');
      assert.equal(putBodies[0].board.tasks[0].title, 'New task');
      assert.deepEqual(errors, []);
      await page.close();
    }

    // A late failed request for a previously selected parent cannot replace the newer board.
    {
      const { page, errors } = await openPage('stale');
      await waitUntil(() => releaseStaleA);
      await page.evaluate(() => window.selectParent('B'));
      await page.waitForFunction(() => document.querySelector('[data-team-plan]')?.value === 'Selected parent board');
      releaseStaleA();
      await page.waitForTimeout(80);
      assert.equal(await page.locator('[data-team-plan]').inputValue(), 'Selected parent board');
      assert.equal(await page.locator('[role=alert]').count(), 0);
      assert.equal(putBodies.length, 0);
      assert.deepEqual(errors, []);
      await page.close();
    }
    console.log('PASS: failed team-board loads block writes, retry restores data, empty board remains editable, stale failures are ignored');
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
