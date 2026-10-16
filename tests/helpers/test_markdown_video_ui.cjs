const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

const root = path.resolve('static');
const stylesheetTags = import('./stylesheets.mjs').then(({ stylesheetLinkTags }) => stylesheetLinkTags());
const types = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const server = http.createServer(async (req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  if (pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">${await stylesheetTags}</head><body></body></html>`);
    return;
  }
  const relative = pathname.startsWith('/static/') ? pathname.slice('/static/'.length) : pathname.slice(1);
  const file = path.resolve(root, relative);
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
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    const page = await context.newPage();
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
    const fixtureRequests = new Map();
    await page.route(/https:\/\/media\.example\.test\/clip\.webm\?fixture=/, route => {
      const fixture = new URL(route.request().url()).searchParams.get('fixture');
      fixtureRequests.set(fixture, (fixtureRequests.get(fixture) || 0) + 1);
      return route.fulfill({
      status: 200,
      contentType: 'video/webm',
      body: Buffer.from(encoded, 'base64'),
      headers: { 'access-control-allow-origin': '*' },
      });
    });
    await page.evaluate(async () => {
      const md = await import('/js/markdown.js');
      const rendered = md.mdToHtml('![fixture](https://media.example.test/clip.webm?fixture=1)');
      document.body.innerHTML = '<main class="msg" style="width:240px"><div class="body"></div></main>';
      const body = document.querySelector('.msg .body');
      body.innerHTML = rendered;
      const video = body.querySelector('video');
      if (!video) throw new Error(`markdown did not render video: ${rendered}`);
      video.id = 'fixture-video';
      video.crossOrigin = 'anonymous';
      video.addEventListener('loadedmetadata', () => { window.fixtureLoaded = true; }, { once: true });
      video.addEventListener('playing', () => { window.fixturePlaying = true; }, { once: true });
      const play = document.createElement('button');
      play.id = 'play-fixture';
      play.textContent = 'Play fixture';
      play.addEventListener('click', () => video.play());
      document.querySelector('.msg').append(play);
      const spacer = document.createElement('div');
      spacer.style.height = '2200px';
      const offscreen = document.createElement('video');
      offscreen.id = 'offscreen-video';
      offscreen.className = 'chat-inline-media';
      offscreen.controls = true;
      offscreen.playsInline = true;
      offscreen.crossOrigin = 'anonymous';
      offscreen.preload = 'none';
      offscreen.src = 'https://media.example.test/clip.webm?fixture=offscreen';
      offscreen.addEventListener('loadedmetadata', () => { window.offscreenLoaded = true; }, { once: true });
      body.append(spacer, offscreen);
    });
    await page.waitForFunction(() => window.fixtureLoaded === true, null, { timeout: 10000 });
    await page.waitForFunction(() => {
      const video = document.querySelector('#fixture-video');
      return video && video.readyState >= 2;
    }, null, { timeout: 10000 });
    const firstFrame = page.locator('.chat-media-frame').first();
    await firstFrame.waitFor();
    const safeAttrs = await page.locator('#fixture-video').evaluate(video => ({
      controls: video.controls,
      playsInline: video.playsInline,
      preload: video.preload,
      duration: video.duration,
      src: video.getAttribute('src'),
      paused: video.paused,
      currentTime: video.currentTime,
      videoWidth: video.videoWidth,
      videoHeight: video.videoHeight,
    }));
    assert.equal(safeAttrs.controls, true);
    assert.equal(safeAttrs.playsInline, true);
    assert.equal(safeAttrs.preload, 'metadata');
    assert.equal(safeAttrs.paused, true, 'preview loading must not autoplay');
    assert.ok(safeAttrs.duration > 0, JSON.stringify(safeAttrs));
    assert.equal(safeAttrs.videoWidth, 640);
    assert.equal(safeAttrs.videoHeight, 360);
    assert.match(safeAttrs.src, /^https:\/\/media\.example\.test\//);
    const frame = await page.locator('#fixture-video').evaluate(video => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      const context = canvas.getContext('2d');
      context.drawImage(video, 0, 0, 1, 1);
      return [...context.getImageData(0, 0, 1, 1).data];
    });
    assert.ok(frame[0] > 0 || frame[1] > 0 || frame[2] > 0, `video frame was blank: ${frame}`);
    const layout = await page.locator('.msg .body').evaluate(body => ({
      bodyWidth: body.clientWidth,
      bodyScrollWidth: body.scrollWidth,
      videoWidth: body.querySelector('video').getBoundingClientRect().width,
      pageScrollWidth: document.documentElement.scrollWidth,
    }));
    assert.ok(layout.videoWidth <= layout.bodyWidth, JSON.stringify(layout));
    assert.ok(layout.bodyScrollWidth <= layout.bodyWidth, JSON.stringify(layout));
    assert.ok(layout.pageScrollWidth <= 390, JSON.stringify(layout));
    assert.equal(await firstFrame.locator('.chat-media-fullscreen').count(),1);
    assert.equal(await firstFrame.locator('.chat-media-retry').isHidden(),true);
    await page.waitForTimeout(250);
    assert.equal(fixtureRequests.get('offscreen') || 0, 0, 'offscreen video should stay unloaded');
    assert.equal(await page.locator('#offscreen-video').evaluate(video => video.readyState), 0);
    await page.locator('#offscreen-video').scrollIntoViewIfNeeded();
    await page.waitForFunction(() => window.offscreenLoaded === true, null, { timeout: 10000 });
    assert.ok(fixtureRequests.get('offscreen') > 0, 'visible video should load its preview');
    assert.equal(await page.locator('#offscreen-video').evaluate(video => video.paused), true);
    await page.locator('#play-fixture').click();
    await page.waitForFunction(() => window.fixturePlaying === true, null, { timeout: 5000 });
    await firstFrame.locator('.chat-media-fullscreen').click();
    await page.waitForFunction(() => !!document.fullscreenElement, null, { timeout: 3000 });
    await page.evaluate(() => document.exitFullscreen());
    await page.waitForFunction(() => !document.fullscreenElement, null, { timeout: 3000 });

    let brokenRequests = 0;
    await page.route('https://media.example.test/retry.mp4', async route => {
      brokenRequests++;
      if (brokenRequests === 1) return route.fulfill({ status: 404, contentType: 'text/plain', body: 'fixture unavailable' });
      return route.fulfill({ status: 200, contentType: 'video/webm', body: Buffer.from(encoded, 'base64') });
    });
    await page.evaluate(() => {
      const video = document.createElement('video'); video.className = 'chat-inline-media';
      video.controls = true; video.playsInline = true; video.preload = 'none';
      video.src = 'https://media.example.test/retry.mp4'; document.querySelector('main').append(video);
    });
    const failed = page.locator('.chat-media-frame').last();
    await failed.scrollIntoViewIfNeeded();
    await failed.locator('.chat-media-retry').waitFor({ state: 'visible', timeout: 5000 });
    assert.match(await failed.locator('.chat-media-status').textContent(), /Couldn't load this video|video format is not supported/);
    assert.equal(await failed.getByRole('link', { name: 'Open original' }).getAttribute('href'), 'https://media.example.test/retry.mp4');
    await failed.getByRole('button', { name: 'Retry' }).click();
    await failed.locator('video').evaluate(video => new Promise((resolve, reject) => {
      video.addEventListener('loadedmetadata', resolve, { once: true });
      video.addEventListener('error', () => reject(new Error('retry media failed')), { once: true });
      setTimeout(() => reject(new Error('retry media timed out')), 5000);
    }));
    assert.equal(brokenRequests,2);

    const sanitized = await page.evaluate(async () => {
      const md = await import('/js/markdown.js');
      return md.sanitizeAllowedHtml(
        '<details><video src="https://media.example.test/clip.webm?fixture=1" autoplay onerror="alert(1)" poster="javascript:alert(2)"><source src="https://evil.test/a.webm"></video><iframe src="https://evil.test"></iframe></details>'
      );
    });
    assert.match(sanitized, /<video[^>]*controls[^>]*playsinline[^>]*preload="none"/);
    assert.doesNotMatch(sanitized, /autoplay|onerror|poster|<source|<iframe|javascript:/i);
    console.log('PASS lazy paused video previews, fullscreen, error retry, and DOM sanitization');
  } finally {
    await browser.close();
    server.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; server.close(); });
