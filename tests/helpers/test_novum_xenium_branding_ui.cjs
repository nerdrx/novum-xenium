// Small browser check for the shared desktop/mobile default brand layer.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

const repo = path.resolve(__dirname, '../..');
// Use the real shared shell, with scripts removed so this stays a static visual
// check and never sends chat text or touches app APIs.
const html = fs.readFileSync(path.join(repo, 'static/index.html'), 'utf8')
  .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
  .replace(/<html\b([^>]*)>/i, '<html$1 class="theme-novum-xenium">');

const server = http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://fixture').pathname);
  if (pathname === '/') { res.setHeader('Content-Type', 'text/html'); res.end(html); return; }
  const file = path.resolve(repo, `.${pathname}`);
  if (!file.startsWith(repo + path.sep) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.setHeader('Content-Type', file.endsWith('.css') ? 'text/css' : file.endsWith('.woff2') ? 'font/woff2' : 'text/plain');
  fs.createReadStream(file).pipe(res);
});

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE, args: ['--no-sandbox', '--disable-gpu'] });
  try {
    for (const viewport of [{ name: 'desktop', width: 1440, height: 900 }, { name: 'mobile', width: 390, height: 844 }]) {
      const page = await browser.newPage({ viewport });
      await page.goto(`http://127.0.0.1:${server.address().port}/`);
      await page.evaluate(() => {
        document.getElementById('app-loader')?.remove();
        document.activeElement?.blur?.();
        // Match the wired idle shell: startup removes the splash, restores the
        // welcome panel, and starts phones with the sidebar collapsed.
        const welcome = document.querySelector('#welcome-screen');
        welcome.style.animation = 'none';
        welcome.style.transition = 'none';
        welcome.style.setProperty('opacity', '1', 'important');
        if (innerWidth <= 768) document.querySelector('#sidebar')?.classList.add('hidden');
      });
      await page.evaluate(() => document.fonts.ready);
      const metrics = await page.evaluate(() => {
        const root = document.documentElement;
        const body = document.body;
        const composer = document.querySelector('.chat-input-bar');
        const sidebar = document.querySelector('.sidebar');
        return {
          viewportWidth: innerWidth,
          documentWidth: root.scrollWidth,
          bodyWidth: body.scrollWidth,
          composerRight: composer.getBoundingClientRect().right,
          composerBottom: composer.getBoundingClientRect().bottom,
          bg: getComputedStyle(root).getPropertyValue('--bg').trim(),
          font: getComputedStyle(body).fontFamily,
          codeFont: getComputedStyle(document.querySelector('code')).fontFamily,
          sidebarShadow: getComputedStyle(sidebar).boxShadow,
          themeClass: root.classList.contains('theme-novum-xenium'),
          welcome: (() => { const el = document.querySelector('#welcome-screen'); const cs = getComputedStyle(el); return { text: el.innerText, display: cs.display, opacity: cs.opacity, color: cs.color, fill: cs.webkitTextFillColor, rect: el.getBoundingClientRect().toJSON() }; })(),
        };
      });
      assert.equal(metrics.themeClass, true);
      assert.equal(metrics.bg, '#100f14');
      assert.ok(metrics.font.startsWith('system-ui'), `prose font: ${metrics.font}`);
      assert.ok(metrics.codeFont.includes('Fira Code'), `code font: ${metrics.codeFont}`);
      assert.equal(metrics.sidebarShadow, 'none');
      assert.ok(metrics.documentWidth <= metrics.viewportWidth, `${viewport.name} horizontal overflow: ${JSON.stringify(metrics)}`);
      assert.ok(metrics.bodyWidth <= metrics.viewportWidth, `${viewport.name} body overflow: ${JSON.stringify(metrics)}`);
      assert.ok(metrics.composerRight <= metrics.viewportWidth + 1, `${viewport.name} composer outside viewport`);
      assert.ok(metrics.composerBottom <= viewport.height + 1, `${viewport.name} composer below viewport`);
      assert.ok(Number(metrics.welcome.opacity) > 0, `${viewport.name} welcome brand should be visible`);
      if (process.env.NOVUM_SCREENSHOT_DIR) {
        fs.mkdirSync(process.env.NOVUM_SCREENSHOT_DIR, { recursive: true });
        await page.screenshot({ path: path.join(process.env.NOVUM_SCREENSHOT_DIR, `novum-xenium-${viewport.name}.png`), fullPage: true });
      }
      await page.close();
    }
    console.log('PASS: Novum Xenium defaults render without desktop/mobile overflow');
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
