const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');
const { withAppStyles } = require('./app_styles.cjs');

const repo = path.resolve(__dirname, '../..');
const staticDir = path.join(repo, 'static');
const evidenceDir = process.env.EVIDENCE_DIR || '/tmp/novum-ai-defaults-accessibility';
const targets = [
  ['set-defaultEpSelect', 'Endpoint'], ['set-defaultModelSelect', 'Model'],
  ['set-utilityEpSelect', 'Endpoint'], ['set-utilityModelSelect', 'Model'],
  ['set-utilityEffortSelect', 'Effort(when supported)'], ['set-vlModelSelect', 'Model'],
  ['set-researchEndpoint', 'Endpoint'], ['set-researchModel', 'Model'],
  ['set-imgModelSelect', 'Model'], ['set-imgQualitySelect', 'Quality'],
];
const index = fs.readFileSync(path.join(staticDir, 'index.html'), 'utf8');
const settingsStart = index.indexOf('<div id="settings-modal" class="modal hidden">');
const aiPanelEnd = index.indexOf('<!-- ═══ SEARCH TAB', settingsStart);
assert(settingsStart >= 0 && aiPanelEnd > settingsStart, 'Settings shell and AI panel boundaries found');
const settingsShell = index.slice(settingsStart, aiPanelEnd)
  .replace('id="settings-modal" class="modal hidden"', 'id="settings-modal" class="modal"')
  .replace('data-settings-panel="ai" class="hidden"', 'data-settings-panel="ai"');

async function htmlFixture() {
  return withAppStyles(`<!doctype html><html lang="en" class="nx-workspace"><meta charset="utf-8"><title>AI Defaults fixture</title>
    <!-- APP_STYLESHEET_LINKS -->
    <body class="theme-novum-xenium">${settingsShell}</div></div></div></div></body></html>`);
}

async function main() {
  fs.mkdirSync(evidenceDir, { recursive: true });
  const html = await htmlFixture();
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(html);
    }
    if (pathname.startsWith('/static/')) {
      const filename = path.resolve(staticDir, pathname.slice('/static/'.length));
      if (!filename.startsWith(staticDir + path.sep)) {
        res.writeHead(403).end();
        return;
      }
      res.writeHead(200, { 'content-type': filename.endsWith('.css') ? 'text/css' : 'application/octet-stream' });
      return fs.createReadStream(filename).pipe(res);
    }
    res.writeHead(404).end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE });
  const report = { stylesheetCount: (html.match(/rel="stylesheet"/g) || []).length, viewports: [] };
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.locator('[data-settings-panel="ai"] .admin-card').first().waitFor();
    await page.waitForTimeout(260); // Let the full-style bottom-sheet entrance settle before geometry checks.

    for (const viewport of [
      { width: 320, height: 720 }, { width: 390, height: 844 },
      { width: 600, height: 320 }, { width: 1280, height: 900 },
    ]) {
      await page.setViewportSize(viewport);
      await page.waitForTimeout(220);
      await page.evaluate(() => document.fonts.ready);
      const metrics = await page.evaluate(async targets => {
        const panel = document.querySelector('[data-settings-panel="ai"]');
        const effortRow = document.querySelector('#set-utilityEffortRow');
        effortRow.style.display = 'flex';
        const checks = [];
        for (const [id, labelText] of targets) {
          const control = document.getElementById(id);
          const labels = [...control.labels];
          if (labels.length !== 1 || labels[0].textContent.trim() !== labelText) {
            throw new Error(`${id} label association mismatch`);
          }
          labels[0].click();
          if (document.activeElement !== control) throw new Error(`${id} label click did not focus control`);
          const rect = control.getBoundingClientRect();
          const row = control.closest('.settings-row') || control.parentElement;
          const rowRect = row.getBoundingClientRect();
          const labelRect = labels[0].getBoundingClientRect();
          const collision = labelRect.left < rect.right && labelRect.right > rect.left && labelRect.top < rect.bottom && labelRect.bottom > rect.top;
          if (collision || rect.left < rowRect.left || rect.right > rowRect.right) {
            throw new Error(`${id} overlaps its label or escapes its row`);
          }
          checks.push({ id, name: control.labels[0].textContent.trim(), width: rect.width, height: rect.height,
            labelWidth: labelRect.width, rowWidth: rowRect.width });
        }
        window.scrollTo(0, 0);
        const panelsScroll = document.querySelector('.settings-panels');
        const visibleTarget = document.getElementById('set-imgQualitySelect');
        panelsScroll.scrollTop = panelsScroll.scrollHeight;
        visibleTarget.scrollIntoView({ block: 'nearest' });
        const targetRect = visibleTarget.getBoundingClientRect();
        const panels = panelsScroll;
        return {
          controls: checks,
          viewport: { width: innerWidth, height: innerHeight },
          documentWidth: document.documentElement.scrollWidth,
          panelScrollHeight: panels.scrollHeight,
          panelClientHeight: panels.clientHeight,
          panelScrollTop: panels.scrollTop,
          panelRect: (() => { const r = panels.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: r.height }; })(),
          modalRect: (() => { const r = document.querySelector('.settings-modal-content').getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: r.height }; })(),
          overlayRect: (() => { const r = document.querySelector('#settings-modal').getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: r.height }; })(),
          contentStyle: (() => { const e = document.querySelector('.settings-modal-content'); const s = getComputedStyle(e); return { position:s.position, transform:s.transform, marginTop:s.marginTop, marginBottom:s.marginBottom, display:s.display }; })(),
          windowScrollY: window.scrollY,
          targetRect: { top: targetRect.top, bottom: targetRect.bottom },
          lastControlIntersectsViewport: targetRect.bottom > 0 && targetRect.top < innerHeight,
        };
      }, targets);
      assert(metrics.documentWidth <= viewport.width, `horizontal overflow at ${viewport.width}: ${metrics.documentWidth}`);
      assert(metrics.lastControlIntersectsViewport, `last picker unreachable at ${viewport.width}: ${JSON.stringify(metrics)}`);
      for (const control of metrics.controls) {
        if (viewport.width <= 768) assert(control.height >= 44, `${control.id} is ${control.height}px at ${viewport.width}`);
        else assert(control.height <= 36, `${control.id} desktop size changed to ${control.height}px`);
      }
      if (viewport.width === 320 || viewport.width === 390 || viewport.width === 600) {
        await page.screenshot({ path: path.join(evidenceDir, `ai-defaults-${viewport.width}x${viewport.height}.png`), fullPage: true });
      }
      report.viewports.push(metrics);
    }
    assert.deepEqual(errors, [], `page errors: ${errors.join('; ')}`);
    report.pageErrors = errors;
    fs.writeFileSync(path.join(evidenceDir, 'ai-defaults-ux-results.json'), JSON.stringify(report, null, 2));
    console.log(`PASS AI Defaults labels and touch targets at ${report.viewports.map(v => `${v.viewport.width}x${v.viewport.height}`).join(', ')}`);
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
