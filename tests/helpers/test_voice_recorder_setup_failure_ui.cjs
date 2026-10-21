const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');
const repo = process.cwd();
const sourcePath = path.join(repo, 'static/js/voiceRecorder.js');
const sourceHash = crypto.createHash('sha256').update(fs.readFileSync(sourcePath)).digest('hex');
const appHTML = `<!doctype html><button class="send-btn recording" data-mode="recording"></button><textarea id="message"></textarea><script type="module">
window.errors = [];
window.toasts = [];
window.attachments = [];
window._updateSendBtnIcon = () => {};
window.__mode = 'constructor';
window.__streams = [];
window.MediaRecorder = class {
  constructor(stream) { if (window.__mode === 'constructor') throw new Error('synthetic constructor failure'); this.stream = stream; this.state = 'inactive'; }
  start() { if (window.__mode === 'start') throw new Error('synthetic start failure'); this.state = 'recording'; }
  stop() { this.state = 'inactive'; this.onstop?.(); }
};
Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => {
  const track = { stopCount: 0, stop() { this.stopCount++; }, get readyState() { return this.stopCount ? 'ended' : 'live'; } };
  const stream = { getTracks: () => [track], track };
  window.__streams.push(stream);
  return stream;
} } });
import('/voiceRecorder.js').then(m => {
  window.recorder = m.default;
  window.recorder._sttProvider = 'disabled';
  window.recorder.startRecording(f => window.attachments.push(f.name), x => window.toasts.push(x), x => window.errors.push(x));
  window.fixtureReady = true;
}).catch(e => { window.moduleError = e.stack || String(e); window.fixtureReady = true; });
</script>`;
const server = http.createServer((req, res) => {
  if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(appHTML); }
  if (req.url === '/voiceRecorder.js') { res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }); return fs.createReadStream(sourcePath).pipe(res); }
  res.writeHead(404); res.end('not found');
});
(async () => {
  let browser;
  const result = { scope: 'actual voiceRecorder.js with synthetic media objects; no physical microphone or STT/network', source: { file: 'static/js/voiceRecorder.js', sha256: sourceHash }, cases: {}, pageErrors: [], externalRequests: [] };
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE, args: ['--no-sandbox', '--disable-gpu'] });
    const page = await browser.newPage();
    await page.route('**/*', route => { const u = new URL(route.request().url()); if (['http:', 'https:'].includes(u.protocol) && u.origin !== origin) { result.externalRequests.push(u.href); return route.abort(); } return route.continue(); });
    page.on('pageerror', e => result.pageErrors.push(e.stack || e.message));
    await page.goto(origin);
    await page.waitForFunction(() => window.fixtureReady);
    assert.equal(await page.evaluate(() => window.moduleError || null), null);
    await page.waitForFunction(() => window.errors.length > 0);
    const inspect = () => page.evaluate(() => ({ stopCount: window.__streams.at(-1)?.track.stopCount ?? null, readyState: window.__streams.at(-1)?.track.readyState ?? null, buttonMode: document.querySelector('.send-btn').dataset.mode, recordingClass: document.querySelector('.send-btn').classList.contains('recording'), isRecording: window.recorder.getIsRecording(), errors: [...window.errors], tracksAcquired: window.__streams.length }));
    const constructor = await inspect();
    assert.equal(constructor.stopCount, 1, 'constructor failure stops acquired stream track');
    assert.equal(constructor.readyState, 'ended');
    assert.equal(constructor.buttonMode, '');
    assert.equal(constructor.recordingClass, false);
    assert.equal(constructor.isRecording, false);
    assert.match(constructor.errors.at(-1), /Microphone error: synthetic constructor failure/);
    result.cases.constructorThrows = constructor;

    await page.evaluate(() => { window.__mode = 'start'; const b = document.querySelector('.send-btn'); b.dataset.mode = 'recording'; b.classList.add('recording'); window.recorder.startRecording(f => window.attachments.push(f.name), x => window.toasts.push(x), x => window.errors.push(x)); });
    await page.waitForFunction(() => window.errors.some(x => x.includes('synthetic start failure')));
    const startFailure = await inspect();
    assert.equal(startFailure.tracksAcquired, 2);
    assert.equal(startFailure.stopCount, 1, 'start failure stops acquired stream track');
    assert.equal(startFailure.readyState, 'ended');
    assert.equal(startFailure.buttonMode, '');
    assert.equal(startFailure.recordingClass, false);
    assert.equal(startFailure.isRecording, false);
    assert.match(startFailure.errors.at(-1), /Microphone error: synthetic start failure/);
    result.cases.startThrows = startFailure;

    await page.evaluate(() => { window.__mode = 'normal'; const b = document.querySelector('.send-btn'); b.dataset.mode = 'recording'; b.classList.add('recording'); window.recorder.startRecording(f => window.attachments.push(f.name), x => window.toasts.push(x), x => window.errors.push(x)); });
    await page.waitForFunction(() => window.recorder.getIsRecording());
    await page.evaluate(() => window.recorder.stopRecording());
    await page.waitForFunction(() => window.attachments.length === 1 && !window.recorder.getIsRecording());
    const normal = await inspect();
    assert.equal(normal.tracksAcquired, 3);
    assert.equal(normal.stopCount, 1);
    assert.equal(normal.readyState, 'ended');
    assert.equal(normal.buttonMode, '');
    assert.equal(normal.recordingClass, false);
    result.cases.normalStopControl = { stopCount: normal.stopCount, readyState: normal.readyState, attachmentCount: await page.evaluate(() => window.attachments.length), buttonMode: normal.buttonMode, recordingClass: normal.recordingClass, isRecording: normal.isRecording };
    assert.deepEqual(result.pageErrors, []);
    assert.deepEqual(result.externalRequests, []);
    result.pass = true;
    await page.close();
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } catch (e) { process.stderr.write((e.stack || String(e)) + '\n'); process.exitCode = 1; }
  finally { if (browser) await browser.close().catch(() => {}); if (server.closeAllConnections) server.closeAllConnections(); await new Promise(resolve => server.close(resolve)).catch(() => {}); }
})();
