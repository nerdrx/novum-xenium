const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE);

const root = path.resolve(__dirname, '../..');
const staticRoot = path.join(root, 'static');
const activeError = {
  id: 'fixture-error', query: 'saved job query', status: 'error', errorMsg: 'fixture error', category: 'howto',
  settings: { endpoint_id: 'endpoint-b', model: 'model-b', max_rounds: 4, search_provider: 'brave' },
};
const newerError = {
  id: 'fixture-error-newer', query: 'newer saved job query', status: 'error', errorMsg: 'fixture error', category: 'comparison',
  settings: { endpoint_id: 'endpoint-a', model: 'model-a2', max_rounds: 2, search_provider: 'tavily' },
};
let settingsBodyGate = null;
const server = http.createServer((req, res) => {
  const requestPath = new URL(req.url, 'http://127.0.0.1').pathname;
  if (requestPath === '/api/auth/settings' && settingsBodyGate) {
    const gate = settingsBodyGate;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.flushHeaders();
    gate.signal();
    gate.released.then(() => res.end(JSON.stringify({ research_endpoint_id: 'endpoint-a', research_model: 'model-a' })));
    return;
  }
  if (requestPath === '/fixture.html') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><meta charset="utf-8"><button id="tool-research-btn"></button><div id="chat-container"></div><script type="module">import * as panel from "/static/js/research/panel.js"; import * as jobs from "/static/js/research/jobs.js?v=20261007quality1"; window.__panel=panel; window.__jobs=jobs; panel.init("",null,null); panel.openPanel();</script>');
    return;
  }
  if (!requestPath.startsWith('/static/')) { res.writeHead(404).end(); return; }
  const file = path.resolve(root, `.${requestPath}`);
  if (!file.startsWith(staticRoot + path.sep)) { res.writeHead(403).end(); return; }
  const ext = path.extname(file);
  res.writeHead(200, { 'content-type': ext === '.js' ? 'text/javascript' : 'application/octet-stream' });
  fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
});

function hold() {
  let seenResolve;
  let releaseResolve;
  let finishedResolve;
  const seen = new Promise(resolve => { seenResolve = resolve; });
  const released = new Promise(resolve => { releaseResolve = resolve; });
  const finished = new Promise(resolve => { finishedResolve = resolve; });
  return { seen, signal: seenResolve, release: releaseResolve, released, finished, finish: finishedResolve };
}

async function runCase(browser, origin, { name, holdSettings = false, holdSettingsBody = false, holdEndpoints = false, queueBeforeEndpointRelease = false, failEndpoints = false, editJob = false, secondJobEdit = false, aba = false, defaultControl = false, closeReopen = false }) {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const external = [];
  const unexpected = [];
  const errors = [];
  let endpointLoads = 0;
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => {
    if (message.type() === 'error' && !(failEndpoints && message.text().includes('503'))) errors.push(message.text());
  });
  if (editJob || failEndpoints) await context.addInitScript(({ jobs: savedJobs, settings }) => {
    if (savedJobs.length) localStorage.setItem('odysseus-research-errors', JSON.stringify(savedJobs));
    if (settings) localStorage.setItem('odysseus-research-settings', JSON.stringify(settings));
  }, { jobs: editJob ? (secondJobEdit ? [activeError, newerError] : [activeError]) : [], settings: holdEndpoints ? { category: 'comparison', search_provider: 'tavily' } : failEndpoints ? { category: 'comparison', search_provider: 'tavily', endpoint_id: 'missing-endpoint', model: 'missing-model' } : null });
  await context.addInitScript(() => {
    const fetchOriginal = window.fetch.bind(window);
    window.__fixtureJsonCompletion = {};
    window.__fixtureFetchCompletion = {};
    window.fetch = async (...args) => {
      const response = await fetchOriginal(...args);
      const pathname = new URL(args[0], window.location.href).pathname;
      if (pathname === '/api/auth/settings' || pathname === '/api/model-endpoints') {
        window.__fixtureFetchCompletion[pathname] = (window.__fixtureFetchCompletion[pathname] || 0) + 1;
        const jsonOriginal = response.json.bind(response);
        response.json = async (...jsonArgs) => {
          const value = await jsonOriginal(...jsonArgs);
          window.__fixtureJsonCompletion[pathname] = (window.__fixtureJsonCompletion[pathname] || 0) + 1;
          return value;
        };
      }
      return response;
    };
  });
  const settingsGate = holdSettings ? hold() : null;
  const bodyGate = holdSettingsBody ? hold() : null;
  const endpointsGate = closeReopen ? hold() : null;
  const endpointLoadGate = holdEndpoints ? hold() : null;
  if (bodyGate) settingsBodyGate = bodyGate;

  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) {
      external.push(url.href);
      await route.abort('blockedbyclient');
    } else if (url.pathname === '/fixture.html' || url.pathname.startsWith('/static/')) {
      await route.continue();
    } else if (url.pathname === '/api/model-endpoints') {
      if (failEndpoints) { await route.fulfill({ status: 503, body: 'synthetic endpoint failure' }); return; }
      const endpointLoadId = ++endpointLoads;
      if (endpointsGate && endpointLoadId === 1) { endpointsGate.signal(); await endpointsGate.released; }
      if (endpointLoadGate) { endpointLoadGate.signal(); await endpointLoadGate.released; }
      await route.fulfill({ json: [
        { id: 'endpoint-a', name: 'Endpoint A', base_url: 'fixture://a', is_enabled: true, model_type: 'llm', models: ['model-a', 'model-a2'] },
        { id: 'endpoint-b', name: 'Endpoint B', base_url: 'fixture://b', is_enabled: true, model_type: 'llm', models: ['model-b'] },
      ] });
      if (endpointsGate && endpointLoadId === 1) endpointsGate.finish();
      endpointLoadGate?.finish();
    } else if (url.pathname === '/api/auth/settings') {
      if (bodyGate) { await route.continue(); return; }
      if (settingsGate) { settingsGate.signal(); await settingsGate.released; }
      await route.fulfill({ json: { research_endpoint_id: 'endpoint-a', research_model: 'model-a' } });
    } else if (url.pathname === '/api/research/active') {
      await route.fulfill({ json: { active: [] } });
    } else if (url.pathname === '/api/research/library') {
      await route.fulfill({ json: { items: [] } });
    } else if (url.pathname === '/api/prefs/theme') {
      await route.fulfill({ json: {} });
    } else if (url.pathname === '/api/prefs/custom-themes') {
      await route.fulfill({ json: [] });
    } else {
      unexpected.push(url.href);
      await route.fulfill({ status: 404, body: 'unconfigured fixture request' });
    }
  });

  await page.goto(`${origin}/fixture.html`, { waitUntil: 'domcontentloaded' });
  if (closeReopen) {
    await endpointsGate.seen;
    await page.evaluate(() => { window.__panel.closePanel(); window.__panel.openPanel(); });
    await page.waitForFunction(() => window.__fixtureJsonCompletion['/api/model-endpoints'] === 1);
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 0)));
    await page.waitForFunction(() => !!document.querySelector('#research-endpoint option[value="endpoint-b"]'));
    await page.waitForFunction(() => document.querySelector('#research-model').value === 'model-a');
    endpointsGate.release();
    await endpointsGate.finished;
    await page.waitForFunction(() => window.__fixtureFetchCompletion['/api/model-endpoints'] === 2);
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 0)));
    const outcome = await page.evaluate(() => ({
      endpointACount: document.querySelectorAll('#research-endpoint option[value="endpoint-a"]').length,
      endpointBCount: document.querySelectorAll('#research-endpoint option[value="endpoint-b"]').length,
      modelACount: document.querySelectorAll('#research-model option[value="model-a"]').length,
      modelBCount: document.querySelectorAll('#research-model option[value="model-b"]').length,
      selection: { endpoint: document.querySelector('#research-endpoint').value, model: document.querySelector('#research-model').value },
    }));
    settingsBodyGate = null;
    const result = { name, ...outcome, blockedExternalCount: external.length, unexpectedFixtureCount: unexpected.length, pageErrorCount: errors.length };
    await context.close();
    return result;
  }
  if (failEndpoints) {
    await page.waitForFunction(() => window.__fixtureFetchCompletion['/api/model-endpoints'] === 1);
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 0)));
    const outcome = await page.evaluate(() => ({
      endpoint: document.querySelector('#research-endpoint').value,
      model: document.querySelector('#research-model').value,
      category: document.querySelector('#research-category').value,
      searchProvider: document.querySelector('#research-search-provider').value,
      endpointOptionCount: document.querySelectorAll('#research-endpoint option').length,
      modelOptionCount: document.querySelectorAll('#research-model option').length,
      settingsFetchCount: window.__fixtureFetchCompletion['/api/auth/settings'] || 0,
    }));
    const result = { name, ...outcome, blockedExternalCount: external.length, unexpectedFixtureCount: unexpected.length, pageErrorCount: errors.length };
    await context.close();
    return result;
  }
  if (endpointLoadGate) await endpointLoadGate.seen;
  else await page.waitForFunction(() => !!document.querySelector('#research-endpoint option[value="endpoint-b"]'));
  if (settingsGate) await settingsGate.seen;
  else if (bodyGate) await bodyGate.seen;
  else if (endpointLoadGate) {
    // The endpoint response is held, so the settings fetch starts after it is released.
  }
  else await page.waitForFunction(() => document.querySelector('#research-endpoint').value === 'endpoint-a');

  if (editJob) {
    await page.locator('[data-research-tab="history"]').click();
    await page.locator('[data-job-id="fixture-error"] [data-action="edit"]').click();
    if (secondJobEdit) {
      await page.locator('[data-job-id="fixture-error-newer"] [data-action="edit"]').click();
    }
  } else if (!defaultControl) {
    await page.locator('#research-endpoint').selectOption('endpoint-b');
    await page.locator('#research-endpoint').dispatchEvent('change');
    await page.locator('#research-model').selectOption('model-b');
    await page.locator('#research-model').dispatchEvent('change');
    if (aba) {
      await page.locator('#research-endpoint').selectOption('endpoint-a');
      await page.locator('#research-endpoint').dispatchEvent('change');
      await page.locator('#research-model').selectOption('model-a2');
      await page.locator('#research-model').dispatchEvent('change');
    }
  }

  if (queueBeforeEndpointRelease) {
    await page.locator('[data-research-tab="research"]').click();
    await page.locator('#research-add-btn').click();
    const queuedBeforeEndpointRelease = await page.evaluate(() => window.__jobs.getJobs().find(job => job.status === 'queued')?.settings || null);
    const catalogOptionCountsBeforeRelease = await page.evaluate(() => ({
      endpoints: document.querySelectorAll('#research-endpoint option').length,
      models: document.querySelectorAll('#research-model option').length,
    }));
    endpointLoadGate.release();
    await page.waitForFunction(() => window.__fixtureJsonCompletion['/api/model-endpoints'] === 1);
    await endpointLoadGate.finished;
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 0)));
    const result = { name, queuedBeforeEndpointRelease, catalogOptionCountsBeforeRelease, blockedExternalCount: external.length, unexpectedFixtureCount: unexpected.length, pageErrorCount: errors.length };
    await context.close();
    return result;
  }

  if (endpointLoadGate) {
    endpointLoadGate.release();
    await page.waitForFunction(() => window.__fixtureJsonCompletion['/api/model-endpoints'] === 1);
    await endpointLoadGate.finished;
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 0)));
    await page.waitForFunction(() => !!document.querySelector('#research-endpoint option[value="endpoint-b"]'));
  }

  const beforeRelease = await page.evaluate(() => ({
    endpoint: document.querySelector('#research-endpoint').value,
    model: document.querySelector('#research-model').value,
    query: document.querySelector('#research-query').value,
  }));
  settingsGate?.release();
  bodyGate?.release();
  const expected = holdEndpoints && editJob ? (secondJobEdit ? ['endpoint-a', 'model-a2'] : ['endpoint-b', 'model-b']) : holdEndpoints ? ['', ''] : defaultControl ? ['endpoint-a', 'model-a'] : editJob ? ['endpoint-b', 'model-b'] : aba ? ['endpoint-a', 'model-a2'] : ['endpoint-b', 'model-b'];
  if (settingsGate || bodyGate) {
    await page.waitForFunction(() => window.__fixtureJsonCompletion['/api/auth/settings'] === 1);
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 0)));
  }
  await page.waitForFunction(([endpoint, model]) => {
    const ep = document.querySelector('#research-endpoint');
    const md = document.querySelector('#research-model');
    return ep.value === endpoint && md.value === model;
  }, expected);
  if (!defaultControl) {
    if (editJob) await page.locator('[data-research-tab="research"]').click();
    else await page.locator('#research-query').fill('synthetic fixture question');
    await page.locator('#research-add-btn').click();
  }
  const result = await page.evaluate(() => ({
    selection: {
      endpoint: document.querySelector('#research-endpoint').value,
      model: document.querySelector('#research-model').value,
    },
    queued: window.__jobs.getJobs().find(job => job.status === 'queued')?.settings || null,
    queuedQuery: window.__jobs.getJobs().find(job => job.status === 'queued')?.query || null,
  }));
  const outcome = {
    name, beforeRelease, ...result,
    heldResponseBody: !!bodyGate,
    restoredCategory: await page.locator('#research-category').inputValue(),
    restoredSearchProvider: await page.locator('#research-search-provider').inputValue(),
    blockedExternalCount: external.length,
    unexpectedFixtureCount: unexpected.length,
    pageErrorCount: errors.length,
  };
  await context.close();
  if (bodyGate) settingsBodyGate = null;
  return outcome;
}

(async () => {
  if (!process.env.BROWSER_EXECUTABLE || !process.env.PLAYWRIGHT_PACKAGE) throw new Error('Set BROWSER_EXECUTABLE and PLAYWRIGHT_PACKAGE');
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE, headless: true, args: ['--no-sandbox'] });
    const results = [
      await runCase(browser, origin, { name: 'defaultRestore', defaultControl: true }),
      await runCase(browser, origin, { name: 'heldUserSelection', holdSettings: true }),
      await runCase(browser, origin, { name: 'heldResponseBody', holdSettingsBody: true }),
      await runCase(browser, origin, { name: 'heldSelectionAba', holdSettings: true, aba: true }),
      await runCase(browser, origin, { name: 'heldJobEdit', holdSettings: true, editJob: true }),
      await runCase(browser, origin, { name: 'heldEndpointLoadEdit', holdEndpoints: true, editJob: true }),
      await runCase(browser, origin, { name: 'heldEndpointLoadNewerJobEdit', holdEndpoints: true, editJob: true, secondJobEdit: true }),
      await runCase(browser, origin, { name: 'queueEditedJobBeforeEndpointRelease', holdEndpoints: true, editJob: true, queueBeforeEndpointRelease: true }),
      await runCase(browser, origin, { name: 'closeReopenDropsOldEndpointResponse', closeReopen: true }),
      await runCase(browser, origin, { name: 'endpointHttpFailureRestoresLocalSettings', failEndpoints: true }),
    ];
    const queuedSettingsAre = (item, endpoint, model) =>
      item.queued?.endpoint_id === endpoint && item.queued?.model === model;
    const pass = results.every(item => !item.blockedExternalCount && !item.unexpectedFixtureCount && !item.pageErrorCount)
      && results[0].selection.endpoint === 'endpoint-a'
      && results[0].selection.model === 'model-a'
      && results[1].selection.endpoint === 'endpoint-b'
      && results[1].selection.model === 'model-b'
      && queuedSettingsAre(results[1], 'endpoint-b', 'model-b')
      && results[2].heldResponseBody
      && results[2].selection.endpoint === 'endpoint-b'
      && results[2].selection.model === 'model-b'
      && queuedSettingsAre(results[2], 'endpoint-b', 'model-b')
      && results[3].selection.endpoint === 'endpoint-a'
      && results[3].selection.model === 'model-a2'
      && queuedSettingsAre(results[3], 'endpoint-a', 'model-a2')
      && results[4].selection.endpoint === 'endpoint-b'
      && results[4].selection.model === 'model-b'
      && queuedSettingsAre(results[4], 'endpoint-b', 'model-b')
      && results[4].queued?.max_rounds === 4
      && results[4].queued?.category === 'howto'
      && results[4].queued?.search_provider === 'brave'
      && results[4].queuedQuery === 'saved job query'
      && results[5].restoredCategory === 'howto'
      && results[5].restoredSearchProvider === 'brave'
      && results[5].selection.endpoint === 'endpoint-b'
      && results[5].selection.model === 'model-b'
      && queuedSettingsAre(results[5], 'endpoint-b', 'model-b')
      && results[5].queued?.category === 'howto'
      && results[5].queued?.search_provider === 'brave'
      && results[5].queuedQuery === 'saved job query'
      && results[6].selection.endpoint === 'endpoint-a'
      && results[6].selection.model === 'model-a2'
      && queuedSettingsAre(results[6], 'endpoint-a', 'model-a2')
      && results[6].queued?.category === 'comparison'
      && results[6].queued?.search_provider === 'tavily'
      && results[6].queued?.max_rounds === 2
      && results[6].queuedQuery === 'newer saved job query'
      && results[7].queuedBeforeEndpointRelease?.endpoint_id === 'endpoint-b'
      && results[7].queuedBeforeEndpointRelease?.model === 'model-b'
      && results[7].queuedBeforeEndpointRelease?.category === 'howto'
      && results[7].queuedBeforeEndpointRelease?.search_provider === 'brave'
      && results[7].catalogOptionCountsBeforeRelease?.endpoints === 1
      && results[7].catalogOptionCountsBeforeRelease?.models === 1
      && results[8].endpointACount === 1
      && results[8].endpointBCount === 1
      && results[8].modelACount === 1
      && results[8].modelBCount === 1
      && results[9].category === 'comparison'
      && results[9].searchProvider === 'tavily'
      && results[9].endpoint === ''
      && results[9].model === ''
      && results[9].endpointOptionCount === 1
      && results[9].modelOptionCount === 1
      && results[9].settingsFetchCount === 0;
    process.stdout.write(JSON.stringify({ mode: 'research-settings-intent-ownership', pass, loopbackOnly: true, results }, null, 2) + '\n');
    if (!pass) process.exitCode = 1;
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
