// Browser regression for mobile message-footer touch targets and wrapping.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

const repo = path.resolve(__dirname, '../..');
const html = fs.readFileSync(path.join(repo, 'static/index.html'), 'utf8')
  .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
  .replace(/<link\b[^>]*rel=["']modulepreload["'][^>]*>/gi, '');
const server = http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://fixture').pathname);
  if (pathname === '/') { res.setHeader('Content-Type', 'text/html'); res.end(html); return; }
  const file = path.resolve(repo, `.${pathname}`);
  if (!file.startsWith(repo + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404).end(); return;
  }
  res.setHeader('Content-Type', path.extname(file) === '.css' ? 'text/css' : 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
});

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE,
    args: ['--no-sandbox', '--disable-gpu'] });
  try {
    for (const width of [320, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 844 }, isMobile: true, hasTouch: true });
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      await page.evaluate(() => {
        document.documentElement.classList.add('theme-novum-xenium');
        document.getElementById('app-loader')?.remove();
        document.getElementById('welcome-screen')?.classList.add('hidden');
        const fixture = document.createElement('div');
        fixture.style.cssText = 'position:fixed;top:0;left:0;width:100vw;padding:8px;';
        const message = document.createElement('article');
        message.className = 'msg msg-ai';
        message.innerHTML = `<div class="body">A response with recovery controls.</div>
          <div class="msg-footer"><span class="timestamp">Just now</span>
            <span class="msg-actions">
              <button class="msg-action-btn" title="Regenerate from here">↻</button>
              <button class="footer-copy-btn" title="Copy message">⧉</button>
              <button class="msg-action-btn msg-more-btn" title="More actions">···</button>
            </span></div>`;
        fixture.append(message);
        document.body.append(fixture);
      });
      const result = await page.evaluate(() => {
        const footer = document.querySelector('.msg-footer');
        const buttons = [...footer.querySelectorAll('button')].map(button => {
          const rect = button.getBoundingClientRect();
          return { title: button.title, width: rect.width, height: rect.height };
        });
        const footerRect = footer.getBoundingClientRect();
        const messageRect = footer.closest('.msg').getBoundingClientRect();
        return { buttons, footerRight: footerRect.right, messageRight: messageRect.right,
          documentWidth: document.documentElement.scrollWidth, viewportWidth: innerWidth };
      });
      for (const button of result.buttons) {
        assert.ok(button.width >= 44 && button.height >= 44,
          `${width}px ${button.title} touch target: ${JSON.stringify(button)}`);
      }
      assert.ok(result.footerRight <= result.messageRight + 1,
        `${width}px footer escapes message: ${JSON.stringify(result)}`);
      assert.ok(result.documentWidth <= width,
        `${width}px page overflows horizontally: ${JSON.stringify(result)}`);
      await page.close();
    }
    console.log('PASS: mobile message actions meet 44px targets and footer wraps without horizontal overflow at 320px and 390px');
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
