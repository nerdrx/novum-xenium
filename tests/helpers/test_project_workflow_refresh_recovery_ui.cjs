// Verify project workflow state after an action succeeds but its follow-up list refresh fails.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

const repo = path.resolve(__dirname, '../..');
const html = `<!doctype html><body>
  <div id="worktree-root"></div><div id="inspection-root"></div>
  <script type="module">
    import { mountProjectWorkflow } from '/static/js/projectWorkflow.js';
    window.mountProjectWorkflow = mountProjectWorkflow;
    window.jsonResponse = (data, status = 200) => new Response(JSON.stringify(data), {
      status, headers: { 'Content-Type': 'application/json' },
    });
    let worktreeGets = 0;
    let deletes = 0;
    window.worktreeState = () => ({ worktreeGets, deletes });
    const actionFetcher = async (url, options = {}) => {
      if (url === '/api/project-workflows/worktrees' && !options.method) {
        worktreeGets++;
        if (worktreeGets === 1) return jsonResponse({ worktrees: [
          { id: 'fixture', repository: 'repo', path: '/fixture', commit: 'abc' },
        ] });
        if (worktreeGets === 2) return jsonResponse({ detail: 'refresh failed' }, 503);
        return jsonResponse({ worktrees: [] });
      }
      if (url.endsWith('/fixture') && options.method === 'DELETE') {
        deletes++;
        return deletes === 1
          ? jsonResponse({ detail: 'delete failed' }, 503)
          : jsonResponse({ removed: true });
      }
      throw new Error('Unexpected fixture request: ' + (options.method || 'GET') + ' ' + url);
    };
    window.cleanupAction = mountProjectWorkflow(
      document.querySelector('#worktree-root'), '/fixture', { fetcher: actionFetcher },
    );

    let releaseInitialRefresh;
    let initialRefreshCalls = 0;
    const delayedInspectionFetcher = async (url) => {
      if (url === '/api/project-workflows/worktrees') {
        initialRefreshCalls++;
        if (initialRefreshCalls === 1) return new Promise(resolve => { releaseInitialRefresh = resolve; });
      }
      if (url === '/api/project-workflows/inspect') {
        return jsonResponse({ repository: '/inspected', workspace_map: [], instructions: [] });
      }
      if (url.startsWith('/api/project-workflows/verification?')) {
        return jsonResponse({ checks: [], auto_run_on_completion: false });
      }
      if (url === '/api/project-workflows/worktrees') return jsonResponse({ worktrees: [] });
      throw new Error('Unexpected inspection request: ' + url);
    };
    window.mountInspectionRace = () => {
      window.cleanupInspection = mountProjectWorkflow(
        document.querySelector('#inspection-root'), '/inspected', { fetcher: delayedInspectionFetcher },
      );
    };
    window.releaseInitialRefresh = () => releaseInitialRefresh(jsonResponse({ detail: 'old list request failed' }, 503));
    window.inspectionState = () => ({
      status: document.querySelector('#inspection-root [role="status"]')?.textContent,
      pending: initialRefreshCalls,
    });
    window.fixtureReady = true;
  </script>
</body>`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/') return res.end(html);
  const file = path.resolve(repo, `.${url.pathname}`);
  if (!file.startsWith(repo + path.sep) || !fs.existsSync(file)) {
    res.writeHead(404);
    return res.end();
  }
  res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : 'text/plain');
  fs.createReadStream(file).pipe(res);
});

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.BROWSER_EXECUTABLE,
    args: ['--no-sandbox', '--disable-gpu'],
  });
  try {
    const page = await browser.newPage();
    const pageErrors = [];
    page.setDefaultTimeout(5000);
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForFunction(() => window.fixtureReady && document.querySelector('#worktree-root li'));

    await page.locator('#worktree-root button').filter({ hasText: 'Remove worktree' }).click();
    await page.waitForFunction(() => document.querySelector('#worktree-root [role="status"]')?.textContent.includes('delete failed'));
    assert.equal(await page.locator('#worktree-root li[data-worktree-id="fixture"]').count(), 1,
      'failed DELETE leaves the worktree listed');

    await page.locator('#worktree-root button').filter({ hasText: 'Remove worktree' }).click();
    await page.waitForFunction(() => document.querySelector('#worktree-root [role="status"]')?.textContent.includes('list could not refresh'));
    assert.equal(await page.locator('#worktree-root li[data-worktree-id="fixture"]').count(), 0,
      'successful DELETE removes stale row even when the follow-up list request fails');
    assert.equal(await page.locator('#worktree-root button').filter({ hasText: 'Retry list refresh' }).count(), 1);
    await page.locator('#worktree-root button').filter({ hasText: 'Retry list refresh' }).click();
    await page.waitForFunction(() => document.querySelector('#worktree-root [role="status"]')?.textContent === 'Worktree list refreshed.');
    assert.deepEqual(await page.evaluate(() => window.worktreeState()), { worktreeGets: 3, deletes: 2 });

    await page.evaluate(() => window.mountInspectionRace());
    await page.waitForFunction(() => window.inspectionState().pending === 1);
    await page.locator('#inspection-root button').filter({ hasText: 'Inspect project' }).click();
    await page.waitForFunction(() => document.querySelector('#inspection-root [role="status"]')?.textContent.includes('Inspection ready'));
    await page.evaluate(() => window.releaseInitialRefresh());
    await page.waitForTimeout(20);
    assert.match((await page.evaluate(() => window.inspectionState())).status, /Inspection ready/,
      'an older list failure cannot overwrite the newer inspection result');
    assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join('\n')}`);
    console.log('PASS: worktree removal, list retry, and newer inspection status remain truthful');
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => {
  console.error(error);
  server.close();
  process.exitCode = 1;
});
