// Exercise the real module with held status responses; never contact a live backend.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');
const root = path.resolve(__dirname, '../../static');
const hooks = `
export const watchdogFixture = {
  probe: _probeStaleLocalStream,
  install(sid) {
    const active = { abortCtrl: new AbortController(), lastActivity: Date.now() - 20000 };
    _activeStreams.set(sid, active);
    _syncForegroundStreamGlobals();
    return active;
  },
  reset() { _activeStreams.clear(); _backgroundStreams.clear(); _streamGenerations.clear(); _sendInFlight = false; },
  preflight() { _sendInFlight = true; },
  newerGeneration(sid) { _streamGenerations.set(sid, 2); },
  state(sid) { return { active: _activeStreams.has(sid), busy: window.__odysseusChatBusy }; },
};`;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://fixture');
  if (url.pathname === '/api/auth/status') {
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ configured: false, authenticated: false, username: null }));
  }
  if (url.pathname === '/') {
    res.setHeader('Content-Type', 'text/html');
    return res.end('<textarea id="message"></textarea><button class="send-btn"></button><script type="module">import { watchdogFixture } from "/js/chat.js"; import sessions from "/js/sessions.js"; window.fixture = { watchdogFixture, sessions };</script>');
  }
  const file = path.resolve(root, `.${decodeURIComponent(url.pathname)}`);
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
  res.setHeader('Content-Type', 'text/javascript');
  const content = fs.readFileSync(file, 'utf8');
  res.end(content + (url.pathname === '/js/chat.js' ? hooks : ''));
});
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE, args: ['--no-sandbox', '--disable-gpu'] });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForFunction(() => !!window.fixture);
    const scenarios = ['new-run', 'other-chat', 'fresh-activity', 'new-preflight', 'new-generation', 'probe-timeout', 'still-stale'];
    for (const scenario of scenarios) {
      const result = await page.evaluate(async scenario => {
        const { watchdogFixture: f, sessions } = window.fixture;
        f.reset();
        sessions.setCurrentSessionId('A');
        const old = f.install('A');
        let reply;
        const originalSetTimeout = window.setTimeout;
        let expire;
        if (scenario === 'probe-timeout') window.setTimeout = (fn, ms, ...args) => {
          if (ms === 15000) { expire = fn; return originalSetTimeout(() => {}, 60000); }
          return originalSetTimeout(fn, ms, ...args);
        };
        let requests = 0;
        window.fetch = (_url, init) => new Promise((resolve, reject) => {
          requests++;
          reply = resolve;
          init.signal?.addEventListener('abort', () => reject(new DOMException('Timed out', 'AbortError')), { once: true });
        });
        const probe = f.probe();
        let current = old;
        if (scenario === 'new-run') current = f.install('A');
        if (scenario === 'other-chat') { sessions.setCurrentSessionId('B'); current = f.install('B'); }
        if (scenario === 'fresh-activity') old.lastActivity = Date.now();
        if (scenario === 'new-preflight') f.preflight();
        if (scenario === 'new-generation') f.newerGeneration('A');
        if (scenario === 'probe-timeout') expire();
        else reply(new Response('{}', { status: 404 }));
        await probe;
        window.setTimeout = originalSetTimeout;
        if (scenario === 'probe-timeout') {
          const retry = f.probe();
          reply(new Response('{}', { status: 200 }));
          await retry;
        }
        const sid = scenario === 'other-chat' ? 'B' : 'A';
        return { ...f.state(sid), requests, oldAborted: old.abortCtrl.signal.aborted, currentAborted: current.abortCtrl.signal.aborted };
      }, scenario);
      if (scenario === 'still-stale') {
        assert.equal(result.active, false, 'confirmed stale stream must still unlock');
        assert.equal(result.oldAborted, true);
        assert.equal(result.busy, false);
      } else {
        assert.equal(result.active, true, `${scenario}: late probe must preserve active stream`);
        assert.equal(result.currentAborted, false, `${scenario}: current controller survives`);
        assert.equal(result.busy, true, `${scenario}: composer stays busy`);
      }
      if (scenario === 'probe-timeout') assert.equal(result.requests, 2, 'timed out probe must allow retry');
    }
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ pass: true, scenarios: scenarios.length, pageErrors: errors }));
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
