const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

const root = path.resolve('static');
const server = http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  if (pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><main id="body"></main><button id="play">Play fixture</button><script type="module">import {mdToHtml} from "/js/markdown.js"; import {createStreamRenderer} from "/js/streamingRenderer.js"; import {parkMediaFrames,preserveMediaFrames,setHtmlPreservingMedia} from "/js/chatMedia.js"; window.r=createStreamRenderer(document.querySelector("#body"),{render:mdToHtml}); window.finish=()=>setHtmlPreservingMedia(document.querySelector("#body"),mdToHtml("![Fixture clip](https://media.example.test/clip.webm)\\n\\nThe final canonical reply.")); window.finishRich=async()=>{const old=document.querySelector("#body"),stash=parkMediaFrames(old);const history=document.createElement("section");history.innerHTML=mdToHtml("![Older duplicate](https://media.example.test/clip.webm)\\n\\n![Fixture clip](https://media.example.test/clip.webm)\\n\\nA rich canonical reload.");await new Promise(resolve=>setTimeout(resolve,250));preserveMediaFrames(stash,history);stash?.remove();old.replaceWith(history);return history}; document.querySelector("#play").onclick=async()=>{const v=document.querySelector("video");v.loop=true;await v.play()};</script>');
    return;
  }
  const file = path.resolve(root, `.${pathname}`);
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) return res.writeHead(404).end();
  res.writeHead(200, { 'content-type': file.endsWith('.js') ? 'text/javascript' : 'text/css' });
  fs.createReadStream(file).pipe(res);
});

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || '/opt/google/chrome/chrome', args: ['--no-sandbox'] });
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    const page = await context.newPage();
    let mediaRequests = 0;
    await page.route('https://media.example.test/clip.webm', async route => {
      mediaRequests++;
      return route.fulfill({ status: 200, contentType: 'video/webm', body: Buffer.from(await page.evaluate(() => window.fixtureData), 'base64') });
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForFunction(() => window.r);
    const encoded = await page.evaluate(async () => {
      if (!MediaRecorder.isTypeSupported('video/webm;codecs=vp8')) throw new Error('WebM unavailable in this headless browser');
      const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
      const ctx = canvas.getContext('2d'); const stream = canvas.captureStream(8);
      const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' }); const chunks = [];
      recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      const stopped = new Promise(resolve => { recorder.onstop = resolve; }); recorder.start();
      for (let i = 0; i < 10; i++) { ctx.fillStyle = i % 2 ? '#2468aa' : '#c76a45'; ctx.fillRect(0, 0, 320, 180); await new Promise(resolve => setTimeout(resolve, 90)); }
      recorder.stop(); await stopped; stream.getTracks().forEach(track => track.stop());
      return btoa(String.fromCharCode(...new Uint8Array(await new Blob(chunks, { type: 'video/webm' }).arrayBuffer())));
    });
    await page.evaluate(data => { window.fixtureData = data; }, encoded);
    await page.evaluate(() => { window.r.update('![Fixture clip](https://media.example.test/clip.webm)'); });
    const video = page.locator('video.chat-inline-media'); await video.waitFor();
    await page.waitForFunction(() => document.querySelector('video')?.readyState >= 2, null, { timeout: 10000 });
    const element = await video.elementHandle();
    await page.locator('#play').click(); await page.waitForFunction(() => document.querySelector('video')?.paused === false);
    const requestsBeforeUpdates = mediaRequests;
    await page.evaluate(() => window.r.update('![Fixture clip](https://media.example.test/clip.webm) and more response text arrives.'));
    await page.waitForTimeout(150);
    assert.equal(await video.evaluate((node, old) => node === old, element), true, 'live-tail updates preserve the same media node');
    assert.equal(await video.evaluate(node => node.paused), false, 'stream updates preserve ongoing playback');
    assert.equal(mediaRequests, requestsBeforeUpdates, 'stream updates do not reload the media source');
    await page.evaluate(() => window.r.update('![Fixture clip](https://media.example.test/clip.webm) and more response text arrives.\n\nA second paragraph freezes the media block.'));
    assert.equal(await video.evaluate((node, old) => node === old, element), true, 'freezing a live-tail media block preserves the node');
    assert.equal(await video.evaluate(node => node.paused), false, 'freezing preserves active playback');
    await page.evaluate(() => window.r.finalize());
    assert.equal(await video.evaluate((node, old) => node === old, element), true, 'stream finalization preserves the media node');
    await page.evaluate(() => window.finish());
    assert.equal(await video.evaluate((node, old) => node === old, element), true, 'canonical terminal render preserves the media node');
    assert.equal(await video.evaluate(node => node.paused), false, 'canonical terminal render preserves active playback');
    assert.equal(mediaRequests, requestsBeforeUpdates, 'terminal render does not re-fetch the same media');
    const chatSource = fs.readFileSync(path.resolve(root, '../static/js/chat.js'), 'utf8');
    assert.match(chatSource, /setHtmlPreservingMedia\(_liveReplyEl, _replyHtml\)/, 'primary SSE completion preserves media while canonicalizing Markdown');
    assert.match(chatSource, /preserveMediaFrames\(holder, renderedBody\)/, 'resume SSE completion transfers live media into the canonical message');
    assert.match(chatSource, /await sessionModule\.selectSession\(sessionId\)[\s\S]*?preserveMediaFrames\(preservedMedia, history\)/, 'rich resume reload transfers media only after canonical history renders');
    assert.match(chatSource, /getCurrentSessionId\?\.\(\) === sessionId/, 'rich resume media transfer is guarded against cross-session attachment');
    assert.match(chatSource, /onThisSession \? parkMediaFrames\(holder\) : null/, 'off-session completion never creates a hidden media parking node');
    assert.match(chatSource, /try \{[\s\S]*?await sessionModule\.selectSession\(sessionId\)[\s\S]*?finally \{\s*preservedMedia\?\.remove\(\);/, 'failed or successful history reload always removes parked media');
    await page.evaluate(() => window.finishRich());
    const richVideos = page.locator('video.chat-inline-media');
    assert.equal(await richVideos.count(), 2, 'rich history may contain an older copy of the same URL');
    assert.notEqual(await richVideos.first().evaluate((node, old) => node === old, element), true, 'older duplicate remains its own node');
    assert.equal(await richVideos.last().evaluate((node, old) => node === old, element), true, 'live media attaches to the latest matching turn');
    assert.equal(await richVideos.last().evaluate(node => node.paused), false, 'rich canonical reload preserves playback after async delay');
    await richVideos.last().evaluate(node => node.pause());
    await page.evaluate(async () => {
      const { parkMediaFrames, preserveMediaFrames } = await import('/js/chatMedia.js');
      const old = document.querySelector('section');
      const stash = parkMediaFrames(old);
      const next = document.createElement('section');
      next.innerHTML = '<figure class="chat-media-frame"><video class="chat-inline-media" src="https://media.example.test/clip.webm" controls playsinline preload="none"></video></figure>';
      await new Promise(resolve => setTimeout(resolve, 250));
      preserveMediaFrames(stash, next); stash?.remove(); old.replaceWith(next);
    });
    assert.equal(await page.locator('video.chat-inline-media').evaluate((node, old) => node === old, element), true, 'paused media node also survives delayed replacement');
    assert.equal(await page.locator('video.chat-inline-media').evaluate(node => node.paused), true, 'paused media is not auto-started during preservation');
    await page.evaluate(async () => {
      const { parkMediaFrames } = await import('/js/chatMedia.js');
      const parked = parkMediaFrames(document.querySelector('section'));
      try { await Promise.reject(new Error('fixture navigation failure')); } catch {} finally { parked?.remove(); }
    });
    assert.equal(await page.locator('.chat-media-parking').count(),0,'rejected navigation cleanup leaves no hidden player');
    await page.evaluate(async () => {
      const { parkMediaFrames, preserveMediaFrames } = await import('/js/chatMedia.js');
      const old = document.querySelector('section');
      const stash = parkMediaFrames(old);
      const next = document.createElement('section');
      const currentSession = 'other-session', requestedSession = 'media-session';
      await new Promise(resolve => setTimeout(resolve, 250));
      if (currentSession === requestedSession) preserveMediaFrames(stash, next);
      stash?.remove(); old.replaceWith(next);
    });
    assert.equal(await page.locator('video.chat-inline-media').count(), 0, 'session mismatch does not transfer retained media into another chat');
    const layout = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth, media: document.querySelector('video')?.getBoundingClientRect().width || 0 }));
    assert.ok(layout.scroll <= 390 && layout.media <= 390, JSON.stringify(layout));
    console.log('PASS mobile streaming preserves active media node/playback and avoids duplicate requests');
    await context.close();
  } finally {
    await browser.close(); server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; server.closeAllConnections?.(); server.close(); });
