const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

const repo = path.resolve(__dirname, '../..');
const source = fs.readFileSync(path.join(repo, 'static/index.html'), 'utf8');
const html = source
  .replace('<html lang="en" class="nx-workspace">', '<html lang="en" class="nx-workspace theme-novum-xenium">')
  .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
  .replace(/<link\b[^>]*rel=["']modulepreload["'][^>]*>/gi, '')
  .replace('class="chat-input-bottom" style="visibility:hidden"', 'class="chat-input-bottom"');
const mime = { '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://fixture');
  if (url.pathname === '/') { res.setHeader('Content-Type', 'text/html'); return res.end(html); }
  if (url.pathname === '/api/prefs/tool_approval_mode') {
    if (req.method === 'PUT') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ value: JSON.parse(body).value }));
      });
      return;
    }
    res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ value: 'auto' }));
  }
  if (url.pathname.startsWith('/api/')) { res.writeHead(404); return res.end(); }
  const file = path.resolve(repo, `.${decodeURIComponent(url.pathname)}`);
  if (!file.startsWith(repo + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404); return res.end();
  }
  res.setHeader('Content-Type', mime[path.extname(file)] || 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
});

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.BROWSER_EXECUTABLE || '/opt/google/chrome/chrome',
    args: ['--no-sandbox', '--disable-gpu'],
  });
  try {
    for (const viewport of [
      { width: 576, height: 1280 },
      { width: 390, height: 844 },
      { width: 320, height: 844 },
      { width: 600, height: 320 },
    ]) {
      const { width } = viewport;
      const page = await browser.newPage({ viewport });
      const errors = [];
      page.on('pageerror', error => errors.push(String(error)));
      const origin = `http://127.0.0.1:${server.address().port}/`;
      await page.route('**/*', route => {
        if (route.request().url().startsWith(origin)) return route.continue();
        return route.abort();
      });
      await page.goto(origin, { waitUntil: 'networkidle' });
      await page.evaluate(async () => {
        document.getElementById('app-loader')?.remove();
        document.querySelector('#sidebar')?.classList.add('hidden');
        await document.fonts.ready;
        const module = await import('/static/js/approvalMode.js');
        module.init();
        document.querySelector('.chat-input-bottom').style.visibility = 'visible';
      });
      await page.waitForFunction(() => document.querySelector('.approval-mode-trigger')?.textContent.includes('Approve for me'));
      const metrics = await page.evaluate(() => {
        const bounds = selector => {
          const node = document.querySelector(selector);
          const box = node.getBoundingClientRect();
          const range = document.createRange();
          range.selectNodeContents(node);
          const text = range.getBoundingClientRect();
          return { x: box.x, y: box.y, width: box.width, height: box.height,
            textY: text.y, textHeight: text.height, textCenter: text.y + text.height / 2,
            center: box.y + box.height / 2, overflow: getComputedStyle(node).overflow };
        };
        return {
          viewport: innerWidth,
          documentWidth: document.documentElement.scrollWidth,
          barWidth: document.querySelector('.chat-input-bar').getBoundingClientRect().width,
          leftRow: bounds('.chat-input-left'),
          rightRow: bounds('.chat-input-right'),
          toggle: bounds('.mode-toggle'),
          agent: bounds('#mode-agent-btn'),
          chat: bounds('#mode-chat-btn'),
          approval: bounds('.approval-mode-trigger'),
          approvalLabel: bounds('.approval-mode-trigger span'),
          approvalLabelDisplay: getComputedStyle(document.querySelector('.approval-mode-trigger span')).display,
          approvalCompactText: getComputedStyle(document.querySelector('.approval-mode-trigger'), '::after').content,
          overflowButton: bounds('#overflow-plus-btn'),
          overflowIcon: bounds('#overflow-plus-btn svg'),
          sendButton: bounds('.send-btn'),
          sendIcon: bounds('.send-btn svg'),
          font: getComputedStyle(document.querySelector('.approval-mode-trigger')).fontFamily,
        };
      });
      assert.equal(metrics.documentWidth <= width, true, `${width}px composer must not cause page overflow`);
      assert.match(metrics.font, /^system-ui/, `${width}px fixture uses product theme font`);
      assert.ok(metrics.toggle.height >= metrics.agent.height,
        `${width}px mode toggle must contain touch-height child: ${JSON.stringify(metrics)}`);
      assert.ok(metrics.approval.x + metrics.approval.width <= metrics.toggle.x + 0.5,
        `${width}px approval mode must not overlap Agent/Chat controls`);
      assert.ok(metrics.toggle.x + metrics.toggle.width <= metrics.sendButton.x + 0.5,
        `${width}px Agent/Chat controls must not overlap Send`);
      for (const control of ['agent', 'chat']) {
        const item = metrics[control];
        assert.ok(Math.abs(item.textCenter - item.center) <= 2,
          `${width}px ${control} label stays centered: ${JSON.stringify(item)}`);
      }
      if (width > 480 && width <= 768) {
        assert.notEqual(metrics.approvalLabelDisplay, 'none', 'approval label remains visible above the compact-icon breakpoint');
        assert.ok(Math.abs(metrics.approvalLabel.textCenter - metrics.approval.center) <= 2,
          `${width}px approval label stays centered`);
      } else {
        const icon = await page.locator('.approval-mode-trigger svg').boundingBox();
        assert.equal(metrics.approvalLabelDisplay, 'none', 'long approval label collapses on narrow phones');
        assert.equal(metrics.approvalCompactText, '"Auto"', 'saved approval mode remains visible on narrow phones');
        assert.ok(Math.abs(icon.y + icon.height / 2 - metrics.approval.center) <= 2,
          `${width}px compact approval icon stays centered`);
      }
      assert.ok(Math.abs(metrics.overflowButton.center - metrics.leftRow.center) <= 2,
        `${width}px toolbar icon aligns with its row`);
      assert.ok(Math.abs(metrics.sendButton.center - metrics.toggle.center) <= 2,
        `${width}px send button aligns with the mode controls`);
      for (const [button, icon] of [['overflowButton', 'overflowIcon'], ['sendButton', 'sendIcon']]) {
        assert.ok(Math.abs(metrics[icon].center - metrics[button].center) <= 1,
          `${width}px ${button} SVG stays centered`);
      }
      for (const [label, shortLabel] of [['Ask for approval', 'Ask'], ['Full access', 'Full'], ['Approve for me', 'Auto']]) {
        await page.locator('.approval-mode-trigger').click();
        await page.getByRole('radio', { name: new RegExp(`^${label}`) }).click();
        await page.waitForFunction(short => {
          const trigger = document.querySelector('.approval-mode-trigger');
          return !trigger.disabled && trigger.dataset.shortLabel === short;
        }, shortLabel);
        assert.equal(await page.locator('.approval-mode-trigger').getAttribute('aria-label'), `Tool approval mode: ${label}`);
        if (width <= 480) {
          const compact = await page.locator('.approval-mode-trigger').evaluate(node => getComputedStyle(node, '::after').content);
          assert.equal(compact, JSON.stringify(shortLabel), `${width}px ${label} has a visible compact label`);
        }
      }
      assert.deepEqual(errors, [], `${width}px no page errors`);
      await page.screenshot({ path: `/tmp/nx-composer-alignment-${width}x${viewport.height}.png`, fullPage: true });
      const navigation = await page.evaluate(() => {
        document.querySelector('#sidebar')?.classList.remove('hidden');
        return ['#rail-cookbook', '#rail-research', '#rail-email', '#rail-settings',
          '#tool-cookbook-btn', '#tool-research-btn', '#tool-calendar-btn', '#tool-compare-btn']
          .map(selector => {
            const button = document.querySelector(selector);
            if (!button) return { selector, missing: true };
            const box = button.getBoundingClientRect();
            const label = button.querySelector('.grow') || button;
            const range = document.createRange();
            range.selectNodeContents(label);
            const text = range.getBoundingClientRect();
            const icon = button.querySelector('svg')?.getBoundingClientRect();
            return { selector, display: getComputedStyle(button).display,
              center: box.y + box.height / 2,
              textCenter: text.height ? text.y + text.height / 2 : null,
              iconCenter: icon ? icon.y + icon.height / 2 : null };
          }).filter(item => !item.missing && item.display !== 'none');
      });
      for (const item of navigation) {
        if (item.textCenter !== null) assert.ok(Math.abs(item.textCenter - item.center) <= 3,
          `${width}px ${item.selector} nav label alignment: ${JSON.stringify(item)}`);
        if (item.iconCenter !== null) assert.ok(Math.abs(item.iconCenter - item.center) <= 3,
          `${width}px ${item.selector} nav icon alignment: ${JSON.stringify(item)}`);
      }
      await page.screenshot({ path: `/tmp/nx-navigation-alignment-${width}x${viewport.height}.png`, fullPage: true });
      console.log(`PASS ${width}x${viewport.height}px ${JSON.stringify({ ...metrics, navigation })}`);
      await page.close();
    }
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
