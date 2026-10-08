const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

const repo = path.resolve(__dirname, '../..');
const server = http.createServer((req, res) => {
  if (req.url === '/subagentInspector.js') {
    res.setHeader('Content-Type', 'text/javascript');
    res.end(fs.readFileSync(path.join(repo, 'static/js/subagentInspector.js')));
  } else {
    res.setHeader('Content-Type', 'text/html');
    res.end('<meta charset="utf-8"><textarea id="message"></textarea><main id="history"></main><script type="module">import {applySubagentInspector,clearSubagentInspector} from "/subagentInspector.js"; window.inspector={applySubagentInspector,clearSubagentInspector};</script>');
  }
});

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForFunction(() => !!window.inspector);
    const child = await page.evaluate(() => {
      const history = document.querySelector('#history');
      const banner = window.inspector.applySubagentInspector(history, 'parent_123');
      return {
        text: banner.textContent,
        href: banner.querySelector('a')?.getAttribute('href'),
        disabled: document.querySelector('#message').disabled,
        active: document.body.classList.contains('subagent-inspector-active'),
      };
    });
    assert.match(child.text, /Review its work and approval requests/);
    assert.equal(child.href, '#session-parent_123');
    assert.equal(child.disabled, true);
    assert.equal(child.active, true);
    const returned = await page.evaluate(() => {
      window.inspector.clearSubagentInspector();
      return {
        banner: !!document.querySelector('#subagent-inspector-banner'),
        disabled: document.querySelector('#message').disabled,
        active: document.body.classList.contains('subagent-inspector-active'),
      };
    });
    assert.equal(returned.banner, false);
    assert.equal(returned.disabled, false);
    assert.equal(returned.active, false);
    const source = fs.readFileSync(path.join(repo, 'static/js/sessions.js'), 'utf8');
    assert.match(source, /metadata\?\.subagent\?\.parent_session_id/);
    assert.match(source, /applySubagentInspector\(chatHistory, subagentParentId\)/);
    assert.match(source, /clearSubagentInspector\(\);/);
    const css = fs.readFileSync(path.join(repo, 'static/style.css'), 'utf8');
    assert.match(css, /body\.subagent-inspector-active \.chat-input-bar \{ display: none/);
    assert.deepEqual(errors, []);
    console.log('PASS: read-only child inspector, parent link and composer restoration');
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; server.close(); });
