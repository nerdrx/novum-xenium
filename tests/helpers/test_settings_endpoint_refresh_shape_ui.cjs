// Keep settings endpoint refresh behavior on the real module and synthetic loopback only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');
const repo = path.resolve(__dirname, '../..');
const sourcePath = path.join(repo, 'static/js/settings.js');
const source = fs.readFileSync(sourcePath, 'utf8');
const publicMarker = '/* ═══════════════════════════════════════════\n   PUBLIC API';
assert(source.includes(publicMarker), 'actual settings module API marker exists');
const html = `<!doctype html><meta charset="utf-8"><body>
<select id="set-defaultEpSelect"></select><select id="set-defaultModelSelect"></select><div id="set-defaultChatMsg"></div>
<input id="set-teacherEnabledToggle" type="checkbox"><select id="set-teacherEpSelect"><option value="">Same as chat</option></select>
<select id="set-teacherModelSelect"><option value="">Same as chat</option></select><div id="set-teacherChatMsg"></div>
<script type="module">
  await import('/static/js/settings.js');
  await window.__pass350Settings.initDefaultChat();
  await window.__pass350Settings.initTeacherModel();
  window.fixtureReady = true;
</script></body>`;
const endpoints = [
  { id: 'ep-a', name: 'Fixture', is_enabled: true, online: true, models: ['model-a'] },
];
let responses = [];
let endpointRequests = 0;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const sendJson = (value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
  if (url.pathname === '/') return res.end(html);
  if (url.pathname === '/api/auth/settings') return sendJson({
    default_endpoint_id: 'ep-a', default_model: 'model-a', teacher_enabled: true, teacher_model: 'model-a@Fixture',
  });
  if (url.pathname === '/api/model-endpoints' && req.method === 'GET') {
    endpointRequests++;
    const plan = responses.shift() || { payload: endpoints };
    res.writeHead(plan.status || 200, { 'Content-Type': 'application/json' });
    return res.end(plan.raw !== undefined ? plan.raw : JSON.stringify(plan.payload));
  }
  if (url.pathname === '/__plan' && req.method === 'POST') {
    let body = ''; req.on('data', chunk => { body += chunk; });
    req.on('end', () => { responses.push(...JSON.parse(body)); res.writeHead(204); res.end(); });
    return;
  }
  if (url.pathname === '/__state') return sendJson({ endpointRequests });
  const file = path.resolve(repo, `.${url.pathname}`);
  if (!file.startsWith(repo + path.sep) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
  res.setHeader('Content-Type', file.endsWith('.js') || file.endsWith('.mjs') ? 'text/javascript' : 'text/plain');
  if (url.pathname === '/static/js/settings.js') {
    const hooked = source.replace(publicMarker,
      `window.__pass350Settings = { initDefaultChat, initTeacherModel, refreshAiModelEndpoints };\n${publicMarker}`);
    return res.end(hooked);
  }
  fs.createReadStream(file).pipe(res);
});
const ids = ['set-defaultEpSelect', 'set-defaultModelSelect', 'set-teacherEpSelect', 'set-teacherModelSelect'];
const selectedValues = page => page.evaluate(() => ['set-defaultEpSelect','set-defaultModelSelect','set-teacherEpSelect','set-teacherModelSelect']
  .map(id => document.getElementById(id).value));
(async () => {
  let browser;
  const externalRequests = [];
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined, args: ['--no-sandbox', '--disable-gpu'] });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const run = async refreshResponse => {
      responses = [{ payload: endpoints }, { payload: endpoints }];
      endpointRequests = 0;
      const page = await browser.newPage(); page.setDefaultTimeout(5000);
      const errors = [];
      page.on('pageerror', error => errors.push(error.stack || error.message));
      await page.route('**/*', route => {
        const url = new URL(route.request().url());
        if ((url.protocol === 'http:' || url.protocol === 'https:') && url.origin !== origin) {
          externalRequests.push(url.href); return route.abort();
        }
        return route.continue();
      });
      await page.goto(origin);
      await page.waitForFunction(() => window.fixtureReady === true);
      assert.deepEqual(await selectedValues(page), ['ep-a', 'model-a', 'ep-a', 'model-a'], 'normal hydration populates both real settings pickers');
      await page.evaluate(plan => fetch('/__plan', { method: 'POST', body: JSON.stringify([plan]) }), refreshResponse);
      await page.evaluate(() => window.__pass350Settings.refreshAiModelEndpoints());
      const values = await selectedValues(page);
      const counts = await page.evaluate(() => ['set-defaultEpSelect','set-defaultModelSelect','set-teacherEpSelect','set-teacherModelSelect']
        .map(id => document.getElementById(id).options.length));
      const requestCount = endpointRequests;
      assert.deepEqual(errors, [], `page errors: ${errors.join('\n')}`);
      await page.close();
      return { values, counts, requestCount };
    };
    const malformedObject = await run({ payload: {} });
    assert.deepEqual(malformedObject.values, ['ep-a', 'model-a', 'ep-a', 'model-a'], 'malformed top-level object does not clear endpoint/model choices');
    assert.deepEqual(malformedObject.counts, [1, 1, 2, 2]);
    const malformedJson = await run({ raw: '{not json' });
    assert.deepEqual(malformedJson.values, ['ep-a', 'model-a', 'ep-a', 'model-a'], 'invalid JSON does not clear endpoint/model choices');
    const unavailable = await run({ status: 503, payload: { detail: 'synthetic outage' } });
    assert.deepEqual(unavailable.values, ['ep-a', 'model-a', 'ep-a', 'model-a'], 'HTTP 503 does not clear endpoint/model choices');
    const validEmpty = await run({ payload: [] });
    assert.deepEqual(validEmpty.values, ['', '', '', ''], 'valid empty array still clears selections');
    assert.deepEqual(validEmpty.counts, [0, 0, 1, 1]);
    const populated = await run({ payload: [...endpoints, { id:'ep-b', name:'Second', is_enabled:true, online:true, models:['model-b'] }] });
    assert.deepEqual(populated.values, ['ep-a','model-a','ep-a','model-a'], 'normal populated refresh preserves current endpoint/model choices');
    assert.deepEqual(populated.counts, [2,1,3,2], 'normal refresh adds the new endpoint/model option');
    assert(externalRequests.length === 0, `blocked external requests: ${externalRequests.join(', ')}`);
    console.log(JSON.stringify({
      result: 'PASS: malformed endpoint inventory preserves selections; valid empty inventory clears them',
      sourceSha256: require('node:crypto').createHash('sha256').update(source).digest('hex'),
      scenarios: { malformedObject, malformedJson, unavailable, validEmpty, populated },
      externalRequests,
    }, null, 2));
  } finally {
    if (browser) await browser.close();
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); server.closeAllConnections?.(); server.close(); process.exitCode = 1; });
