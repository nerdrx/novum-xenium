// Uploading a sent attachment must leave files added during the request queued for the next send.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

const repo = path.resolve(__dirname, '../..');
const html = `<!doctype html><meta charset="utf-8"><body><div id="attach-strip"></div>
<script type="module">
  import files from '/static/js/fileHandler.js';
  files.init(''); window.files = files;
  window.addOld = () => files.addFiles([new File(['first'], 'first.txt', { type: 'text/plain' })], { skipCrop: true });
  window.addNew = () => files.addFiles([new File(['second'], 'second.txt', { type: 'text/plain' })], { skipCrop: true });
  window.startUpload = () => files.uploadPending();
  window.getPending = () => files.getPendingRaw().map(file => file.name);
  window.pendingCount = () => files.getPendingCount();
  window.fixtureReady = true;
</script></body>`;
let uploads = [];
let heldUpload = null;
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/') return res.end(html);
  if (url.pathname === '/api/upload') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8');
    const index = uploads.length;
    uploads.push(body);
    if (index === 0) {
      await new Promise(resolve => { heldUpload = resolve; });
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ files: [{ id: 'uploaded-first', name: 'first.txt' }] }));
    }
    res.setHeader('Content-Type', 'application/json');
    if (index === 1) {
      res.writeHead(503);
      return res.end(JSON.stringify({ detail: 'fixture upload failure' }));
    }
    return res.end(JSON.stringify({ files: [{ id: 'uploaded-second', name: 'second.txt' }] }));
  }
  if (url.pathname === '/__uploads') {
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify(uploads));
  }
  if (url.pathname === '/__release') {
    heldUpload?.();
    res.writeHead(204); return res.end();
  }
  const file = path.resolve(repo, `.${url.pathname}`);
  if (!file.startsWith(repo + path.sep) || !fs.existsSync(file)) {
    res.writeHead(404); return res.end();
  }
  res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : 'text/plain');
  fs.createReadStream(file).pipe(res);
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
    await page.waitForFunction(() => window.fixtureReady);
    await page.evaluate(() => window.addOld());
    const firstUpload = page.evaluate(() => window.startUpload());
    await page.waitForFunction(async () => document.querySelector('#attach-strip.attach-uploading')
      && (await (await fetch('/__uploads')).json()).length === 1);
    assert.match((await page.evaluate(async () => (await fetch('/__uploads')).json()))[0], /filename="first\.txt"/);

    await page.evaluate(() => window.addNew());
    assert.equal(await page.evaluate(() => window.pendingCount()), 2);
    await page.evaluate(() => fetch('/__release'));
    assert.deepEqual(await firstUpload, ['uploaded-first']);
    assert.deepEqual(await page.evaluate(() => window.getPending()), ['second.txt'],
      'only the file submitted in the completed request is removed');
    assert.equal(await page.locator('#attach-strip .thumb').count(), 1,
      'newly added file remains visible in the attachment strip');

    assert.deepEqual(await page.evaluate(() => window.startUpload()), [], 'a failed retry returns no uploaded IDs');
    assert.deepEqual(await page.evaluate(() => window.getPending()), ['second.txt'],
      'failed upload keeps the untouched pending file available for retry');
    await page.waitForFunction(() => document.getElementById('_attach-toast')?.textContent.includes('fixture upload failure'));
    assert.deepEqual(await page.evaluate(() => window.startUpload()), ['uploaded-second']);
    assert.equal(await page.evaluate(() => window.pendingCount()), 0);
    assert.deepEqual(errors, [], `page errors: ${errors.join('\n')}`);
    console.log('PASS: submitted-file identity, in-flight additions, failed retry retention, and strip state');
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
