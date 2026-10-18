import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../static/js/sessions.js', import.meta.url), 'utf8');
const start = source.indexOf('function _startResearchPolling() {');
const end = source.indexOf('\nexport function markResearching', start);
assert.ok(start >= 0 && end > start, 'production research poll function is present');
const pollSource = source.slice(start, end);

function makePoller(fetchImpl) {
  const researching = new Set(['synthetic-session']);
  const cleared = [];
  let callback;
  let timer = null;
  let updates = 0;
  const startPolling = new Function(
    'researching', 'fetchImpl', 'setIntervalImpl', 'clearIntervalImpl', 'updateDots', 'getCallback',
    `
      const _researchingSessions = researching;
      let _researchPollTimer = null;
      const API_BASE = '/api';
      const fetch = fetchImpl;
      const setInterval = setIntervalImpl;
      const clearInterval = clearIntervalImpl;
      const _updateResearchDots = updateDots;
      ${pollSource}
      return {
        start: _startResearchPolling,
        tick: () => getCallback()(),
        isTracked: () => _researchingSessions.has('synthetic-session'),
        timer: () => _researchPollTimer,
      };
    `,
  )(
    researching,
    fetchImpl,
    fn => { callback = fn; timer = { id: 17 }; return timer; },
    id => cleared.push(id),
    () => { updates++; },
    () => callback,
  );
  return { ...startPolling, cleared, get updates() { return updates; }, get timerId() { return timer; } };
}

const response = (status, body = { status: 'running' }) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

test('research status polling retries transient failures until the task completes', async () => {
  const replies = [
    new TypeError('temporary network failure'),
    { ok: true, status: 200, json: async () => { throw new SyntaxError('temporary invalid response'); } },
    response(503),
    response(429),
    response(200, { status: 'running' }),
    response(200, { status: 'done' }),
  ];
  let requestCount = 0;
  const poller = makePoller(async () => {
    const reply = replies[requestCount++];
    if (reply instanceof Error) throw reply;
    return reply;
  });
  poller.start();
  const originalTimer = poller.timer();

  for (let i = 0; i < 5; i++) {
    await poller.tick();
    assert.equal(poller.isTracked(), true, `transient response ${i + 1} keeps the running session tracked`);
    assert.equal(poller.timer(), originalTimer, `transient response ${i + 1} keeps polling active`);
    assert.deepEqual(poller.cleared, []);
  }
  await poller.tick();
  assert.equal(requestCount, 6);
  assert.equal(poller.isTracked(), false, 'terminal status removes the session');
  assert.equal(poller.timer(), null, 'polling stops once no research sessions remain');
  assert.deepEqual(poller.cleared, [originalTimer]);
  assert.equal(poller.updates, 6);
});

test('invalid, unauthenticated, forbidden, and missing research states are removed', async () => {
  for (const status of [400, 401, 403, 404]) {
    const poller = makePoller(async () => response(status));
    poller.start();
    const originalTimer = poller.timer();
    await poller.tick();
    assert.equal(poller.isTracked(), false, `HTTP ${status} is terminal`);
    assert.equal(poller.timer(), null, `HTTP ${status} stops the empty poller`);
    assert.deepEqual(poller.cleared, [originalTimer]);
  }
});
