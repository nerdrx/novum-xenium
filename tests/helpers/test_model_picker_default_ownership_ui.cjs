// Actual picker module with held local requests; no provider or app backend.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');
const repo = path.resolve(__dirname, '../..');
const html = `<!doctype html><span id="model-picker-label"></span><script type="module">
import {initModelPicker, updateModelPicker} from '/static/js/modelPicker.js';
let session = null, pending = null, draft = 'draft-a';
window.writes = [];
window.requests = 0;
const nativeTimeout = window.setTimeout.bind(window);
window.setTimeout = (fn, delay, ...args) => {
  if (delay === 15000) window.expireLookup = () => fn(...args);
  return nativeTimeout(fn, delay, ...args);
};
window.modelsModule = {getCachedItems: () => [], refreshModels: async () => {}};
window.fetch = (url, options = {}) => new Promise((resolve, reject) => {
  if (!String(url).includes('/api/default-chat')) return resolve(new Response('{}', {status:200}));
  window.requests++;
  window.held = {resolve: value => resolve({ok:true, json:async () => value}), signal:options.signal};
  if (window.mode === 'body-timeout' && window.requests === 1) {
    resolve({ok:true, json: () => new Promise((resolveBody, rejectBody) => {
      window.bodyWaiting = true;
      options.signal?.addEventListener('abort', () => rejectBody(new DOMException('Aborted', 'AbortError')));
    })});
  }
  options.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
});
initModelPicker({getCurrentSessionId: () => session, getSessions: () => [{id:'b', model:'model-b'}],
  getPendingChat: () => pending, getPendingDraftId: () => draft,
  setPendingChat: value => {pending = value; window.writes.push(value);}});
window.navigate = () => {session='b'; updateModelPicker();};
window.newDraft = () => {draft='draft-b';};
window.start = updateModelPicker;
window.ready = true;
</script>`;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://fixture');
  if (url.pathname === '/') {res.setHeader('Content-Type', 'text/html');return res.end(html);}
  const file = path.resolve(repo, '.' + url.pathname);
  if (!file.startsWith(repo + path.sep) || !fs.existsSync(file)) {res.writeHead(404);return res.end();}
  res.setHeader('Content-Type', 'text/javascript');fs.createReadStream(file).pipe(res);
});
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({headless:true, executablePath:process.env.BROWSER_EXECUTABLE});
  try {
    for (const mode of ['navigate', 'newDraft', 'normal', 'fetch-timeout', 'body-timeout']) {
      const page = await browser.newPage();
      await page.goto('http://127.0.0.1:' + server.address().port);
      await page.waitForFunction(() => window.ready);
      await page.evaluate(mode => {window.mode=mode; window.start();}, mode);
      await page.waitForFunction(() => window.held);
      if (mode.endsWith('timeout')) {
        if (mode === 'body-timeout') await page.waitForFunction(() => window.bodyWaiting);
        assert.equal(await page.evaluate(() => !!window.held.signal), true, 'lookup has an abort signal');
        await page.evaluate(() => window.expireLookup());
        assert.equal(await page.evaluate(() => window.held.signal.aborted), true);
        await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 0)));
        await page.evaluate(() => window.start());
        await page.waitForFunction(() => window.requests === 2, null, {timeout: 2000}).catch(async error => {console.error(mode, await page.evaluate(() => ({requests:window.requests,writes:window.writes,defaultChat:window.__odysseusDefaultChat})));throw error;});
      } else if (mode !== 'normal') await page.evaluate(mode => window[mode](), mode);
      await page.evaluate(() => window.held.resolve({endpoint_url:'http://default', model:'default-model'}));
      await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 0)));
      assert.equal(await page.evaluate(() => window.writes.length), mode === 'normal' || mode.endsWith('timeout') ? 1 : 0,
        mode + ': late default lookup must only update its original pending draft');
      await page.close();
    }
    console.log('Default picker: navigation, newer draft, normal selection, fetch/body deadline and retry passed');
  } finally {await browser.close();await new Promise(resolve => server.close(resolve));}
})().catch(error => {console.error(error);server.close();process.exitCode=1;});
