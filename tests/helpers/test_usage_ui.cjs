// Browser regression for the workspace usage dashboard and settings panel.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

const repo = path.resolve(__dirname, '../..');
const screenshotDir = process.env.NX_USAGE_SCREENSHOT_DIR || '/tmp';
const hostile = '<img src=x onerror="window.__usageXss=1">';
let apiMode = 'normal';
const apiPeriods = [];
const sourceHtml = fs.readFileSync(path.join(repo, 'static/index.html'), 'utf8');
const html = sourceHtml
  .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
  .replace(/<link\b[^>]*rel=["']modulepreload["'][^>]*>/gi, '');

function zeroCounts() {
  return {
    messages: 0, user_messages: 0, assistant_messages: 0, sessions: 0,
    input_tokens: 0, output_tokens: 0, total_tokens: 0,
    measured_messages: 0, estimated_messages: 0,
    unknown_metrics_messages: 0, missing_metrics_messages: 0, failed_messages: 0,
  };
}

function payload(days, mode) {
  const today = new Date('2026-10-08T12:00:00Z');
  const daily = Array.from({ length: days }, (_, index) => {
    const date = new Date(today);
    date.setUTCDate(date.getUTCDate() - (days - 1 - index));
    const counts = zeroCounts();
    counts.date = date.toISOString().slice(0, 10);
    if (['normal', 'hostile'].includes(mode) && index >= days - 2) {
      counts.messages = index === days - 1 ? 3 : 2;
      counts.user_messages = index === days - 1 ? 2 : 1;
      counts.assistant_messages = 1;
      counts.sessions = 1;
      counts.input_tokens = 120;
      counts.output_tokens = 80;
      counts.total_tokens = 200;
      counts.measured_messages = 1;
    } else if (mode === 'unknown' && index === days - 1) {
      counts.messages = 1;
      counts.assistant_messages = 1;
      counts.sessions = 1;
      counts.input_tokens = 32;
      counts.output_tokens = 15;
      counts.total_tokens = 47;
      counts.unknown_metrics_messages = 1;
    } else if (mode === 'missing' && index === days - 1) {
      counts.messages = 1;
      counts.assistant_messages = 1;
      counts.sessions = 1;
      counts.missing_metrics_messages = 1;
    }
    return counts;
  });
  const totals = zeroCounts();
  let activeDays = 0;
  for (const day of daily) {
    for (const key of Object.keys(totals)) totals[key] += day[key];
    if (day.user_messages) activeDays++;
  }
  const active = totals.messages > 0;
  const modelName = mode === 'hostile' ? hostile : 'Fixture Chat Model';
  const models = active ? [{
    model: modelName,
    ...zeroCounts(),
    messages: totals.assistant_messages,
    assistant_messages: totals.assistant_messages,
    sessions: totals.sessions,
    input_tokens: totals.input_tokens,
    output_tokens: totals.output_tokens,
    total_tokens: totals.total_tokens,
    measured_messages: totals.measured_messages,
    unknown_metrics_messages: totals.unknown_metrics_messages,
    missing_metrics_messages: totals.missing_metrics_messages,
  }] : [];
  const recent = ['normal', 'hostile'].includes(mode) ? [{
    id: 'recent-session-1', name: mode === 'hostile' ? hostile : 'Product planning', model: modelName,
    last_message_at: '2026-10-08T10:00:00Z', message_count: 5,
  }] : [];
  const busiest = [...daily].reverse().find(day => day.messages);
  return {
    days, timezone: 'UTC', start_date: daily[0].date, end_date: daily.at(-1).date,
    totals, daily, models, recent_sessions: recent,
    insights: {
      active_days: activeDays, streak_days: active ? Math.min(activeDays, 2) : 0,
      words_written: active ? 54 : 0, favourite_model: models[0]?.model || null,
      busiest_day: busiest ? { date: busiest.date, messages: busiest.messages } : null,
    },
    coverage: { note: 'Retained chat history only. This is not provider billing.' },
    provider_limits: null,
  };
}

const mime = {
  '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.json': 'application/json',
};
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://fixture');
  if (url.pathname === '/api/usage') {
    const days = Number(url.searchParams.get('days'));
    apiPeriods.push(days);
    if (apiMode === 'error') {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ detail: 'Fixture usage failure' }));
      return;
    }
    const responseMode = ['empty', 'unknown', 'missing', 'hostile'].includes(apiMode) ? apiMode : 'normal';
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(payload(days, responseMode)));
    return;
  }
  if (url.pathname.startsWith('/api/')) {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ value: null }));
    return;
  }
  if (url.pathname === '/') {
    res.setHeader('Content-Type', 'text/html');
    res.end(html);
    return;
  }
  const file = path.resolve(repo, `.${decodeURIComponent(url.pathname)}`);
  if (!file.startsWith(repo + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404); res.end(); return;
  }
  res.setHeader('Content-Type', mime[path.extname(file)] || 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
});

function assertNoOverflow(metrics, name) {
  assert.ok(metrics.documentWidth <= metrics.viewportWidth, `${name} document overflow: ${JSON.stringify(metrics)}`);
  assert.ok(metrics.bodyWidth <= metrics.viewportWidth, `${name} body overflow: ${JSON.stringify(metrics)}`);
  assert.ok(metrics.contentRight <= metrics.viewportWidth + 1, `${name} usage content exceeds viewport: ${JSON.stringify(metrics)}`);
}

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.BROWSER_EXECUTABLE,
    args: ['--no-sandbox', '--disable-gpu'],
  });
  try {
    fs.mkdirSync(screenshotDir, { recursive: true });
    const origin = `http://127.0.0.1:${server.address().port}`;
    for (const viewport of [
      { name: 'desktop', width: 1440, height: 1000 },
      { name: 'mobile', width: 390, height: 844 },
    ]) {
      apiMode = 'normal';
      const page = await browser.newPage({ viewport });
      const pageErrors = [];
      page.on('pageerror', error => pageErrors.push(String(error)));
      await page.goto(origin, { waitUntil: 'networkidle' });
      await page.evaluate(() => {
        document.getElementById('app-loader')?.remove();
        document.activeElement?.blur?.();
        if (innerWidth <= 768) document.querySelector('#sidebar')?.classList.add('hidden');
        const welcome = document.querySelector('#welcome-screen');
        welcome.style.animation = 'none';
        welcome.style.transition = 'none';
        welcome.style.setProperty('opacity', '1', 'important');
      });
      const loaded = await page.evaluate(async () => {
        window.__usageCalls = [];
        const usage = await import('/static/js/usage.js');
        window.__usage = usage;
        await usage.initUsage({
          openChat: id => window.__usageCalls.push(['chat', id]),
          openAnalytics: () => window.__usageCalls.push(['analytics']),
        });
        return true;
      });
      assert.equal(loaded, true);
      await page.waitForFunction(() => document.querySelector('#home-dashboard .usage-recent-chat'));
      await page.waitForFunction(() => document.querySelector('#usage-panel [data-usage-days="7"]'));
      await page.evaluate(async () => document.fonts.ready);

      const initial = await page.evaluate(() => {
        const dashboard = document.querySelector('#home-dashboard');
        return {
          viewportWidth: innerWidth,
          documentWidth: document.documentElement.scrollWidth,
          bodyWidth: document.body.scrollWidth,
          contentRight: dashboard.getBoundingClientRect().right,
          dailyDays: document.querySelectorAll('#home-dashboard .usage-chart-day').length,
          recentText: document.querySelector('#home-dashboard .usage-recent-chat').textContent,
          modelText: document.querySelector('#usage-panel .usage-table tbody th')?.textContent,
          hostileImgCount: document.querySelectorAll('#home-dashboard img[src="x"], #usage-panel img[src="x"]').length,
          xss: window.__usageXss,
        };
      });
      assert.equal(initial.dailyDays, 7, 'dashboard shows seven daily bars');
      assert.ok(initial.recentText.includes('Product planning'), 'dashboard shows recent chats');
      assert.equal(initial.modelText, 'Fixture Chat Model', 'dashboard shows model breakdown');
      assertNoOverflow(initial, `${viewport.name} dashboard`);
      await page.screenshot({ path: path.join(screenshotDir, `usage-dashboard-${viewport.name}.png`), fullPage: true });

      await page.locator('#home-dashboard .usage-recent-chat').click();
      await page.locator('#home-dashboard .usage-button').click();
      const callbacks = await page.evaluate(() => window.__usageCalls);
      assert.deepEqual(callbacks, [['chat', 'recent-session-1'], ['analytics']], 'recent and analytics actions call supplied callbacks');

      apiMode = 'hostile';
      await page.evaluate(() => window.__usage.refreshUsage({ force: true }));
      const hostileLabels = await page.evaluate(() => ({
        recent: document.querySelector('#home-dashboard .usage-recent-chat')?.textContent || '',
        model: document.querySelector('#usage-panel .usage-table tbody th')?.textContent || '',
        imageCount: document.querySelectorAll('#home-dashboard img[src="x"], #usage-panel img[src="x"]').length,
        executed: window.__usageXss,
      }));
      assert.ok(hostileLabels.recent.includes(hostile), 'hostile recent-chat label renders as literal text');
      assert.equal(hostileLabels.model, hostile, 'hostile model name renders as literal text');
      assert.equal(hostileLabels.imageCount, 0, 'hostile labels do not create elements');
      assert.equal(hostileLabels.executed, undefined, 'hostile labels do not execute');

      // Exercise actual 7/30 day controls inside the settings panel.
      await page.evaluate(() => {
        document.querySelector('#settings-modal').classList.remove('hidden');
        document.querySelectorAll('[data-settings-panel]').forEach(panel => panel.classList.add('hidden'));
        document.querySelector('[data-settings-panel="usage"]').classList.remove('hidden');
      });
      const settings = page.locator('#settings-modal');
      assert.equal(await settings.isVisible(), true, 'settings modal opens');
      assert.equal(await page.locator('#usage-panel [data-usage-days="7"]').getAttribute('aria-pressed'), 'true');
      let settingsMetrics = await page.evaluate(() => ({
        viewportWidth: innerWidth, documentWidth: document.documentElement.scrollWidth,
        bodyWidth: document.body.scrollWidth, contentRight: document.querySelector('#usage-panel').getBoundingClientRect().right,
      }));
      assertNoOverflow(settingsMetrics, `${viewport.name} usage settings, 7 days`);
      await page.waitForTimeout(250);
      await settings.screenshot({ path: path.join(screenshotDir, `usage-settings-7-${viewport.name}.png`) });

      await page.locator('#usage-panel [data-usage-days="30"]').click();
      await page.waitForFunction(() => document.querySelectorAll('#usage-panel .usage-chart-day').length === 30);
      assert.equal(await page.locator('#usage-panel [data-usage-days="30"]').getAttribute('aria-pressed'), 'true');
      settingsMetrics = await page.evaluate(() => ({
        viewportWidth: innerWidth, documentWidth: document.documentElement.scrollWidth,
        bodyWidth: document.body.scrollWidth, contentRight: document.querySelector('#usage-panel').getBoundingClientRect().right,
      }));
      assertNoOverflow(settingsMetrics, `${viewport.name} usage settings, 30 days`);
      await settings.screenshot({ path: path.join(screenshotDir, `usage-settings-30-${viewport.name}.png`) });
      assert.ok(apiPeriods.includes(7) && apiPeriods.includes(30), `API receives 7- and 30-day requests: ${apiPeriods}`);

      // Force a failure, confirm accessible retry, then recover with real fixture data.
      apiMode = 'error';
      await page.evaluate(() => window.__usage.refreshUsage({ force: true }));
      await page.locator('#usage-panel [role="alert"]').waitFor();
      assert.match(await page.locator('#usage-panel [role="alert"]').innerText(), /HTTP 503/);
      apiMode = 'normal';
      await page.locator('#usage-panel button').filter({ hasText: 'Try again' }).click();
      await page.locator('#usage-panel .usage-table tbody th').waitFor();
      assert.equal(await page.locator('#usage-panel [data-usage-days="30"]').getAttribute('aria-pressed'), 'true', 'retry preserves chosen period');

      apiMode = 'empty';
      await page.evaluate(() => window.__usage.refreshUsage({ force: true }));
      await page.locator('#usage-panel .usage-empty').filter({ hasText: 'No activity in this period.' }).waitFor();
      assert.equal(await page.locator('#usage-panel .usage-value').nth(2).innerText(), 'Unavailable', 'empty period has no fabricated token total');
      const emptyRecent = await page.evaluate(() => document.querySelector('#home-dashboard .usage-recent')?.textContent || '');
      assert.ok(emptyRecent.includes('Your recent chats will appear here.'), 'empty state explains where recent chats appear');

      apiMode = 'unknown';
      await page.evaluate(() => window.__usage.refreshUsage({ force: true }));
      await page.locator('#usage-panel .usage-table tbody th').waitFor();
      const unknownTokens = await page.locator('#usage-panel').innerText();
      assert.match(unknownTokens, /1 with unspecified token source/);
      assert.equal(await page.locator('#usage-panel .usage-value').nth(2).innerText(), '47', 'unspecified source still reports available token count');

      apiMode = 'missing';
      await page.evaluate(() => window.__usage.refreshUsage({ force: true }));
      await page.locator('#usage-panel .usage-table tbody th').waitFor();
      const missingTokens = await page.locator('#usage-panel').innerText();
      assert.match(missingTokens, /1 without token metadata/);
      assert.equal(await page.locator('#usage-panel .usage-value').nth(2).innerText(), 'Unavailable', 'missing token metadata stays unavailable');

      assert.deepEqual(pageErrors, [], `browser runtime errors: ${pageErrors.join('\n')}`);
      await page.close();
    }
    console.log('PASS: usage dashboard and analytics render safely across periods, states, and viewports');
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
