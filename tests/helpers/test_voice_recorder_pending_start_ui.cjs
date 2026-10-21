const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

const repo = path.resolve(__dirname, '../..');
const origin = 'http://127.0.0.1';
const pendingMediaScript = `
(() => {
  const plans = [];
  const media = { requests: [], recorders: [], tracks: [] };
  const makeDeferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
  };
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
    getUserMedia(constraints) {
      const deferred = makeDeferred();
      const request = { constraints, ...deferred };
      plans.push(request);
      media.requests.push(request);
      return deferred.promise;
    },
  }});
  class SyntheticMediaRecorder {
    constructor(stream, options) {
      this.stream = stream;
      this.options = options;
      this.state = 'inactive';
      this.ondataavailable = null;
      this.onstop = null;
      media.recorders.push(this);
    }
    start() { this.state = 'recording'; this.startedAt = Date.now(); }
    stop() {
      if (this.state !== 'recording') return;
      this.state = 'inactive';
      this.ondataavailable?.({ data: new Blob(['synthetic audio']) });
      queueMicrotask(() => this.onstop?.());
    }
  }
  Object.defineProperty(window, 'MediaRecorder', { configurable: true, value: SyntheticMediaRecorder });
  window.__mediaFixture = {
    media,
    grant(index) {
      const tracks = Array.from({ length: 2 }, () => ({ stopped: false, stop() { this.stopped = true; } }));
      const stream = { getTracks: () => tracks };
      media.tracks.push(...tracks);
      media.requests[index].resolve(stream);
    },
    reject(index, name = 'NotAllowedError') {
      const error = new Error('synthetic permission result');
      error.name = name;
      media.requests[index].reject(error);
    },
  };
})();`;

const htmlPath = path.join(repo, 'static/index.html');
assert.ok(fs.existsSync(htmlPath), 'canonical app entry exists');
const pageErrors = [];
const externalRequests = [];
const apiRequests = [];
const server = http.createServer((req, res) => {
  const url = new URL(req.url, origin);
  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return fs.createReadStream(htmlPath).pipe(res);
  }
  if (url.pathname.startsWith('/api/')) {
    apiRequests.push({ method: req.method, path: url.pathname });
    const data = url.pathname === '/api/stt/stats'
      ? { provider: 'local' }
      : url.pathname === '/api/auth/status'
            ? { authenticated: true, configured: true, username: 'fixture-user', is_admin: false, privileges: {} }
        : url.pathname === '/api/auth/features'
          ? { features: {} }
          : url.pathname === '/api/sessions' || url.pathname === '/api/presets/templates'
            ? []
            : url.pathname === '/api/models'
              ? { items: [] }
              : url.pathname === '/api/stt/transcribe'
                ? { text: 'synthetic transcript' }
                : {};
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(data));
  }
  const filename = path.resolve(repo, `.${url.pathname}`);
  if (!filename.startsWith(repo + path.sep) || !fs.existsSync(filename) || !fs.statSync(filename).isFile()) {
    res.writeHead(404);
    return res.end();
  }
  const ext = path.extname(filename);
  const contentType = ext === '.html' ? 'text/html' : ext === '.css' ? 'text/css' :
    (ext === '.js' || ext === '.mjs') ? 'text/javascript' : 'application/octet-stream';
  res.writeHead(200, { 'content-type': contentType });
  fs.createReadStream(filename).pipe(res);
});

const makePage = async (browser, port) => {
  const context = await browser.newContext();
  await context.addInitScript(pendingMediaScript);
  const page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.route('**/*', async route => {
    const target = new URL(route.request().url());
    if (target.origin !== `${origin}:${port}`) {
      externalRequests.push(target.href);
      return route.abort();
    }
    return route.continue();
  });
  await page.goto(`${origin}:${port}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__odysseusAppStarted === true &&
    document.querySelector('.send-btn')?.dataset.mode === 'mic', null, { timeout: 15000 });
  return { context, page };
};

const state = page => page.evaluate(() => ({
  buttonMode: document.querySelector('.send-btn')?.dataset.mode,
  recordingClass: document.querySelector('.send-btn')?.classList.contains('recording'),
  recorderCount: window.__mediaFixture.media.recorders.length,
  recorderStates: window.__mediaFixture.media.recorders.map(recorder => recorder.state),
  trackStates: window.__mediaFixture.media.tracks.map(track => track.stopped),
  requestCount: window.__mediaFixture.media.requests.length,
  inputValue: document.getElementById('message')?.value,
  toast: document.getElementById('toast')?.textContent.trim(),
}));

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  const contexts = [];
  try {
    browser = await chromium.launch({
    headless: true,
    executablePath: process.env.BROWSER_EXECUTABLE || '/opt/google/chrome/chrome',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    const port = server.address().port;

    const lateGrant = await makePage(browser, port);
    contexts.push(lateGrant.context);
    const startBtn = lateGrant.page.locator('.send-btn');
    await startBtn.click();
    await lateGrant.page.waitForFunction(() => window.__mediaFixture.media.requests.length === 1);
    assert.equal((await state(lateGrant.page)).buttonMode, 'recording');
    await startBtn.click();
    await lateGrant.page.waitForFunction(() => document.querySelector('.send-btn')?.dataset.mode === 'mic');
    const stoppedBeforeGrant = await state(lateGrant.page);
    assert.equal(stoppedBeforeGrant.recorderCount, 0, 'no recorder exists while permission is pending');
    await lateGrant.page.evaluate(() => window.__mediaFixture.grant(0));
    await lateGrant.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const lateGrantState = await state(lateGrant.page);
    assert.equal(lateGrantState.recorderCount, 0, 'cancelled late grant must not construct a recorder');
    assert.equal(lateGrantState.buttonMode, 'mic', 'button already returned to the idle mic appearance');
    assert.deepEqual(lateGrantState.trackStates, [true, true], 'cancelled late grant releases every returned stream track');
    assert.equal(lateGrantState.toast, '', 'cancelled late grant does not report that recording started');

    const normal = await makePage(browser, port);
    contexts.push(normal.context);
    await normal.page.locator('.send-btn').click();
    await normal.page.waitForFunction(() => window.__mediaFixture.media.requests.length === 1);
    await normal.page.evaluate(() => window.__mediaFixture.grant(0));
    await normal.page.waitForFunction(() => window.__mediaFixture.media.recorders[0]?.state === 'recording');
    const normalStarted = await state(normal.page);
    await normal.page.locator('.send-btn').click();
    await normal.page.waitForFunction(() => window.__mediaFixture.media.recorders[0]?.state === 'inactive' &&
      window.__mediaFixture.media.tracks[0]?.stopped === true);
    const normalStopped = await state(normal.page);
    assert.equal(normalStarted.recorderCount, 1);
    assert.equal(normalStopped.recorderCount, 1);
    assert.deepEqual(normalStopped.trackStates, [true, true], 'normal app stop releases every synthetic stream track');
    await normal.page.waitForFunction(() => document.getElementById('message')?.value === 'synthetic transcript' && document.querySelector('.send-btn')?.dataset.mode === 'send');
    const normalOutput = await state(normal.page);
    assert.equal(normalOutput.inputValue, 'synthetic transcript', 'accepted recording still completes normal STT output after Stop');
    assert.equal(normalOutput.buttonMode, 'send', 'normal onstop completion restores the Send button for the transcript');
    assert.equal(normalOutput.recordingClass, false);

    const staleReject = await makePage(browser, port);
    contexts.push(staleReject.context);
    await staleReject.page.locator('.send-btn').click();
    await staleReject.page.waitForFunction(() => window.__mediaFixture.media.requests.length === 1);
    await staleReject.page.locator('.send-btn').click();
    await staleReject.page.waitForFunction(() => document.querySelector('.send-btn')?.dataset.mode === 'mic');
    await staleReject.page.locator('.send-btn').click();
    await staleReject.page.waitForFunction(() => window.__mediaFixture.media.requests.length === 2);
    await staleReject.page.evaluate(() => window.__mediaFixture.grant(1));
    await staleReject.page.waitForFunction(() => window.__mediaFixture.media.recorders[0]?.state === 'recording');
    await staleReject.page.evaluate(async () => {
      window.__mediaFixture.reject(0);
      await Promise.resolve();
      await Promise.resolve();
    });
    const staleRejectState = await state(staleReject.page);
    assert.equal(staleRejectState.buttonMode, 'recording', 'older rejection cannot reset newer recording button');
    assert.equal(staleRejectState.recorderStates[0], 'recording', 'newer recorder remains active after older rejection');
    assert.match(staleRejectState.toast, /Recording\.\.\./, 'older rejection does not replace newer attempt status');

    assert.deepEqual(externalRequests, [], 'browser made no requests outside the fixture origin');
    assert.deepEqual(pageErrors, [], 'synthetic app startup produced no uncaught page errors');
    console.log(JSON.stringify({
      pass: true,
      source: {
        appJs: crypto.createHash('sha256').update(fs.readFileSync(path.join(repo, 'static/app.js'))).digest('hex'),
        voiceRecorderJs: crypto.createHash('sha256').update(fs.readFileSync(path.join(repo, 'static/js/voiceRecorder.js'))).digest('hex'),
      },
      results: {
        canceledLateGrant: { stoppedBeforeGrant, afterGrant: lateGrantState },
        normalStartStop: { started: normalStarted, stopped: normalStopped, output: normalOutput },
        staleRejectAfterNewStart: staleRejectState,
      },
      apiRequestCount: apiRequests.length,
      apiPaths: [...new Set(apiRequests.map(request => request.path))].sort(),
      externalRequests,
      pageErrors,
      scope: 'real canonical app and voiceRecorder modules; synthetic loopback API, getUserMedia, MediaRecorder; no device microphone or external origin',
    }, null, 2));
  } finally {
    await Promise.all(contexts.map(context => context.close().catch(() => {})));
    if (browser) await browser.close();
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
