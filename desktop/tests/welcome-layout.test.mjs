import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_PACKAGE || 'playwright');
const style = await fs.readFile(new URL('../../static/style.css', import.meta.url), 'utf8');
const usage = await fs.readFile(new URL('../../static/usage.css', import.meta.url), 'utf8');

test('restoring the regular home dashboard keeps its first visible frame centered', async t => {
  const server = http.createServer((req, res) => {
    if (req.url === '/style.css') { res.setHeader('Content-Type', 'text/css'); res.end(style); return; }
    if (req.url === '/usage.css') { res.setHeader('Content-Type', 'text/css'); res.end(usage); return; }
    res.setHeader('Content-Type', 'text/html');
    res.end(`<!doctype html><html class="nx-workspace"><head><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/usage.css"></head>
      <body class="welcome-ready"><main class="chat-container welcome-active"><div id="welcome-screen">
        <div class="welcome-name">Novum Xenium</div><div class="welcome-sub">Who am I? I'm nobody.</div>
        <div class="welcome-tip">Temporary session</div><button id="incognito-btn" class="active">Nobody</button>
        <section id="home-dashboard" hidden><h2>Your week</h2><div class="usage-stats"><div class="usage-stat">Chats</div><div class="usage-stat">Messages</div></div></section>
      </div><div class="chat-history"></div><div class="chat-input-bar">Message</div></main></body></html>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const browser = await chromium.launch({ headless:true, executablePath:process.env.BROWSER_EXECUTABLE, args:['--no-sandbox'] });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport:{ width:1600, height:1000 } });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(() => document.styleSheets.length === 2 && getComputedStyle(document.querySelector('#welcome-screen')).position === 'relative');

  const frames = await page.evaluate(async () => {
    const welcome = document.getElementById('welcome-screen');
    const dashboard = document.getElementById('home-dashboard');
    const button = document.getElementById('incognito-btn');
    button.classList.remove('active');
    welcome.style.animation = 'none';
    welcome.offsetHeight;
    welcome.style.animation = 'welcome-enter 0.3s ease-out both';
    dashboard.hidden = false;

    const samples = [];
    for (let i = 0; i < 8; i++) {
      await new Promise(requestAnimationFrame);
      const rect = welcome.getBoundingClientRect();
      const computed = getComputedStyle(welcome);
      samples.push({ time:performance.now(), x:rect.x, y:rect.y, width:rect.width,
        transition:computed.transitionProperty, animation:computed.animationName });
    }
    return samples;
  });
  assert.ok(frames.every(frame => Math.abs(frame.x - frames[0].x) < 0.5 && Math.abs(frame.y - frames[0].y) < 0.5),
    `welcome position moved during the first visible frames: ${JSON.stringify(frames)}`);
  assert.ok(frames.every(frame => frame.transition === 'none' && frame.animation === 'none'),
    `dashboard welcome must suppress position transitions and entrance animation: ${JSON.stringify(frames[0])}`);
});
