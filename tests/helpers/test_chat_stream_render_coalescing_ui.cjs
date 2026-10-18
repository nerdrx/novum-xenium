// Synthetic browser check for foreground stream render coalescing and ownership.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

const repo = path.resolve(__dirname, '../..');
const staticRoot = path.join(repo, 'static');
const html = `<!doctype html><meta charset="utf-8">
<textarea id="message"></textarea><div id="attach-strip"></div><input id="file-input" type="file" multiple>
<input id="incognito-toggle" type="checkbox"><input id="web-toggle" type="checkbox"><input id="research-toggle" type="checkbox"><input id="bash-toggle" type="checkbox"><button id="research-toggle-btn"></button>
<div id="chat-history"></div><div id="toast"></div><button class="send-btn"></button>
<script type="module">
  import chat from '/js/chat.js'; import sessions from '/js/sessions.js';
  import markdown from '/js/markdown.js';
  window.modulesReady = Promise.all([chat, sessions]).then(() => { window.testModules = { chat, sessions, markdown }; });
</script>`;

const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/Sx8AAAAASUVORK5CYII=', 'base64');
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://fixture');
  if (url.pathname === '/fixture') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.end(html); }
  if (url.pathname === '/pixel.png') { res.setHeader('Content-Type', 'image/png'); return res.end(pixel); }
  const file = path.resolve(staticRoot, `.${decodeURIComponent(url.pathname)}`);
  if (!file.startsWith(`${staticRoot}${path.sep}`) || !fs.existsSync(file)) { res.writeHead(404); return res.end('Not found'); }
  res.setHeader('Content-Type', /\.(?:m?js)$/.test(file) ? 'text/javascript; charset=utf-8' : 'application/octet-stream');
  res.end(fs.readFileSync(file));
});

function sse(events) { return events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''); }

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE, args: ['--no-sandbox', '--disable-gpu'] });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.stack || error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/fixture`);
    await page.waitForFunction(() => window.testModules);
    await page.evaluate(() => {
      const { chat, sessions, markdown } = window.testModules;
      sessions.setCurrentSessionId('fixture-session');
      window.streamRenderCounts = [];
      const process = markdown.processWithThinking;
      markdown.processWithThinking = text => { window.streamRenderCounts.push(String(text)); return process(text); };
      const nativeFetch = window.fetch.bind(window);
      window.fetch = (input, init) => {
        const url = String(input);
        if (url.endsWith('/api/chat_stream')) {
          const body = new ReadableStream({ start(controller) { window.fixtureStream = controller; } });
          return Promise.resolve(new Response(body, { status: 200, headers: { 'X-Odysseus-Run-Id': 'synthetic-run' } }));
        }
        if (url.includes('/api/')) return Promise.resolve(new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } }));
        return nativeFetch(input, init);
      };
      document.getElementById('message').value = 'Synthetic rendering fixture';
      window.submitDone = chat.handleChatSubmit({ preventDefault() {} });
    });
    await page.waitForFunction(() => window.fixtureStream);

    const scenario = process.argv[2] || 'burst';
    const holdNextFrame = async () => page.evaluate(() => {
      const request = window.requestAnimationFrame.bind(window);
      const cancel = window.cancelAnimationFrame.bind(window);
      window.holdStreamFrame = true;
      window.heldStreamFrame = null;
      window.requestAnimationFrame = callback => {
        if (window.holdStreamFrame && !window.heldStreamFrame) {
          window.heldStreamFrame = callback;
          return 987654;
        }
        return request(callback);
      };
      window.cancelAnimationFrame = id => {
        if (id === 987654) { window.cancelledStreamFrame = window.heldStreamFrame; window.heldStreamFrame = null; return; }
        cancel(id);
      };
    });
    if (scenario === 'burst') {
      const deltas = Array.from({ length: 120 }, (_, i) => `token-${i} `);
      await page.evaluate(parts => window.fixtureStream.enqueue(new TextEncoder().encode(parts.map(delta => `data: ${JSON.stringify({ delta })}\n\n`).join(''))), deltas);
      await page.waitForTimeout(120);
      const beforeFinal = await page.evaluate(() => ({
        calls: window.streamRenderCounts.length,
        last: window.streamRenderCounts.at(-1),
        visible: document.querySelector('.msg-ai .body')?.textContent || '',
      }));
      assert.ok(beforeFinal.calls <= 2, `120 deltas coalesce to at most two Markdown renders, got ${beforeFinal.calls}`);
      assert.equal(beforeFinal.last, deltas.join(''), 'latest frame contains the complete latest delta text');
      assert.ok(beforeFinal.visible.includes('token-119'), 'latest text is visible before stream completion');

      const finalText = 'Canonical answer.\n\n```js\nconst answer = 42;\n```\n\n![fixture pixel](/pixel.png)';
      await page.evaluate(text => {
        window.fixtureStream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: 'final_response', content: text, render_owner: 'streamed', replacement_scope: 'turn' })}\n\ndata: [DONE]\n\n`));
        window.fixtureStream.close();
      }, finalText);
      await page.evaluate(() => window.submitDone);
      const final = await page.evaluate(() => {
        const body = document.querySelector('.msg-ai .body');
        return { raw: document.querySelector('.msg-ai').dataset.raw, text: body?.textContent || '', code: body?.querySelector('pre code')?.textContent || '', image: body?.querySelector('img')?.getAttribute('src') || '' };
      });
      assert.equal(final.raw, finalText, 'terminal canonical raw text remains exact');
      assert.match(final.text, /Canonical answer/);
      assert.equal(final.code.trim(), 'const answer = 42;');
      assert.ok(final.image.endsWith('/pixel.png'), 'existing Markdown image path is preserved');
      assert.deepEqual(errors, []);
      console.log(`PASS burst: ${beforeFinal.calls} Markdown renders for 120 deltas; canonical code and image preserved`);
    } else if (scenario === 'terminal-before-frame') {
      const finalText = 'Canonical before the queued frame.\n\n```js\nconst terminal = true;\n```';
      const events = [...Array.from({ length: 80 }, (_, i) => ({ delta: `pending-${i} ` })),
        { type: 'final_response', content: finalText, render_owner: 'streamed', replacement_scope: 'turn' }];
      await page.evaluate(items => {
        window.fixtureStream.enqueue(new TextEncoder().encode(items.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n'));
        window.fixtureStream.close();
      }, events);
      await page.evaluate(() => window.submitDone);
      const result = await page.evaluate(() => ({
        raw: document.querySelector('.msg-ai')?.dataset.raw,
        text: document.querySelector('.msg-ai .body')?.textContent || '',
        code: document.querySelector('.msg-ai pre code')?.textContent || '',
        calls: window.streamRenderCounts.length,
      }));
      assert.equal(result.raw, finalText);
      assert.match(result.text, /Canonical before the queued frame/);
      assert.equal(result.code.trim(), 'const terminal = true;');
      assert.ok(result.calls <= 3, `terminal replaces pending deltas without replaying them, got ${result.calls}`);
      assert.deepEqual(errors, []);
      console.log('PASS terminal-before-frame: canonical answer wins over pending deltas');
    } else if (scenario === 'rounds') {
      const events = [
        { delta: 'First round text.' },
        { type: 'agent_step', round: 2 },
        { delta: 'Second round text.' },
      ];
      await page.evaluate(items => window.fixtureStream.enqueue(new TextEncoder().encode(items.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''))), events);
      await page.waitForTimeout(120);
      const rounds = await page.evaluate(() => [...document.querySelectorAll('.msg-ai .body')].map(body => body.textContent.trim()));
      assert.equal(rounds.length, 2, `continuation creates two visible rounds: ${JSON.stringify(rounds)}`);
      assert.match(rounds[0], /First round text/);
      assert.match(rounds[1], /Second round text/);
      await page.evaluate(() => { window.fixtureStream.enqueue(new TextEncoder().encode('data: [DONE]\n\n')); window.fixtureStream.close(); });
      await page.evaluate(() => window.submitDone);
      assert.deepEqual(errors, []);
      console.log('PASS rounds: queued first-round text finalizes before the second round renders');
    } else if (scenario === 'teacher-takeover') {
      await page.evaluate(() => {
        const cancel = window.cancelAnimationFrame.bind(window);
        let nextId = 700000;
        window.heldFrames = new Map();
        window.cancelledFrames = [];
        window.requestAnimationFrame = callback => { const id = nextId++; window.heldFrames.set(id, callback); return id; };
        window.cancelAnimationFrame = id => {
          if (window.heldFrames.has(id)) { window.cancelledFrames.push(window.heldFrames.get(id)); window.heldFrames.delete(id); return; }
          cancel(id);
        };
        window.flushHeldFrames = () => { const callbacks = [...window.heldFrames.values()]; window.heldFrames.clear(); callbacks.forEach(callback => callback(performance.now())); };
      });
      await page.evaluate(() => window.fixtureStream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ delta: 'Latest student partial.' })}\n\n`)));
      await page.waitForFunction(() => window.heldFrames.size > 0);
      await page.evaluate(() => {
        window.fixtureStream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: 'teacher_takeover', teacher_model: 'fixture-teacher' })}\n\n`));
      });
      await page.waitForFunction(() => document.querySelector('.teacher-takeover-banner'));
      const afterTakeover = await page.evaluate(() => {
        const student = document.querySelector('.msg-ai .body');
        window.cancelledFrames.forEach(callback => callback());
        return student?.textContent || '';
      });
      assert.match(afterTakeover, /Latest student partial/, 'takeover synchronously preserves the queued student answer');
      await page.evaluate(() => window.fixtureStream.enqueue(new TextEncoder().encode(
        `data: ${JSON.stringify({ type: 'agent_step', round: 2 })}\n\n` +
        `data: ${JSON.stringify({ delta: 'Teacher response.' })}\n\n`
      )));
      await page.waitForFunction(() => window.heldFrames.size > 0);
      await page.evaluate(() => window.flushHeldFrames());
      await page.waitForTimeout(50);
      const result = await page.evaluate(() => {
        const history = document.getElementById('chat-history');
        const student = history.querySelector('.msg-ai .body')?.textContent || '';
        const banner = history.querySelector('.teacher-takeover-banner');
        const teacher = [...history.querySelectorAll('.msg-ai .body')].at(-1)?.textContent || '';
        return { student, teacher, bannerBetween: !!banner && !!banner.previousElementSibling && !!banner.nextElementSibling };
      });
      assert.match(result.student, /Latest student partial/);
      assert.match(result.teacher, /Teacher response/);
      assert.equal(result.bannerBetween, true, 'takeover banner separates student and teacher bubbles');
      await page.evaluate(() => { window.fixtureStream.enqueue(new TextEncoder().encode('data: [DONE]\n\n')); window.fixtureStream.close(); });
      await page.evaluate(() => window.submitDone);
      assert.deepEqual(errors, []);
      console.log('PASS teacher takeover: student partial is finalized before the banner and teacher bubble');
    } else if (scenario === 'stop') {
      await holdNextFrame();
      await page.evaluate(() => window.fixtureStream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ delta: 'Stopped queued text.' })}\n\n`)));
      await page.waitForFunction(() => window.heldStreamFrame);
      await page.evaluate(() => {
        window.testModules.chat.handleChatSubmit({ preventDefault() {} });
        window.cancelledStreamFrame?.();
        try { window.fixtureStream.error(new Error('synthetic stop cleanup')); } catch {}
      });
      await page.evaluate(() => window.submitDone);
      const result = await page.evaluate(() => ({
        raw: document.querySelector('.msg-ai')?.dataset.raw || '',
        stopped: !!document.querySelector('.stopped-indicator'),
        queuedFrameCancelled: !!window.cancelledStreamFrame,
      }));
      assert.match(result.raw, /Stopped queued text/);
      assert.equal(result.stopped, true);
      assert.equal(result.queuedFrameCancelled, true);
      assert.deepEqual(errors, []);
      console.log('PASS stop: partial text finalizes synchronously and a cancelled queued frame cannot replay');
    } else if (scenario === 'switch') {
      await holdNextFrame();
      await page.evaluate(() => window.fixtureStream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ delta: 'Old session queued text.' })}\n\n`)));
      await page.waitForFunction(() => window.heldStreamFrame);
      const result = await page.evaluate(() => {
        const { chat, sessions } = window.testModules;
        sessions.setCurrentSessionId('other-session');
        document.getElementById('chat-history').replaceChildren();
        const sentinel = document.createElement('div');
        sentinel.className = 'msg-ai';
        sentinel.innerHTML = '<div class="body">Other session stays visible.</div>';
        document.getElementById('chat-history').appendChild(sentinel);
        window.heldStreamFrame();
        const text = sentinel.querySelector('.body').textContent;
        chat.detachCurrentStream('fixture-session');
        return { text, bodyCount: document.querySelectorAll('.msg-ai').length };
      });
      assert.equal(result.text, 'Other session stays visible.');
      assert.equal(result.bodyCount, 1, 'old stream cannot insert or overwrite content in the newly selected session');
      await page.evaluate(() => { try { window.fixtureStream.error(new Error('synthetic switch cleanup')); } catch {} });
      await page.evaluate(() => window.submitDone);
      assert.deepEqual(errors, []);
      console.log('PASS session switch: delayed old-session frame cannot write into the newly selected chat');
    } else if (scenario === 'rejected-terminal') {
      await page.evaluate(() => window.fixtureStream.enqueue(new TextEncoder().encode(
        `data: ${JSON.stringify({ delta: 'Visible valid queued delta.' })}\n\n` +
        `data: ${JSON.stringify({ type: 'final_response', content: 'Rejected owner payload.', render_owner: 'invalid-owner' })}\n\n`
      )));
      await page.waitForTimeout(100);
      const visible = await page.locator('.msg-ai .body').first().textContent();
      assert.match(visible, /Visible valid queued delta/, 'a rejected terminal owner does not cancel prior accepted visual work');
      await page.evaluate(() => { window.fixtureStream.close(); });
      await page.evaluate(() => window.submitDone);
      assert.deepEqual(errors, []);
      console.log('PASS rejected terminal: prior accepted queued delta still renders');
    } else if (scenario === 'thinking') {
      await page.evaluate(() => window.fixtureStream.enqueue(new TextEncoder().encode(
        `data: ${JSON.stringify({ delta: 'Must not overwrite reasoning.' })}\n\n` +
        `data: ${JSON.stringify({ delta: '<think>Private reasoning.' })}\n\n`
      )));
      await page.waitForTimeout(100);
      const result = await page.evaluate(() => ({
        normal: (() => { const body = document.querySelector('.msg-ai .body')?.cloneNode(true); body?.querySelectorAll('.thinking-section').forEach(node => node.remove()); return body?.textContent || ''; })(),
        reasoning: document.querySelector('.thinking-content-inner')?.textContent || '',
      }));
      assert.match(result.reasoning, /Private reasoning/);
      assert.doesNotMatch(result.normal, /Must not overwrite reasoning/);
      await page.evaluate(() => { window.fixtureStream.error(new Error('synthetic stream error')); });
      await page.evaluate(() => window.submitDone);
      assert.deepEqual(errors, []);
      console.log('PASS reasoning transition: queued prose cannot overwrite thinking; stream error settles cleanly');
    } else throw new Error(`Unknown scenario: ${scenario}`);
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; server.close(); });
