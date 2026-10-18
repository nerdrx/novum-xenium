import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const { chromium } = await import(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

const sessionsSource = await readFile(new URL('../static/js/sessions.js', import.meta.url), 'utf8');
const pagerStart = sessionsSource.indexOf('function _clearHistoryPager()');
const pagerEnd = sessionsSource.indexOf('\nfunction _getIncognitoIds()', pagerStart);
const peekStart = sessionsSource.indexOf('let _peekingSessionId = null;');
const peekEnd = sessionsSource.indexOf('\nasync function _arcRestore', peekStart);
const closeStart = sessionsSource.indexOf('export function closeArchive()');
const closeEnd = sessionsSource.indexOf('\n}\n', closeStart) + 3;
assert.ok(pagerStart >= 0 && pagerEnd > pagerStart, 'history pager source is present');
assert.ok(peekStart >= 0 && peekEnd > peekStart, 'archive preview source is present');
assert.ok(closeStart >= 0 && closeEnd > closeStart, 'archive close source is present');
const pagerSource = sessionsSource.slice(pagerStart, pagerEnd);
const peekSource = sessionsSource.slice(peekStart, peekEnd);
const closeSource = sessionsSource.slice(closeStart, closeEnd).replace('export function closeArchive()', 'function closeArchive()');

let browser;
before(async () => { browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined, args: ['--no-sandbox'] }); });
after(async () => { await browser?.close(); });

async function setup() {
  const page = await browser.newPage();
  page.on('pageerror', error => console.error('fixture page error:', error));
  await page.setContent('<main id="chat-history" style="height:240px;overflow:auto"></main><div id="current-meta"></div>');
  await page.addScriptTag({ content: `
    let currentSessionId = 'A';
    let _historyPager = null;
    let _sessionNavToken = 0;
    const API_BASE = 'http://fixture.test';
    const _arc = { data: [{ id: 'A', name: 'Archive A' }, { id: 'B', name: 'Archive B' }] };
    const requests = [];
    window.fetch = url => new Promise(resolve => requests.push({ url: String(url), resolve }));
    const box = document.getElementById('chat-history');
    function _historyUrl(id, { limit, offset }) { return 'http://fixture.test/api/history/' + id + '?limit=' + limit + '&offset=' + offset; }
    function _historyPageLimit() { return 8; }
    function _renderHistoryMessage(msg, modelName) {
      const el = document.createElement('div'); el.className = 'msg'; el.dataset.model = modelName || ''; el.textContent = msg.content; return [el];
    }
    function closeArchive() {
      _archivePeekGeneration++;
      _peekingSessionId = null;
      const modal = document.getElementById('archive-modal');
      if (modal) modal.remove();
    }
    const uiModule = { showError() {}, scrollHistory() {} };
    window.chatModule = {
      hideWelcomeScreen() {},
      addMessage(role, content) { const el = document.createElement('div'); el.className = 'msg'; el.dataset.role = role; el.textContent = content; box.appendChild(el); },
    };
    ${pagerSource}
    ${peekSource}
    ${closeSource}
    window.fixture = {
      requests,
      pager(sessionId) { currentSessionId = sessionId; _clearHistoryPager(); _installHistoryPager(sessionId, { offset: 16, limit: 8, has_more_before: true }, 'model-' + sessionId); },
      openArchived(sessionId) { return _arcPeekOpen(sessionId); },
      selectNormal(sessionId) { _sessionNavToken++; _checkPeekCleanup(sessionId); currentSessionId = sessionId; },
      closeArchive,
      state() { return { currentSessionId, pager: _historyPager && { sessionId: _historyPager.sessionId, offset: _historyPager.offset, loading: _historyPager.loading }, peekSessionId: _peekingSessionId, messages: [...box.querySelectorAll('.msg')].map(el => el.textContent) }; },
    };
  ` });
  return page;
}

async function waitForRequests(page, count) {
  await page.waitForFunction(count => window.fixture.requests.length === count, count);
}

test('stale older-page response cannot render into or unlock the new session pager', async () => {
  const page = await setup();
  try {
    await page.evaluate(() => { window.fixture.pager('A'); const box = document.getElementById('chat-history'); box.scrollTop = 0; box.dispatchEvent(new Event('scroll')); });
    await waitForRequests(page, 1);
    await page.evaluate(() => { window.fixture.pager('B'); const box = document.getElementById('chat-history'); box.scrollTop = 0; box.dispatchEvent(new Event('scroll')); });
    await waitForRequests(page, 2);
    await page.evaluate(() => window.fixture.requests[0].resolve({ json: async () => ({ history: [{ role: 'user', content: 'A-only sentinel' }], offset: 1, has_more_before: true }) }));
    await page.waitForTimeout(0);
    const afterA = await page.evaluate(() => window.fixture.state());
    assert.deepEqual(afterA.messages, [], 'A history never appears in B chat');
    assert.deepEqual(afterA.pager, { sessionId: 'B', offset: 16, loading: true }, 'A completion leaves B pager identity, offset, and request lock untouched');
    await page.evaluate(() => window.fixture.requests[1].resolve({ json: async () => ({ history: [{ role: 'user', content: 'B-only sentinel' }], offset: 8, has_more_before: true }) }));
    await page.waitForFunction(() => window.fixture.state().pager.loading === false);
    const afterB = await page.evaluate(() => window.fixture.state());
    assert.deepEqual(afterB.messages, ['B-only sentinel']);
    assert.equal(afterB.pager.offset, 8);
  } finally { await page.close(); }
});

test('stale archive previews are ignored after a newer preview, normal selection, or close', async () => {
  const page = await setup();
  try {
    await page.evaluate(() => { window.previewA = window.fixture.openArchived('A'); window.previewB = window.fixture.openArchived('B'); });
    await waitForRequests(page, 2);
    await page.evaluate(() => window.fixture.requests[0].resolve({ json: async () => ({ history: [{ role: 'user', content: 'stale A preview' }], offset: 0, has_more_before: false }) }));
    await page.waitForTimeout(0);
    assert.deepEqual((await page.evaluate(() => window.fixture.state())).messages, []);
    await page.evaluate(() => window.fixture.requests[1].resolve({ json: async () => ({ history: [{ role: 'user', content: 'current B preview' }], offset: 0, has_more_before: false }) }));
    await page.waitForFunction(() => window.fixture.state().messages.length === 1);
    assert.deepEqual((await page.evaluate(() => window.fixture.state())).messages, ['current B preview']);
    await page.evaluate(() => { window.previewA = window.fixture.openArchived('A'); window.fixture.selectNormal('ordinary-session'); });
    await waitForRequests(page, 3);
    await page.evaluate(() => window.fixture.requests[2].resolve({ json: async () => ({ history: [{ role: 'user', content: 'late preview after selection' }], offset: 0, has_more_before: false }) }));
    await page.waitForTimeout(0);
    const afterSelection = await page.evaluate(() => window.fixture.state());
    assert.equal(afterSelection.currentSessionId, 'ordinary-session');
    assert.deepEqual(afterSelection.messages, ['current B preview']);
    await page.evaluate(() => { window.previewA = window.fixture.openArchived('A'); window.fixture.closeArchive(); });
    await waitForRequests(page, 4);
    await page.evaluate(() => window.fixture.requests[3].resolve({ json: async () => ({ history: [{ role: 'user', content: 'late preview after close' }], offset: 0, has_more_before: false }) }));
    await page.waitForTimeout(0);
    assert.deepEqual((await page.evaluate(() => window.fixture.state())).messages, ['current B preview']);
  } finally { await page.close(); }
});
