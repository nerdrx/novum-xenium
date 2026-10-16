const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

const root = path.resolve('static');
const types = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const server = http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  if (pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<!doctype html><html><head><link rel="stylesheet" href="/style.css"></head><body></body></html>');
    return;
  }
  const file = path.resolve(root, `.${pathname}`);
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.BROWSER_EXECUTABLE || '/opt/google/chrome/chrome',
    args: ['--no-sandbox', '--disable-gpu'],
  });
  try {
    const page = await browser.newPage();
    await page.setViewportSize({ width: 320, height: 720 });
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    const encoded = await page.evaluate(async () => {
      if (!window.MediaRecorder || !MediaRecorder.isTypeSupported('video/webm;codecs=vp8')) {
        throw new Error('headless browser cannot create WebM fixture');
      }
      const canvas = document.createElement('canvas');
      canvas.width = 640;
      canvas.height = 360;
      const context = canvas.getContext('2d');
      const stream = canvas.captureStream(8);
      const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' });
      const chunks = [];
      recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      const stopped = new Promise(resolve => { recorder.onstop = resolve; });
      recorder.start();
      for (let frame = 0; frame < 8; frame++) {
        context.fillStyle = frame % 2 ? '#2266aa' : '#cc8844';
        context.fillRect(0, 0, 640, 360);
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      recorder.stop();
      await stopped;
      stream.getTracks().forEach(track => track.stop());
      const blob = new Blob(chunks, { type: 'video/webm' });
      return btoa(String.fromCharCode(...new Uint8Array(await blob.arrayBuffer())));
    });
    await page.route('https://media.example.test/clip.webm?fixture=1', route => route.fulfill({
      status: 200,
      contentType: 'video/webm',
      body: Buffer.from(encoded, 'base64'),
      headers: { 'access-control-allow-origin': '*' },
    }));
    await page.evaluate(async () => {
      const md = await import('/js/markdown.js');
      const rendered = md.mdToHtml('![fixture](https://media.example.test/clip.webm?fixture=1)');
      document.body.innerHTML = '<link rel="stylesheet" href="/style.css"><main class="msg" style="width:240px"><div class="body"></div></main>';
      const body = document.querySelector('.msg .body');
      body.innerHTML = rendered;
      const video = body.querySelector('video');
      if (!video) throw new Error(`markdown did not render video: ${rendered}`);
      video.id = 'fixture-video';
      video.addEventListener('loadedmetadata', () => { window.fixtureLoaded = true; }, { once: true });
      video.addEventListener('playing', () => { window.fixturePlaying = true; }, { once: true });
      video.load();
      const play = document.createElement('button');
      play.id = 'play-fixture';
      play.textContent = 'Play fixture';
      play.addEventListener('click', () => video.play());
      document.querySelector('.msg').append(play);
    });
    await page.waitForFunction(() => window.fixtureLoaded === true, null, { timeout: 10000 });
    const safeAttrs = await page.locator('#fixture-video').evaluate(video => ({
      controls: video.controls,
      playsInline: video.playsInline,
      preload: video.preload,
      duration: video.duration,
      src: video.getAttribute('src'),
    }));
    assert.equal(safeAttrs.controls, true);
    assert.equal(safeAttrs.playsInline, true);
    assert.equal(safeAttrs.preload, 'none');
    assert.ok(safeAttrs.duration > 0, JSON.stringify(safeAttrs));
    assert.match(safeAttrs.src, /^https:\/\/media\.example\.test\//);
    const layout = await page.locator('.msg .body').evaluate(body => ({
      bodyWidth: body.clientWidth,
      bodyScrollWidth: body.scrollWidth,
      videoWidth: body.querySelector('video').getBoundingClientRect().width,
      pageScrollWidth: document.documentElement.scrollWidth,
    }));
    assert.ok(layout.videoWidth <= layout.bodyWidth, JSON.stringify(layout));
    assert.ok(layout.bodyScrollWidth <= layout.bodyWidth, JSON.stringify(layout));
    assert.ok(layout.pageScrollWidth <= 320, JSON.stringify(layout));
    await page.locator('#play-fixture').click();
    await page.waitForFunction(() => window.fixturePlaying === true, null, { timeout: 5000 });

    const sanitized = await page.evaluate(async () => {
      const md = await import('/js/markdown.js');
      return md.sanitizeAllowedHtml(
        '<details><video src="https://media.example.test/clip.webm?fixture=1" autoplay onerror="alert(1)" poster="javascript:alert(2)"><source src="https://evil.test/a.webm"></video><iframe src="https://evil.test"></iframe></details>'
      );
    });
    assert.match(sanitized, /<video[^>]*controls[^>]*playsinline[^>]*preload="none"/);
    assert.doesNotMatch(sanitized, /autoplay|onerror|poster|<source|<iframe|javascript:/i);
    console.log('PASS markdown video load, click, and DOM sanitization');
  } finally {
    await browser.close();
    server.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; server.close(); });
