const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

const repo = path.resolve(__dirname, '../..');
let polls = 0;
const server = http.createServer((req, res) => {
  if (req.url === '/static/js/subagentCard.js') {
    res.setHeader('Content-Type', 'text/javascript');
    res.end(fs.readFileSync(path.join(repo, 'static/js/subagentCard.js')));
  } else if (req.url === '/api/chat/stream_status/child-123') {
    polls += 1;
    res.statusCode = polls > 1 ? 404 : 200;
    res.end('{}');
  } else {
    res.setHeader('Content-Type', 'text/html');
    res.end('<meta charset="utf-8"><main id="history"></main><script type="module">import {appendSubagentCard} from "/static/js/subagentCard.js"; window.addCard = appendSubagentCard;</script>');
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
    await page.waitForFunction(() => !!window.addCard);
    const result = await page.evaluate(() => {
      const host = document.querySelector('#history');
      const card = window.addCard(host, { session_id: 'child-123', title: '<img src=x onerror=alert(1)>' });
      const duplicate = window.addCard(host, { session_id: 'child-123', title: 'Another title' });
      const invalid = window.addCard(host, { session_id: 'bad id', title: 'Unsafe route' });
      return {
        href: card.querySelector('a').getAttribute('href'),
        title: card.querySelector('.subagent-card-title').textContent,
        status: card.querySelector('.subagent-card-status').textContent,
        duplicateSame: card === duplicate,
        count: host.querySelectorAll('.subagent-card').length,
        injected: !!host.querySelector('img'),
        invalidRejected: invalid === null,
      };
    });
    assert.equal(result.href, '#session-child-123');
    assert.equal(result.title, '<img src=x onerror=alert(1)>');
    assert.equal(result.status, 'Running');
    assert.equal(result.duplicateSame, true);
    assert.equal(result.count, 1);
    assert.equal(result.injected, false);
    assert.equal(result.invalidRejected, true);
    await page.waitForFunction(() => document.querySelector('.subagent-card-status')?.textContent === 'Ready to inspect');
    assert.ok(polls >= 2, 'polls child status and treats inactive stream as inspectable');
    assert.deepEqual(errors, []);

    const chat = fs.readFileSync(path.join(repo, 'static/js/chat.js'), 'utf8');
    const renderer = fs.readFileSync(path.join(repo, 'static/js/chatRenderer.js'), 'utf8');
    assert.match(chat, /json\.subagent\) appendSubagentCard/);
    assert.match(renderer, /ev\.subagent\) appendSubagentCard/);
    console.log('PASS: subagent status card, replay/live wiring, safe child link and status polling');
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; server.close(); });
