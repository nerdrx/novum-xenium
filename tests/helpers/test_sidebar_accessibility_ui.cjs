// Shipped sidebar markup in headless Chrome; click listeners stand in for app APIs.
// PLAYWRIGHT_PACKAGE=/path/to/playwright BROWSER_EXECUTABLE=/path/to/chrome node tests/helpers/test_sidebar_accessibility_ui.cjs
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');
const repo = path.resolve(__dirname, '../..');
const source = fs.readFileSync(path.join(repo, 'static/index.html'), 'utf8');
const start = source.indexOf('<nav class="sidebar" id="sidebar"');
const end = source.indexOf('</nav>', start) + '</nav>'.length;
assert(start >= 0 && end > start, 'sidebar markup is present in index.html');
const sidebar = source.slice(start, end);
const triggerStart = source.indexOf('<button type="button" class="export-dl-btn" id="export-dl-btn"');
const triggerEnd = source.indexOf('</button>', triggerStart) + '</button>'.length;
const menuStart = source.indexOf('<div class="export-dropdown-menu" id="export-dropdown-menu">');
const menuEnd = source.indexOf('</div></span></div>', menuStart) + '</div>'.length;
assert(triggerStart >= 0 && triggerEnd > triggerStart && menuStart >= 0 && menuEnd > menuStart, 'export controls are present in index.html');
const exportTrigger = source.slice(triggerStart, triggerEnd);
const exportMenu = source.slice(menuStart, menuEnd);
const controls = [
  ['sidebar-brand-btn', 'New chat'], ['sidebar-new-chat-btn', 'New Chat'],
  ['sidebar-search-btn', 'Search'], ['tool-memory-btn', 'Brain'],
  ['tool-calendar-btn', 'Calendar'], ['tool-compare-btn', 'Compare'],
  ['tool-cookbook-btn', 'Cookbook'], ['tool-research-btn', 'Deep Research'],
  ['tool-gallery-btn', 'Gallery'], ['tool-library-btn', 'Library'],
  ['library-new-doc-btn', 'New document'], ['tool-notes-btn', 'Notes'],
  ['tool-tasks-btn', 'Tasks'], ['tool-theme-btn', 'Theme'],
];
const html = `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/static/style.css">
<body>${sidebar}<div id="fixture-export" style="position:fixed;top:12px;right:12px">${exportTrigger}</div>${exportMenu}<button id="outside">Outside</button><script src="/static/js/a11y.js"></script><script>
window.clicks = {};
window.exportClicks = {};
for (const id of ${JSON.stringify(controls.map(([id]) => id))}) {
  document.getElementById(id).addEventListener('click', () => window.clicks[id] = (window.clicks[id] || 0) + 1);
}
</script><script type="module">
import { bindMenuDismiss, dismissTopMenu } from '/static/js/escMenuStack.js';
const trigger = document.getElementById('export-dl-btn');
const menu = document.getElementById('export-dropdown-menu');
let close = () => {};
const setOpen = open => { menu.classList.toggle('open', open); trigger.setAttribute('aria-expanded', String(open)); };
trigger.addEventListener('click', event => {
  event.stopPropagation();
  if (menu.classList.contains('open')) return close();
  const rect = trigger.getBoundingClientRect();
  menu.style.top = (rect.bottom + 4) + 'px';
  menu.style.left = 'auto';
  menu.style.right = (window.innerWidth - rect.right) + 'px';
  setOpen(true);
  close = bindMenuDismiss(menu, () => {
    const restore = menu.contains(document.activeElement);
    setOpen(false);
    if (restore) trigger.focus();
  }, event => !menu.contains(event.target) && !trigger.contains(event.target));
  if (event.detail === 0) menu.querySelector('button:not(:disabled)')?.focus();
});
for (const button of menu.querySelectorAll('button')) button.addEventListener('click', () => {
  window.exportClicks[button.id] = (window.exportClicks[button.id] || 0) + 1;
  close();
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && dismissTopMenu()) { event.preventDefault(); event.stopImmediatePropagation(); }
}, true);
window.exportReady = true;
</script></body>`;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/') return res.end(html);
  const file = path.resolve(repo, '.' + url.pathname);
  if (!file.startsWith(repo + path.sep) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
  res.setHeader('Content-Type', file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : 'text/plain');
  fs.createReadStream(file).pipe(res);
});
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE, args: ['--no-sandbox', '--disable-gpu'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 850 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForFunction(() => window.exportReady);
    await page.evaluate(() => document.activeElement.blur());
    const tabStops = [];
    for (let i = 0; i < 100 && controls.some(([id]) => !tabStops.includes(id)); i++) {
      await page.keyboard.press('Tab');
      tabStops.push(await page.evaluate(() => document.activeElement.id));
    }
    for (const [id] of controls) assert(tabStops.includes(id), `${id} is in keyboard tab order`);
    for (const [id, name] of controls) {
      const button = page.locator('#' + id);
      assert.equal(await button.evaluate(el => el.tagName), 'BUTTON', `${id} is a native button`);
      assert.equal(await page.locator('#' + id + '[data-a11y-activatable]').count(), 0, `${id} bypasses the div keyboard shim`);
      assert.equal(await page.getByRole('button', { name, exact: true }).count(), 1, `${name} is exposed as a button`);
      await button.click();
      assert.equal(await page.evaluate(id => window.clicks[id], id), 1, `${id} keeps click activation`);
      await button.focus();
      await page.keyboard.press('Enter');
      assert.equal(await page.evaluate(id => window.clicks[id], id), 2, `${id} activates with Enter`);
      await button.focus();
      await page.keyboard.press('Space');
      assert.equal(await page.evaluate(id => window.clicks[id], id), 3, `${id} activates with Space`);
    }
    assert.equal(await page.locator('#tool-library-btn button').count(), 0, 'Library actions are sibling buttons, not nested');
    await page.locator('#tool-calendar-btn').evaluate(el => el.classList.add('active'));
    const selectedColor = await page.locator('#tool-calendar-btn').evaluate(el => getComputedStyle(el).backgroundColor);
    assert.notEqual(selectedColor, 'rgba(0, 0, 0, 0)', 'selected tool retains its highlight');

    const exportTriggerButton = page.locator('#export-dl-btn');
    assert.equal(await page.getByRole('button', { name: 'Chat actions', exact: true }).count(), 1);
    await exportTriggerButton.focus();
    await page.keyboard.press('Enter');
    assert.equal(await exportTriggerButton.getAttribute('aria-expanded'), 'true');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'export-rename-btn', 'keyboard open moves focus into actions');
    const exportActions = [
      ['export-rename-btn', 'Rename'], ['export-compact-btn', 'Compact'], ['export-copy-btn', 'Copy Chat'],
      ['export-pdf-btn', 'PDF'], ['export-doc-btn', 'Save to Documents'], ['export-delete-btn', 'Delete Chat'],
    ];
    for (const [id, name] of exportActions) {
      const action = page.locator('#' + id);
      assert.equal(await action.evaluate(el => el.tagName), 'BUTTON');
      assert.equal(await page.getByRole('button', { name, exact: true }).count(), 1);
      assert.equal(await action.getAttribute('data-a11y-activatable'), null, 'native action has no shim listener');
    }
    for (const [id] of exportActions.slice(1)) {
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => document.activeElement.id), id, 'Tab follows the native action order');
    }
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => window.exportClicks['export-delete-btn']), 1, 'keyboard activation fires the harmless fixture action once');
    assert.equal(await exportTriggerButton.getAttribute('aria-expanded'), 'false');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'export-dl-btn');
    await exportTriggerButton.focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#export-dropdown-menu').evaluate(el => el.classList.contains('open')), false);
    assert.equal(await exportTriggerButton.getAttribute('aria-expanded'), 'false');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'export-dl-btn', 'Escape restores focus to More');
    await exportTriggerButton.click();
    assert.equal(await exportTriggerButton.getAttribute('aria-expanded'), 'true', 'pointer open still works');
    await page.locator('#export-copy-btn').click();
    assert.equal(await page.evaluate(() => window.exportClicks['export-copy-btn']), 1, 'menu action retains mouse click behavior');
    assert.equal(await exportTriggerButton.getAttribute('aria-expanded'), 'false');
    await exportTriggerButton.click();
    await page.locator('#outside').click();
    assert.equal(await exportTriggerButton.getAttribute('aria-expanded'), 'false', 'outside click still closes the popup');
    if (process.env.UI_CAPTURE_DIR) {
      fs.mkdirSync(process.env.UI_CAPTURE_DIR, { recursive: true });
      await page.locator('#tool-notes-btn').hover();
      await page.screenshot({ animations: 'disabled', path: path.join(process.env.UI_CAPTURE_DIR, 'sidebar-desktop.png') });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    for (const id of controls.map(([id]) => id)) {
      const box = await page.locator('#' + id).boundingBox();
      assert(box && box.x >= 0 && box.x + box.width <= 390, `${id} stays within the mobile viewport`);
    }
    if (process.env.UI_CAPTURE_DIR) {
      await page.locator('#tool-notes-btn').hover();
      await page.screenshot({ animations: 'disabled', path: path.join(process.env.UI_CAPTURE_DIR, 'sidebar-mobile.png') });
    }
    await page.locator('#sidebar').evaluate(el => el.classList.add('hidden'));
    await exportTriggerButton.focus();
    await page.keyboard.press('Enter');
    assert(await page.locator('#export-dropdown-menu').isVisible(), 'mobile export actions are visible');
    for (const [id] of exportActions) {
      const box = await page.locator('#' + id).boundingBox();
      assert(box && box.x >= 0 && box.x + box.width <= 390 && box.height >= 44, `${id} is a visible touch-sized mobile action`);
    }
    if (process.env.UI_CAPTURE_DIR) {
      await page.screenshot({ animations: 'disabled', path: path.join(process.env.UI_CAPTURE_DIR, 'export-menu-mobile.png') });
    }
    await page.keyboard.press('Escape');
    assert.deepEqual(errors, [], 'sidebar and a11y shim load without browser errors');
    console.log('PASS: sidebar and export controls expose native semantics, preserve mouse clicks, support keyboard activation/focus, avoid nested buttons, and fit mobile viewport');
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
