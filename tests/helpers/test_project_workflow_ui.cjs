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
      return json(res, {repository: '/workspace', project_id: 'fixture-project', workspace_map: ['README.md'],
        instructions: [{path: 'AGENTS.md', content: '<img id="injected"> guidance', notice: 'Review only'}]});
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
    return json(res, {capabilities: ['python'], workspace: url.searchParams.get('workspace')});
  }
  if (url.pathname.startsWith('/api/chat/evidence/')) {
    calls.push({method: req.method, path: url.pathname});
    return json(res, {evidence: 'fixture evidence', session: url.pathname.split('/').pop()});
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
    assert.equal(await report.locator('#injected').count(), 0, 'repo text must render as text, not HTML');

    await panel.getByRole('button', {name: 'Create worktree'}).click();
    await panel.getByRole('button', {name: 'Use this worktree'}).waitFor();
    assert.equal(await panel.getByRole('button', {name: 'Use this worktree'}).isEnabled(), true);
    await panel.locator('input[type="checkbox"]').check();
    await panel.getByRole('button', {name: 'Save checks'}).click();
    await page.waitForFunction(() => document.querySelector('.project-workflow-panel [role="status"]')?.textContent.includes('gate completion'));
    assert.equal(savedConfig.auto_run_on_completion, true);
    assert.equal(savedConfig.workspace, '/workspace');

    await panel.getByRole('button', {name: 'Run checks'}).click();
    await page.waitForFunction(() => document.querySelector('.project-workflow-panel [aria-label="Project workflow results"]')?.textContent.includes('check passed'));
    await panel.getByRole('button', {name: 'Check capabilities'}).click();
    await page.waitForFunction(() => document.querySelector('.project-workflow-panel [aria-label="Project workflow results"]')?.textContent.includes('python'));
    await panel.getByRole('button', {name: 'Run evidence'}).click();
    await page.waitForFunction(() => document.querySelector('.project-workflow-panel [aria-label="Project workflow results"]')?.textContent.includes('fixture evidence'));

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
