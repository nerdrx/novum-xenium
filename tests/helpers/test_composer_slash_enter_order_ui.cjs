const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || '/run/media/nerdrx/Lex/novum-xenium/node_modules/playwright');

const repo = path.resolve(process.env.SOURCE_ROOT || path.join(__dirname, '../..'));
const expectBaseline = process.env.EXPECT_BASELINE === '1';
const head = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const sourceFiles = [
  'static/index.html', 'static/app.js', 'static/js/chat.js',
  'static/js/slashAutocomplete.js', 'static/js/slashCommands.js',
  'scripts/build_frontend.py', 'frontend/modules.json',
];
const sourceHashes = Object.fromEntries(sourceFiles.map(file => [file,
  crypto.createHash('sha256').update(fs.readFileSync(path.join(repo, file))).digest('hex')]));
const moduleManifest = JSON.parse(fs.readFileSync(path.join(repo, 'frontend/modules.json'), 'utf8'));
const mappings = moduleManifest.modules.filter(item => ['app.js', 'js/chat.js', 'js/slashAutocomplete.js', 'js/slashCommands.js'].includes(item.deployment));
assert.deepEqual(mappings, [], 'these tested legacy/static files are not published from frontend/src by build_frontend.py');

const externalRequests = [];
const apiRequests = [];
const pageErrors = [];
const submitIntents = [];
const captureSubmit = `document.addEventListener('submit', event => {
  if (event.target?.id !== 'chat-form') return;
  const value = document.querySelector('#message')?.value ?? null;
  window.__slashEnterSubmitIntents.push({ value, defaultPreventedBeforeCapture: event.defaultPrevented });
  event.preventDefault();
  event.stopImmediatePropagation();
}, true);
window.__slashEnterSubmitIntents = [];`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return fs.createReadStream(path.join(repo, 'static/index.html')).pipe(res);
  }
  if (url.pathname.startsWith('/api/')) {
    apiRequests.push({ method: req.method, path: url.pathname });
    let data = {};
    if (url.pathname === '/api/auth/status') data = { authenticated: true, configured: true, username: 'fixture-user', is_admin: true, privileges: {} };
    else if (url.pathname === '/api/auth/settings') data = { stt_enabled: false, stt_provider: 'disabled' };
    else if (url.pathname === '/api/stt/stats') data = { provider: 'disabled', available: false };
    else if (['/api/sessions', '/api/presets/templates', '/api/tools', '/api/model-endpoints', '/api/skills/slash-catalog'].includes(url.pathname)) data = [];
    else if (url.pathname === '/api/models') data = { items: [{
      url: 'http://127.0.0.1/fixture-model', endpoint_id: 'fixture-endpoint',
      models: ['tiny-fixture-model'], models_display: ['Tiny Fixture Model'],
    }] };
    else if (url.pathname === '/api/probe-selected') data = { results: [] };
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(data));
  }
  const filename = path.resolve(repo, `.${decodeURIComponent(url.pathname)}`);
  if (!filename.startsWith(repo + path.sep) || !fs.existsSync(filename) || !fs.statSync(filename).isFile()) {
    res.writeHead(404); return res.end();
  }
  const ext = path.extname(filename);
  const type = ext === '.html' ? 'text/html; charset=utf-8'
    : ext === '.css' ? 'text/css; charset=utf-8'
    : (ext === '.js' || ext === '.mjs') ? 'text/javascript; charset=utf-8'
    : 'application/octet-stream';
  res.writeHead(200, { 'content-type': type });
  return fs.createReadStream(filename).pipe(res);
});

(async () => {
  let browser;
  let serverStarted = false;
  const contexts = [];
  const proof = {
    pass: false,
    source: { head, sha256: sourceHashes, buildFrontendMappings: mappings },
    scope: 'Actual full app + actual slash autocomplete modules; loopback API stubs; capture-phase submit sink prevents chat POST; no provider/model/account calls.',
    steps: [], apiRequests, externalRequests, pageErrors,
  };
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    serverStarted = true;
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.BROWSER_EXECUTABLE || '/opt/google/chrome/chrome',
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    const context = await browser.newContext({ serviceWorkers: 'block' });
    contexts.push(context);
    const page = await context.newPage();
    page.on('pageerror', error => pageErrors.push(error.stack || error.message));
    await page.route('**/*', route => {
      const target = new URL(route.request().url());
      if (target.origin !== origin) { externalRequests.push(target.href); return route.abort(); }
      return route.continue();
    });
    await page.addInitScript(captureSubmit);
    await page.goto(origin + '/', { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForFunction(() => window.__odysseusAppStarted === true && document.querySelector('#message'), null, { timeout: 20000 });
    await page.waitForFunction(() => !!document.querySelector('#message')?._slashAcWired, null, { timeout: 10000 });

    const input = page.locator('#message');
    await input.fill('/the');
    await page.waitForFunction(() => {
      const popup = document.querySelector('#slash-autocomplete');
      return popup && getComputedStyle(popup).display !== 'none' && [...popup.querySelectorAll('.slash-ac-row')].some(row => row.dataset.token === '/theme');
    }, null, { timeout: 3000 });
    const selectedBefore = await page.locator('#slash-autocomplete .slash-ac-row-sel').getAttribute('data-token');
    assert.equal(selectedBefore, '/theme', 'the fixture must prove the visible selected suggestion is /theme');
    if (process.env.RUN_COMPOSITION_CONTROL === '1') {
      const composition = await page.evaluate(() => {
        const input = document.querySelector('#message');
        const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, isComposing: true });
        input.dispatchEvent(event);
        return { value: input.value, popupDisplay: getComputedStyle(document.querySelector('#slash-autocomplete')).display, defaultPrevented: event.defaultPrevented, intentCount: window.__slashEnterSubmitIntents.length };
      });
      assert.equal(composition.value, '/the', 'composition Enter keeps the incomplete text');
      assert.equal(composition.popupDisplay, 'block', 'composition Enter leaves slash suggestions open');
      assert.equal(composition.defaultPrevented, false, 'composition event remains available to the browser');
      assert.equal(composition.intentCount, 0, 'composition Enter does not submit');
      proof.steps.push({ scenario: 'synthetic-composition-enter-control', ...composition });
    }
    await input.press('Enter');
    await page.waitForFunction(() => window.__slashEnterSubmitIntents.length > 0 || document.querySelector('#message')?.value === '/theme ', null, { timeout: 5000 });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const incomplete = await page.evaluate(() => ({
      intents: window.__slashEnterSubmitIntents.slice(),
      composer: document.querySelector('#message')?.value,
      selectedAfter: document.querySelector('#slash-autocomplete .slash-ac-row-sel')?.dataset.token || null,
      popupDisplay: document.querySelector('#slash-autocomplete') ? getComputedStyle(document.querySelector('#slash-autocomplete')).display : null,
    }));
    assert.deepEqual(incomplete.intents.map(item => item.value), expectBaseline ? ['/the'] : [], 'incomplete prefix Enter must accept the visible suggestion without submitting');
    assert.equal(incomplete.composer, '/theme ', 'later slash listener inserts the selected completion after send intent');
    proof.steps.push({ scenario: 'incomplete-prefix-enter', selectedBefore, ...incomplete });

    await input.fill('/theme');
    await page.waitForFunction(() => {
      const popup = document.querySelector('#slash-autocomplete');
      return popup && getComputedStyle(popup).display !== 'none' && [...popup.querySelectorAll('.slash-ac-row')].some(row => row.dataset.token === '/theme');
    }, null, { timeout: 10000 });
    assert.equal(await page.locator('#slash-autocomplete .slash-ac-row-sel').getAttribute('data-token'), '/theme');
    await input.press('Enter');
    await page.waitForFunction(() => window.__slashEnterSubmitIntents.length >= 1 || document.querySelector('#message')?.value === '/theme ', null, { timeout: 5000 });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const exact = await page.evaluate(() => ({
      intents: window.__slashEnterSubmitIntents.slice(),
      composer: document.querySelector('#message')?.value,
      popupDisplay: getComputedStyle(document.querySelector('#slash-autocomplete')).display,
    }));
    assert.deepEqual(exact.intents.map(item => item.value), expectBaseline ? ['/the', '/theme'] : ['/theme'], `exact command Enter remains a normal submit intent; state=${JSON.stringify(exact)}`);
    assert.equal(exact.composer, '/theme', 'exact command stays typed; it is not replaced with a completion');
    assert.equal(exact.popupDisplay, 'none', 'exact command hides the popup');
    proof.steps.push({ scenario: 'exact-command-enter-control', ...exact });

    await input.fill('/THEME');
    await page.waitForFunction(() => {
      const popup = document.querySelector('#slash-autocomplete');
      return popup && getComputedStyle(popup).display !== 'none' && [...popup.querySelectorAll('.slash-ac-row')].some(row => row.dataset.token === '/theme');
    }, null, { timeout: 5000 });
    const uppercaseSubmitCount = await page.evaluate(() => window.__slashEnterSubmitIntents.length);
    await input.press('Enter');
    await page.waitForFunction(count => window.__slashEnterSubmitIntents.length > count, uppercaseSubmitCount, { timeout: 5000 });
    const uppercaseExact = await page.evaluate(() => ({
      intent: window.__slashEnterSubmitIntents.at(-1),
      composer: document.querySelector('#message')?.value,
      popupDisplay: getComputedStyle(document.querySelector('#slash-autocomplete')).display,
    }));
    assert.equal(uppercaseExact.intent.value, '/THEME', 'case-insensitive slash command syntax remains a normal submit');
    assert.equal(uppercaseExact.composer, '/THEME');
    assert.equal(uppercaseExact.popupDisplay, 'none');
    proof.steps.push({ scenario: 'uppercase-exact-command-enter-control', ...uppercaseExact });

    await input.fill('/the');
    await page.waitForFunction(() => {
      const popup = document.querySelector('#slash-autocomplete');
      return popup && getComputedStyle(popup).display !== 'none' && [...popup.querySelectorAll('.slash-ac-row')].some(row => row.dataset.token === '/theme');
    }, null, { timeout: 10000 });
    assert.equal(await page.locator('#slash-autocomplete .slash-ac-row-sel').getAttribute('data-token'), '/theme');
    const tabSubmitCount = await page.evaluate(() => window.__slashEnterSubmitIntents.length);
    await input.press('Tab');
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const tab = await page.evaluate(() => ({
      intents: window.__slashEnterSubmitIntents.slice(),
      composer: document.querySelector('#message')?.value,
      popupDisplay: getComputedStyle(document.querySelector('#slash-autocomplete')).display,
    }));
    assert.equal(tab.intents.length, tabSubmitCount, 'Tab completion does not submit');
    assert.equal(tab.composer, '/theme ', 'Tab inserts the selected command');
    assert.equal(tab.popupDisplay, 'none');
    proof.steps.push({ scenario: 'tab-completion-control', ...tab });

    await input.fill('/');
    await page.waitForFunction(() => {
      const popup = document.querySelector('#slash-autocomplete');
      return popup && getComputedStyle(popup).display !== 'none' && popup.querySelectorAll('.slash-ac-row').length > 1;
    }, null, { timeout: 5000 });
    const initialSlashSelection = await page.locator('#slash-autocomplete .slash-ac-row-sel').getAttribute('data-token');
    await input.press('ArrowDown');
    const downSelection = await page.locator('#slash-autocomplete .slash-ac-row-sel').getAttribute('data-token');
    assert.notEqual(downSelection, initialSlashSelection, 'ArrowDown continues to move the selected slash item');
    await input.press('ArrowUp');
    assert.equal(await page.locator('#slash-autocomplete .slash-ac-row-sel').getAttribute('data-token'), initialSlashSelection, 'ArrowUp restores the prior selected slash item');
    await input.press('Escape');
    assert.equal(await page.locator('#slash-autocomplete').evaluate(el => getComputedStyle(el).display), 'none', 'Escape continues to dismiss slash suggestions');
    proof.steps.push({ scenario: 'slash-arrow-escape-controls', initialSlashSelection, downSelection });

    await input.fill('/new ti');
    await page.waitForFunction(() => window._ghostAutocomplete?.isActive(), null, { timeout: 5000 });
    const ghostBefore = await page.locator('#message-ghost').textContent();
    assert.match(ghostBefore, /\/new tiny-fixture-model/i, 'the fixture must expose the accepted model id in its ghost suggestion');
    const ghostSubmitCount = await page.evaluate(() => window.__slashEnterSubmitIntents.length);
    await input.press('Enter');
    await page.waitForFunction(count => window.__slashEnterSubmitIntents.length > count, ghostSubmitCount, { timeout: 5000 });
    const ghostAccepted = await page.evaluate(() => ({
      intent: window.__slashEnterSubmitIntents.at(-1),
      composer: document.querySelector('#message')?.value,
      ghostDisplay: getComputedStyle(document.querySelector('#message-ghost')).display,
    }));
    assert.equal(ghostAccepted.intent.value, '/new tiny-fixture-model', 'ghost Enter still accepts its model suggestion before submitting');
    assert.equal(ghostAccepted.composer, '/new tiny-fixture-model');
    assert.equal(ghostAccepted.ghostDisplay, 'none');
    proof.steps.push({ scenario: 'ghost-autocomplete-enter-control', ghostBefore, ...ghostAccepted });
    assert.deepEqual(externalRequests, []);
    assert.equal(apiRequests.some(request => request.path === '/api/chat_stream'), false, 'capture sink blocks real chat sends');
    assert.deepEqual(pageErrors, []);
    proof.pass = true;
    process.stdout.write(JSON.stringify(proof, null, 2) + '\n');
  } catch (error) {
    process.stderr.write(JSON.stringify({ pass: false, proof, error: error.stack || String(error) }, null, 2) + '\n');
    process.exitCode = 1;
  } finally {
    await Promise.all(contexts.map(context => context.close().catch(() => {})));
    await browser?.close().catch(() => {});
    if (serverStarted && server.closeAllConnections) server.closeAllConnections();
    if (serverStarted && server.listening) await new Promise(resolve => server.close(resolve)).catch(() => {});
  }
})().catch(error => { process.stderr.write((error.stack || String(error)) + '\n'); process.exitCode = 1; });
