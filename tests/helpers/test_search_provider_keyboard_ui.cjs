const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');
const { withAppStyles } = require('./app_styles.cjs');

const repo = path.resolve(__dirname, '../..');
const staticDir = path.join(repo, 'static');
const evidenceDir = process.env.EVIDENCE_DIR || '/tmp/novum-search-provider-keyboard';
const settingsSource = fs.readFileSync(path.join(staticDir, 'js/settings.js'), 'utf8');
const pickerStart = settingsSource.indexOf('  // ── Provider picker with logos (mirrors the hidden <select>) ──');
const pickerEnd = settingsSource.indexOf('  // ── Fallback chain ──', pickerStart);
assert(pickerStart >= 0 && pickerEnd > pickerStart, 'Found actual Search provider picker initializer');
const pickerInitializer = settingsSource.slice(pickerStart, pickerEnd);

async function main() {
  fs.mkdirSync(evidenceDir, { recursive: true });
  const html = await withAppStyles(`<!doctype html><html lang="en" class="nx-workspace"><meta charset="utf-8"><title>Search provider keyboard fixture</title>
    <!-- APP_STYLESHEET_LINKS -->
    <body class="theme-novum-xenium"><div id="settings-modal" class="modal"><section data-settings-panel="search">
      <div id="search-provider-picker" class="adm-provider-picker search-provider-picker">
        <label id="set-searchProviderLabel" for="search-provider-btn">Provider</label>
        <button id="search-provider-btn" type="button" class="adm-provider-btn" aria-labelledby="set-searchProviderLabel search-provider-name" aria-haspopup="listbox" aria-controls="search-provider-menu" aria-expanded="false"><span class="adm-provider-current"><span class="adm-provider-logo"></span><span class="adm-provider-name" id="search-provider-name">SearXNG</span></span></button>
        <div id="search-provider-menu" class="adm-provider-menu hidden" role="listbox" aria-label="Search provider"></div>
      </div>
      <select id="set-searchProvider" hidden>
        <option value="searxng" data-search-logo="searxng">SearXNG</option>
        <option value="duckduckgo" data-search-logo="duckduckgo">DuckDuckGo</option>
        <option value="brave" data-search-logo="brave">Brave Search</option>
      </select>
    </section></div><button id="outside">Outside</button>
    <script type="module">
      import { bindMenuDismiss, dismissTopEscapeLayer, _openMenuCount } from '/static/js/escMenuStack.js';
      const el = id => document.getElementById(id);
      const provSel = el('set-searchProvider');
      const _SEARCH_PROVIDER_LOGOS = { searxng: '', duckduckgo: '', brave: '' };
      let saves = 0;
      function updateVisibility() {}
      function saveSearch() { saves++; }
      document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && dismissTopEscapeLayer()) { e.stopImmediatePropagation(); e.preventDefault(); }
      }, true);
      document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && !document.getElementById('settings-modal').classList.contains('hidden')) {
          document.getElementById('settings-modal').classList.add('hidden');
        }
      }, true);
      provSel.addEventListener('change', function() { updateVisibility(); saveSearch(); _syncSearchPicker(); });
      ${pickerInitializer}
      window.fixture = { get saves() { return saves; }, get menuLayers() { return _openMenuCount(); } };
    </script></body></html>`);
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(html);
    }
    if (pathname.startsWith('/static/')) {
      const filename = path.resolve(staticDir, pathname.slice('/static/'.length));
      if (!filename.startsWith(staticDir + path.sep)) return res.writeHead(403).end();
      res.writeHead(200, { 'content-type': filename.endsWith('.css') ? 'text/css' : 'text/javascript' });
      return fs.createReadStream(filename).pipe(res);
    }
    if (pathname === '/favicon.ico') { res.writeHead(204).end(); return; }
    console.error('fixture 404', pathname);
    res.writeHead(404).end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE });
  const report = {
    scope: 'Actual Search picker initializer and shared Escape stack; fake provider options only, no app settings save/API/network.',
    stylesheetCount: (html.match(/rel="stylesheet"/g) || []).length,
    checks: [],
  };
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForTimeout(500);
    assert.equal(await page.locator('#search-provider-menu [role="option"]').count(), 3, `picker initializer errors: ${errors.join('; ')}`);
    const trigger = page.locator('#search-provider-btn');
    const menu = page.locator('#search-provider-menu');
    const option = value => page.locator(`#search-provider-menu [data-value="${value}"]`);
    assert.equal(await trigger.getAttribute('aria-haspopup'), 'listbox');
    assert.equal(await trigger.getAttribute('aria-controls'), 'search-provider-menu');
    assert.equal(await menu.getAttribute('role'), 'listbox');
    assert.equal(await option('searxng').getAttribute('tabindex'), '-1');

    await trigger.focus();
    await page.keyboard.press('Enter');
    assert.equal(await menu.isVisible(), true, 'Enter opens picker');
    assert.equal(await trigger.getAttribute('aria-expanded'), 'true');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.value), 'searxng', 'open focuses selected option');
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.value), 'duckduckgo');
    await page.keyboard.press('End');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.value), 'brave');
    await page.keyboard.press('Home');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.value), 'searxng');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('#set-searchProvider').inputValue(), 'duckduckgo');
    assert.equal(await page.evaluate(() => window.fixture.saves), 1, 'Enter selection dispatches one change/save path');
    assert.equal(await menu.isVisible(), false);
    assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'search-provider-btn');
    assert.equal(await option('duckduckgo').getAttribute('aria-selected'), 'true');
    assert.equal(await page.evaluate(() => window.fixture.menuLayers), 0, 'selection unregisters Escape layer');
    report.checks.push('Enter open, selected-option focus, ArrowUp/Down, Home/End, one Enter selection/change, expanded/selected state, focus return');

    await trigger.focus();
    await page.keyboard.press('Space');
    assert.equal(await menu.isVisible(), true, 'Space opens from native trigger');
    await page.keyboard.press('ArrowUp');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.value), 'searxng');
    await page.keyboard.press('Space');
    assert.equal(await page.locator('#set-searchProvider').inputValue(), 'searxng');
    assert.equal(await page.evaluate(() => window.fixture.saves), 2, 'Space selection dispatches one change/save path');
    report.checks.push('Space opens trigger and selects focused option exactly once');

    await trigger.focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Escape');
    assert.equal(await menu.isVisible(), false, 'Escape closes through shared stack');
    assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'search-provider-btn', 'Escape returns focus to trigger');
    assert.equal(await page.evaluate(() => window.fixture.menuLayers), 0, 'Escape unregisters layer');
    assert.equal(await page.locator('#settings-modal').isVisible(), true, 'Escape leaves Settings open');
    report.checks.push('Escape stack closes picker first and preserves Settings modal');

    await trigger.focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Tab');
    assert.equal(await menu.isVisible(), false, 'Tab closes picker');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'outside', 'Tab continues normal tab order');
    assert.equal(await page.evaluate(() => window.fixture.menuLayers), 0, 'Tab unregisters layer');
    report.checks.push('Tab closes and continues to the next normal control');

    await trigger.focus();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(5);
    await page.locator('#outside').click();
    assert.equal(await menu.isVisible(), false, 'click-away closes picker');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'outside', 'click-away does not steal focus');
    assert.equal(await page.evaluate(() => window.fixture.saves), 2, 'open/close paths do not save settings');
    assert.equal(await page.evaluate(() => window.fixture.menuLayers), 0, 'click-away unregisters layer');
    report.checks.push('click-away closes without focus theft or settings save');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#settings-modal').isVisible(), false, 'next Escape reaches modal fallback');
    report.checks.push('subsequent Escape reaches the Settings fallback after picker dismissal');
    assert.deepEqual(errors, [], `page errors: ${errors.join('; ')}`);
    report.pageErrors = errors;
    fs.writeFileSync(path.join(evidenceDir, 'search-provider-keyboard-results.json'), JSON.stringify(report, null, 2));
    console.log(`PASS Search provider keyboard flow: ${report.checks.length} scenarios`);
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
