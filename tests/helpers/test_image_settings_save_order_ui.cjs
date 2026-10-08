// Exercise the real image-settings initializer with browser-native controls
// and deferred saves, without touching an account or generating an image.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

const repo = path.resolve(__dirname, '../..');
const source = fs.readFileSync(path.join(repo, 'static/js/settings.js'), 'utf8');
const start = source.indexOf('async function initImageSettings()');
const end = source.indexOf('/* ── Vision ── */', start);
assert(start >= 0 && end > start, 'could not locate image settings initializer');
const initializer = source.slice(start, end);
const html = `<!doctype html><meta charset="utf-8"><body>
<div><select id="set-imgModelSelect"><option value="">Auto-detect</option></select>
<select id="set-imgQualitySelect"><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select>
<input id="set-imgEnabledToggle" type="checkbox"><div id="set-imgBackendMsg"></div><div id="set-imgSettingsMsg"></div></div>
<script type="module" src="/fixture.js"></script></body>`;
const endpoint = models => ({ id: 'image-provider', name: 'Provider', is_enabled: true, model_type: 'image', models });
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/') return res.end(html);
  if (url.pathname === '/api/auth/settings') {
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ image_model: 'gpt-image-0@Provider', image_quality: 'medium', image_gen_enabled: true }));
  }
  if (url.pathname === '/fixture.js') {
    res.setHeader('Content-Type', 'text/javascript');
    return res.end(`
      const el = id => document.getElementById(id);
      const uiModule = { showError() {}, showToast() {} };
      const sortModelIds = values => [...values].sort();
      const _fetchModelEndpoints = async () => [${JSON.stringify(endpoint(['gpt-image-0', 'gpt-image-1', 'gpt-image-2']))}];
      const _registerAiEndpointRefresh = fn => { window.__refreshImageEndpoints = fn; };
      window.__imageSaveCalls = [];
      window.__resolveImageSave = (index, ok) => window.__imageSaveCalls[index].resolve({
        ok, status: ok ? 200 : 503, text: async () => 'fixture save failure',
      });
      const _postSettings = snapshot => new Promise(resolve => window.__imageSaveCalls.push({
        snapshot: { ...snapshot }, resolve,
      }));
      ${initializer}
      await initImageSettings();
      window.__imageSettingsReady = true;
    `);
  }
  res.writeHead(404); return res.end();
});

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE,
    args: ['--no-sandbox', '--disable-gpu'] });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.stack || error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForFunction(() => window.__imageSettingsReady);
    const model = page.locator('#set-imgModelSelect');
    const quality = page.locator('#set-imgQualitySelect');
    const status = page.locator('#set-imgSettingsMsg');

    // First save fails while a newer model selection is queued. The newest
    // selection survives inventory refresh and is still persisted afterward.
    await model.selectOption('gpt-image-1@Provider');
    await page.waitForFunction(() => window.__imageSaveCalls.length === 1);
    await model.selectOption('gpt-image-2@Provider');
    assert.equal(await page.evaluate(() => window.__imageSaveCalls.length), 1,
      'later settings writes wait for the in-flight save');
    assert.equal(await status.textContent(), 'Saving…');
    await page.evaluate(() => window.__refreshImageEndpoints([
      { id: 'image-provider', name: 'Provider', is_enabled: true, model_type: 'image', models: ['gpt-image-0', 'gpt-image-1'] },
    ]));
    assert.equal(await model.inputValue(), 'gpt-image-2@Provider', 'inventory refresh must preserve the latest draft');
    assert.match(await model.locator('option:checked').textContent(), /saved; not listed/);

    await page.evaluate(() => window.__resolveImageSave(0, false));
    await page.waitForFunction(() => window.__imageSaveCalls.length === 2);
    assert.equal(await status.textContent(), 'Saving…', 'an older failed save must not replace the latest pending status');
    assert.deepEqual(await page.evaluate(() => window.__imageSaveCalls[1].snapshot), {
      image_gen_enabled: true,
      image_model: 'gpt-image-2@Provider',
      image_quality: 'medium',
    });
    await page.evaluate(() => window.__resolveImageSave(1, true));
    await page.waitForFunction(() => document.getElementById('set-imgSettingsMsg').textContent === 'Saved');
    assert.equal(await model.inputValue(), 'gpt-image-2@Provider');

    // Rapid model + quality edits capture each full snapshot and serialize in
    // order. A later failure keeps the selected values as a retryable draft;
    // an even newer save still runs and can report success.
    await model.selectOption('gpt-image-1@Provider');
    await page.waitForFunction(() => window.__imageSaveCalls.length === 3);
    await quality.selectOption('high');
    assert.deepEqual(await page.evaluate(() => window.__imageSaveCalls[2].snapshot), {
      image_gen_enabled: true,
      image_model: 'gpt-image-1@Provider',
      image_quality: 'medium',
    });
    await page.evaluate(() => window.__resolveImageSave(2, true));
    await page.waitForFunction(() => window.__imageSaveCalls.length === 4);
    assert.deepEqual(await page.evaluate(() => window.__imageSaveCalls[3].snapshot), {
      image_gen_enabled: true,
      image_model: 'gpt-image-1@Provider',
      image_quality: 'high',
    });
    await page.evaluate(() => window.__resolveImageSave(3, false));
    await page.waitForFunction(() => document.getElementById('set-imgSettingsMsg').textContent === 'Failed to save');
    assert.equal(await model.inputValue(), 'gpt-image-1@Provider', 'failed save must keep the selected model draft');
    assert.equal(await quality.inputValue(), 'high', 'failed save must keep the selected quality draft');
    await page.locator('#set-imgEnabledToggle').uncheck();
    await page.waitForFunction(() => window.__imageSaveCalls.length === 5);
    assert.deepEqual(await page.evaluate(() => window.__imageSaveCalls[4].snapshot), {
      image_gen_enabled: false,
      image_model: 'gpt-image-1@Provider',
      image_quality: 'high',
    });
    await page.evaluate(() => window.__resolveImageSave(4, true));
    await page.waitForFunction(() => document.getElementById('set-imgSettingsMsg').textContent === 'Saved');
    assert.deepEqual(errors, []);
    console.log('PASS: image settings saves serialize snapshots and keep truthful retry state');
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
