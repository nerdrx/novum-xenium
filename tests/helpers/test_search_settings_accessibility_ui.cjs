const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');
const { withAppStyles } = require('./app_styles.cjs');

const repo = path.resolve(__dirname, '../..');
const staticDir = path.join(repo, 'static');
const evidenceDir = process.env.EVIDENCE_DIR || '/tmp/novum-search-settings-accessibility';
const targets = [
  ['set-searchResultCount', 'Results per query'], ['set-searchUrl', 'URL'],
  ['set-searchApiKey', 'API Key'], ['set-searchCx', 'CX ID'],
  ['set-researchSearch', 'Search'], ['set-researchMaxTokens', 'Max Tokens'],
  ['set-researchExtractTimeout', 'Extract Timeout'],
  ['set-researchExtractConcurrency', 'Extract Parallel'], ['set-researchRunTimeout', 'Timeout'],
];

const index = fs.readFileSync(path.join(staticDir, 'index.html'), 'utf8');
const settingsStart = index.indexOf('<div id="settings-modal" class="modal hidden">');
const searchEnd = index.indexOf('<!-- ═══ APPEARANCE TAB', settingsStart);
assert(settingsStart >= 0 && searchEnd > settingsStart, 'Settings shell and Search panel boundaries found');
const shell = index.slice(settingsStart, searchEnd)
  .replace('id="settings-modal" class="modal hidden"', 'id="settings-modal" class="modal"')
  .replace('data-settings-panel="search" class="hidden"', 'data-settings-panel="search"');

async function fixtureHtml() {
  return withAppStyles(`<!doctype html><html lang="en" class="nx-workspace"><meta charset="utf-8"><title>Search settings fixture</title>
    <!-- APP_STYLESHEET_LINKS -->
    <body class="theme-novum-xenium">${shell}</div></div></div></div></body></html>`);
}

async function main() {
  fs.mkdirSync(evidenceDir, { recursive: true });
  const html = await fixtureHtml();
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(html);
    }
    if (pathname.startsWith('/static/')) {
      const filename = path.resolve(staticDir, pathname.slice('/static/'.length));
      if (!filename.startsWith(staticDir + path.sep)) return res.writeHead(403).end();
      res.writeHead(200, { 'content-type': filename.endsWith('.css') ? 'text/css' : 'application/octet-stream' });
      return fs.createReadStream(filename).pipe(res);
    }
    res.writeHead(404).end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE });
  const report = {
    stylesheetCount: (html.match(/rel="stylesheet"/g) || []).length,
    scope: 'Synthetic Search/Deep Research controls only; no API, settings writes, credentials, or research execution.',
    viewports: [],
  };
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.locator('[data-settings-panel="search"] .admin-card').first().waitFor();
    await page.waitForTimeout(260);

    for (const viewport of [
      { width: 320, height: 720 }, { width: 390, height: 844 },
      { width: 600, height: 320 }, { width: 1280, height: 900 },
    ]) {
      await page.setViewportSize(viewport);
      await page.waitForTimeout(220);
      await page.evaluate(() => document.fonts.ready);
      await page.evaluate(() => {
        document.getElementById('search-provider-name').textContent = 'Synthetic Search';
        document.getElementById('set-searchResultCountCustom').style.display = 'block';
        document.getElementById('set-searchKeyRow').style.display = 'flex';
        document.getElementById('set-searchCxRow').style.display = 'flex';
      });
      if (viewport.width <= 768) await page.screenshot({ path: path.join(evidenceDir, `search-settings-${viewport.width}x${viewport.height}-top.png`) });
      const metrics = await page.evaluate(async targets => {
        const panel = document.querySelector('[data-settings-panel="search"]');
        document.getElementById('search-provider-name').textContent = 'Synthetic Search';
        document.getElementById('set-searchResultCountCustom').style.display = 'block';
        document.getElementById('set-searchKeyRow').style.display = 'flex';
        document.getElementById('set-searchCxRow').style.display = 'flex';
        const providerLabel = document.getElementById('set-searchProviderLabel');
        const providerButton = document.getElementById('search-provider-btn');
        if (providerLabel.control !== providerButton) throw new Error('Provider label is not associated with its custom button');
        providerLabel.click();
        if (document.activeElement !== providerButton) throw new Error('Provider label click did not focus its custom button');
        const controls = [];
        for (const [id, labelText] of targets) {
          const control = document.getElementById(id);
          const labels = [...control.labels];
          if (labels.length !== 1 || labels[0].textContent.trim() !== labelText) throw new Error(`${id} label association mismatch`);
          labels[0].click();
          if (document.activeElement !== control) throw new Error(`${id} label click did not focus its control`);
          const rect = control.getBoundingClientRect();
          const labelRect = labels[0].getBoundingClientRect();
          const row = control.closest('.settings-row');
          const rowRect = row.getBoundingClientRect();
          const overlap = labelRect.left < rect.right && labelRect.right > rect.left && labelRect.top < rect.bottom && labelRect.bottom > rect.top;
          if (overlap || rect.left < rowRect.left - 1 || rect.right > rowRect.right + 1) throw new Error(`${id} overlaps its label or escapes its row: ${JSON.stringify({ rect: {left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom}, labelRect:{left:labelRect.left,right:labelRect.right,top:labelRect.top,bottom:labelRect.bottom}, rowRect:{left:rowRect.left,right:rowRect.right} })}`);
          controls.push({ id, label: labelText, width: rect.width, height: rect.height, rowWidth: rowRect.width });
        }
        const customCount = document.getElementById('set-searchResultCountCustom');
        const customCountRect = customCount.getBoundingClientRect();
        if (customCount.getAttribute('aria-label') !== 'Custom results per query') throw new Error('Custom result count has no clear name');
        const customCountRow = customCount.closest('.settings-row').getBoundingClientRect();
        if (customCountRect.left < customCountRow.left - 1 || customCountRect.right > customCountRow.right + 1) throw new Error('Custom result count escapes its row');
        controls.push({ id: customCount.id, label: customCount.getAttribute('aria-label'), width: customCountRect.width, height: customCountRect.height });
        const actionControls = ['search-provider-btn', 'set-searchTestBtn', 'set-searchAddFallback'].map(id => {
          const element = document.getElementById(id), rect = element.getBoundingClientRect();
          return { id, width: rect.width, height: rect.height, top: rect.top, bottom: rect.bottom };
        });
        const providerRect = document.getElementById('search-provider-btn').getBoundingClientRect();
        const testRect = document.getElementById('set-searchTestBtn').getBoundingClientRect();
        const providerRow = document.getElementById('search-provider-btn').closest('.settings-row').getBoundingClientRect();
        const providerLabelRect = providerLabel.getBoundingClientRect();
        const intersects = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
        if (intersects(providerRect, testRect) || intersects(providerLabelRect, providerRect) || intersects(providerLabelRect, testRect)
            || providerRect.left < providerRow.left - 1 || providerRect.right > providerRow.right + 1
            || testRect.left < providerRow.left - 1 || testRect.right > providerRow.right + 1) {
          throw new Error(`Provider/Test controls overlap or escape their row: ${JSON.stringify({providerRect, testRect, providerLabelRect, providerRow})}`);
        }
        const panels = document.querySelector('.settings-panels');
        panels.scrollTop = panels.scrollHeight;
        const final = document.getElementById('set-researchRunTimeout');
        final.scrollIntoView({ block: 'nearest' });
        const finalRect = final.getBoundingClientRect();
        return {
          viewport: { width: innerWidth, height: innerHeight },
          documentWidth: document.documentElement.scrollWidth,
          controls, actionControls,
          providerNameIncludesValue: providerButton.getAttribute('aria-labelledby') === 'set-searchProviderLabel search-provider-name',
          providerRowAlignment: {
            rowRect: {left:providerRow.left,right:providerRow.right,top:providerRow.top,bottom:providerRow.bottom,width:providerRow.width},
            providerRect: {top:providerRect.top,bottom:providerRect.bottom,height:providerRect.height},
            testRect: {top:testRect.top,bottom:testRect.bottom,height:testRect.height},
            labelRect: {top:providerLabel.getBoundingClientRect().top,bottom:providerLabel.getBoundingClientRect().bottom},
            pickerRect: (()=>{const r=document.getElementById('search-provider-picker').getBoundingClientRect();return {top:r.top,bottom:r.bottom,height:r.height}})(),
            providerTop: getComputedStyle(document.getElementById('search-provider-picker')).top,
            testTop: getComputedStyle(document.getElementById('set-searchTestBtn')).top,
            providerCenterY: (providerRect.top + providerRect.bottom) / 2,
            testCenterY: (testRect.top + testRect.bottom) / 2,
            labelCenterY: (providerLabel.getBoundingClientRect().top + providerLabel.getBoundingClientRect().bottom) / 2,
            rowCenterY: (providerRow.top + providerRow.bottom) / 2,
          },
          panel: { top: panels.getBoundingClientRect().top, bottom: panels.getBoundingClientRect().bottom,
            scrollTop: panels.scrollTop, scrollHeight: panels.scrollHeight, clientHeight: panels.clientHeight },
          finalControlIntersectsViewport: finalRect.bottom > 0 && finalRect.top < innerHeight,
        };
      }, targets);
      const providerSnapshot = await page.locator('#search-provider-btn').ariaSnapshot();
      const customCountSnapshot = await page.locator('#set-searchResultCountCustom').ariaSnapshot();
      assert.match(providerSnapshot, /button "Provider Synthetic Search"/);
      assert.match(customCountSnapshot, /spinbutton "Custom results per query"/);
      metrics.providerAccessibleName = providerSnapshot;
      metrics.customCountAccessibleName = customCountSnapshot;
      assert.equal(metrics.documentWidth, viewport.width, `horizontal overflow at ${viewport.width}`);
      assert(metrics.finalControlIntersectsViewport, `Deep Research final field is unreachable at ${viewport.width}`);
      if (viewport.width <= 768) {
        for (const control of [...metrics.controls, ...metrics.actionControls]) {
          assert(control.height >= 44, `${control.id} is ${control.height}px at ${viewport.width}`);
        }
        const alignment = metrics.providerRowAlignment;
        assert(Math.abs(alignment.providerCenterY - alignment.testCenterY) <= 1, `Provider and Test buttons are not centered together: ${JSON.stringify(alignment)}`);
        assert(Math.abs(alignment.providerCenterY - alignment.labelCenterY) <= 1, `Provider and its label are not centered together: ${JSON.stringify(alignment)}`);
      } else {
        for (const control of [...metrics.controls, ...metrics.actionControls]) {
          assert(control.height <= 36, `${control.id} desktop size changed to ${control.height}px`);
        }
      }
      if (viewport.width <= 768) await page.screenshot({ path: path.join(evidenceDir, `search-settings-${viewport.width}x${viewport.height}-scrolled.png`) });
      report.viewports.push(metrics);
    }
    assert.deepEqual(errors, [], `page errors: ${errors.join('; ')}`);
    report.pageErrors = errors;
    fs.writeFileSync(path.join(evidenceDir, 'search-settings-ux-results.json'), JSON.stringify(report, null, 2));
    console.log(`PASS Search settings labels and touch targets at ${report.viewports.map(v => `${v.viewport.width}x${v.viewport.height}`).join(', ')}`);
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
