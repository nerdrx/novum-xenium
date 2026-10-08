// Headless browser flow for the project panel embedded in the real workspace modal.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

const repo = path.resolve(__dirname, '../..');
const html = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/static/style.css"></head>
<body><button id="workspace-open">Workspace</button><script type="module">
localStorage.setItem('odysseus-workspace','/workspace');
localStorage.setItem('currentSessionId','fixture-session');
window.sessionModule={getCurrentSessionId:()=> 'fixture-session'};
import workspace from '/static/js/workspace.js';
document.getElementById('workspace-open').onclick=()=>workspace.openWorkspaceBrowser();
window.fixtureReady=true;
</script></body></html>`;
const calls = [];
let savedConfig = {checks: [], auto_run_on_completion: false};
let worktree = null;
const json = (res, data, status = 200) => {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(data));
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/') return res.end(html);
  if (url.pathname === '/api/workspace/browse') {
    return json(res, {path: '/workspace', parent: '/', dirs: [], selectable: true});
  }
  if (url.pathname === '/api/workspace/snapshots') return json(res, {snapshots: []});
  if (url.pathname.startsWith('/api/project-workflows/')) {
    let body = {};
    if (req.method !== 'GET' && req.method !== 'DELETE') {
      let raw = '';
      for await (const part of req) raw += part;
      body = raw ? JSON.parse(raw) : {};
    }
    calls.push({method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body});
    if (url.pathname.endsWith('/worktrees') && req.method === 'GET') {
      return json(res, {worktrees: worktree ? [worktree] : []});
    }
    if (url.pathname === '/api/project-workflows/inspect' && req.method === 'POST') {
      return json(res, {repository: '/workspace', project_id: 'fixture-project', workspace_map: ['README.md'], map_truncated: true,
        instructions: [{path: 'AGENTS.md', content: '<img id="injected"> guidance', notice: 'Review only'},
          {path: null, path_available: false, content: 'Retained guidance from an unavailable filename'}]});
    }
    if (url.pathname === '/api/project-workflows/worktrees' && req.method === 'POST') {
      worktree = {id: 'a'.repeat(32), repository: '/workspace', path: '/workspace/.nx-worktrees/feature', commit: 'b'.repeat(40)};
      return json(res, worktree);
    }
    if (url.pathname === '/api/project-workflows/verification' && req.method === 'GET') {
      return json(res, {checks: savedConfig.checks, auto_run_on_completion: savedConfig.auto_run_on_completion});
    }
    if (url.pathname === '/api/project-workflows/verification' && req.method === 'PUT') {
      savedConfig = body;
      return json(res, savedConfig);
    }
    if (url.pathname.endsWith('/verify') && req.method === 'POST') {
      return json(res, {required_checks_passed: true, complete: true,
        results: [{name: 'Smoke', required: true, passed: true, output: 'check passed'}]});
    }
    return json(res, {detail: `Unexpected project workflow request: ${req.method} ${url.pathname}`}, 404);
  }
  if (url.pathname.startsWith('/api/harness/preflight/')) {
    calls.push({method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams)});
    return json(res, {model: {id: 'fixture-model', tool_calling: {status: 'claimed'}, context_window: {tokens: 16000, reason: 'Endpoint serving limit may differ'}}, endpoint: {configured: true, enabled: true}, backends: {search: {status: 'configured_unverified'}, browser: {status: 'disabled'}, image_generation: {status: 'unavailable'}}, execution: {mode: 'local_process'}, tools: {items: [{name: 'python', availability: 'available'}, {name: 'web_fetch', availability: 'disabled'}]}, workspace: url.searchParams.get('workspace')});
  }
  if (url.pathname.startsWith('/api/chat/evidence/')) {
    calls.push({method: req.method, path: url.pathname});
    return json(res, {runs: [{status: 'awaiting_approval', model: 'fixture model', duration_seconds: 3, events: []}]});
  }
  const file = path.resolve(repo, `.${url.pathname}`);
  if (!file.startsWith(repo + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.statusCode = 404;
    return res.end();
  }
  res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/plain');
  fs.createReadStream(file).pipe(res);
});

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({headless: true, executablePath: process.env.BROWSER_EXECUTABLE});
  try {
    const page = await browser.newPage({viewport: {width: 1000, height: 850}});
    const errors = [];
    page.on('pageerror', error => errors.push(error.stack));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForFunction(() => window.fixtureReady);
    await page.locator('#workspace-open').click();
    await page.locator('.workspace-project-tools > summary').click();
    const panel = page.locator('.project-workflow-panel');
    await panel.getByRole('button', {name: 'Inspect project'}).click();
    const report = panel.getByLabel('Project workflow results');
    await page.waitForFunction(() => document.querySelector('.project-workflow-panel [aria-label="Project workflow results"]')?.textContent.includes('AGENTS.md'));
    assert.match(await report.textContent(), /<img id=/);
    assert.match(await report.textContent(), /workspace map is partial/);
    assert.match(await report.textContent(), /Guidance \(filename unavailable\)/);
    assert.match(await report.textContent(), /Retained guidance/);
    assert.equal(await report.locator('#injected').count(), 0, 'repo text must render as text, not HTML');

    await panel.getByRole('button', {name: 'Create worktree'}).click();
    await panel.getByRole('button', {name: 'Use this worktree'}).waitFor();
    assert.equal(await panel.getByRole('button', {name: 'Use this worktree'}).isEnabled(), true);
    const checks = panel.getByLabel('Verification checks');
    await panel.getByRole('button', {name: 'Add check'}).click();
    await checks.getByLabel('Name').fill('Safe argv');
    await checks.getByLabel('Executable').fill('python');
    await checks.getByLabel('Arguments (one per line)').fill('-m\npytest -q');
    await panel.getByRole('button', {name: 'Add check'}).click();
    await checks.getByLabel('Name').first().fill('Edited check');
    await checks.getByRole('button', {name: 'Remove check 2'}).click();
    assert.equal(await checks.getByLabel('Name').inputValue(), 'Edited check', 'removal preserves unsaved sibling edits');
    assert.equal(await checks.getByLabel('Timeout (seconds)').getAttribute('max'), '600');
    await panel.locator('details > summary').click();
    await panel.getByLabel('Checks JSON').fill(JSON.stringify([{name: 'JSON check', argv: ['python', '-m', 'pytest -q'], timeout_seconds: 120, required: true}]));
    await panel.locator('details > summary').click();
    await panel.getByRole('checkbox', {name: /automatically after agent edits/}).check();
    await panel.getByRole('button', {name: 'Save checks'}).click();
    await page.waitForFunction(() => document.querySelector('.project-workflow-panel [role="status"]')?.textContent.includes('gate completion'));
    assert.equal(savedConfig.checks[0].name, 'JSON check', 'collapsing JSON editor preserves its pending edits when saving');
    assert.equal(await checks.getByLabel('Name').inputValue(), 'JSON check');
    assert.equal(savedConfig.auto_run_on_completion, true);
    assert.equal(savedConfig.workspace, '/workspace');
    assert.deepEqual(savedConfig.checks[0].argv, ['python', '-m', 'pytest -q'], 'arguments stay explicit argv entries');

    await panel.getByRole('button', {name: 'Run checks'}).click();
    await page.waitForFunction(() => document.querySelector('.project-workflow-panel [aria-label="Project workflow results"]')?.textContent.includes('check passed'));
    assert.equal(await panel.getByLabel('Project workflow results').locator('pre').textContent(), 'check passed');
    await panel.getByRole('button', {name: 'Check capabilities'}).click();
    await page.waitForFunction(() => document.querySelector('.project-workflow-panel [aria-label="Project workflow results"]')?.textContent.includes('fixture-model'));
    assert.match(await report.textContent(), /Configured; not tested/);
    assert.match(await report.textContent(), /1 available · 1 disabled/);
    assert.match(await report.textContent(), /registry estimate/);
    assert.equal(await report.locator('pre').count(), 0, 'capability report is readable, raw JSON remains exportable');
    await panel.getByRole('button', {name: 'Run evidence'}).click();
    await page.waitForFunction(() => document.querySelector('.project-workflow-panel [aria-label="Project workflow results"]')?.textContent.includes('Awaiting approval'));

    await page.screenshot({path: '/tmp/nx-mint-project-desktop.png', fullPage: true});
    await page.setViewportSize({width: 390, height: 844});
    await page.waitForFunction(() => {
      const r = document.querySelector('#workspace-modal .modal-content').getBoundingClientRect();
      return r.top >= -1 && r.bottom <= innerHeight + 1 && r.left >= -1 && r.right <= innerWidth + 1;
    });
    await panel.getByRole('button', {name: 'Save checks'}).scrollIntoViewIfNeeded();
    await page.screenshot({path: '/tmp/nx-mint-project-mobile.png', fullPage: true});
    await page.setViewportSize({width: 1000, height: 850});
    await page.locator('#workspace-close').click();
    await page.locator('#workspace-open').click();
    await page.locator('.workspace-project-tools > summary').click();
    const reopened = page.locator('.project-workflow-panel');
    await reopened.getByRole('button', {name: 'Use this worktree'}).waitFor();
    assert.equal(await reopened.getByLabel('Project workflow results').textContent(), '', 'reopened panel must discard stale local report');
    await reopened.getByRole('button', {name: 'Use this worktree'}).click();
    await page.waitForFunction(() => document.getElementById('workspace-modal').style.display === 'none');
    assert.equal(await page.evaluate(() => localStorage.getItem('odysseus-workspace')), worktree.path);

    const projectCalls = calls.filter(call => call.path.startsWith('/api/project-workflows/'));
    assert.ok(projectCalls.some(call => call.method === 'PUT' && call.body.auto_run_on_completion === true));
    assert.ok(calls.some(call => call.path === '/api/harness/preflight/fixture-session' && call.query.workspace === '/workspace'));
    assert.ok(calls.some(call => call.path === '/api/chat/evidence/fixture-session'));
    assert.deepEqual(errors, []);
    console.log('PASS: integrated project panel inspect/create/select, verification opt-in/run, capability/evidence, and close-reopen lifecycle');
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
