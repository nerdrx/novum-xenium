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
  const timeouts = new Map();
  let callback;
  let timer = null;
  let nextTimeoutId = 0;
  let updates = 0;
  const startPolling = new Function(
    'researching', 'fetchImpl', 'setIntervalImpl', 'clearIntervalImpl', 'setTimeoutImpl', 'clearTimeoutImpl', 'AbortControllerImpl', 'updateDots', 'getCallback',
    `
      const _researchingSessions = researching;
      let _researchPollTimer = null;
      const API_BASE = '/api';
      const fetch = fetchImpl;
      const setInterval = setIntervalImpl;
      const clearInterval = clearIntervalImpl;
      const setTimeout = setTimeoutImpl;
      const clearTimeout = clearTimeoutImpl;
      const AbortController = AbortControllerImpl;
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
    (fn, delay) => { assert.equal(delay, 15000); const id = ++nextTimeoutId; timeouts.set(id, fn); return id; },
    id => timeouts.delete(id),
    AbortController,
    () => { updates++; },
    () => callback,
  );
  return {
    ...startPolling,
    cleared,
    fireTimeout() { assert.equal(timeouts.size, 1); timeouts.values().next().value(); },
    timeoutCount: () => timeouts.size,
    get updates() { return updates; },
    get timerId() { return timer; },
  };
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
    assert.equal(poller.timeoutCount(), 0, `transient response ${i + 1} clears its request timeout`);
    assert.deepEqual(poller.cleared, []);
  }
  await poller.tick();
  assert.equal(requestCount, 6);
  assert.equal(poller.isTracked(), false, 'terminal status removes the session');
  assert.equal(poller.timer(), null, 'polling stops once no research sessions remain');
  assert.deepEqual(poller.cleared, [originalTimer]);
  assert.equal(poller.timeoutCount(), 0);
  assert.equal(poller.updates, 6);
});

test('a second interval tick cannot overlap an unresolved status request', async () => {
  let requestCount = 0;
  let resolveFirst;
  const poller = makePoller(() => {
    requestCount++;
    if (requestCount === 1) return new Promise(resolve => { resolveFirst = resolve; });
    return Promise.resolve(response(200, { status: 'done' }));
  });
  poller.start();
  const firstTick = poller.tick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(poller.timeoutCount(), 1);
  await poller.tick();
  assert.equal(requestCount, 1, 'the next timer callback is skipped while the first batch is active');
  resolveFirst(response(200, { status: 'running' }));
  await firstTick;
  assert.equal(poller.timeoutCount(), 0, 'success releases its request timeout');
  await poller.tick();
  assert.equal(requestCount, 2, 'a later tick runs after the first batch releases its lock');
  assert.equal(poller.isTracked(), false);
});

test('a timed-out request aborts and releases the batch for the next retry', async () => {
  let requestCount = 0;
  let firstSignal;
  const poller = makePoller((_url, { signal }) => {
    requestCount++;
    if (requestCount === 1) {
      firstSignal = signal;
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      });
    }
    return Promise.resolve(response(200, { status: requestCount === 2 ? 'running' : 'done' }));
  });
  poller.start();
  const pending = poller.tick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requestCount, 1);
  assert.equal(poller.timeoutCount(), 1);
  poller.fireTimeout();
  await pending;
  assert.equal(firstSignal.aborted, true, 'the request-local timeout aborts the pending fetch');
  assert.equal(poller.isTracked(), true, 'timeout remains retryable');
  assert.equal(poller.timeoutCount(), 0, 'timeout is cleaned up in finally');
  await poller.tick();
  assert.equal(requestCount, 2, 'the guard is released after timeout');
  assert.equal(poller.isTracked(), true);
  assert.equal(poller.timeoutCount(), 0);
  await poller.tick();
  assert.equal(requestCount, 3);
  assert.equal(poller.isTracked(), false);
});

test('the request timeout remains active while decoding the status body', async () => {
  let requestCount = 0;
  let firstSignal;
  const poller = makePoller((_url, { signal }) => {
    requestCount++;
    if (requestCount === 1) {
      firstSignal = signal;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
        }),
      });
    }
    return Promise.resolve(response(200, { status: 'done' }));
  });
  poller.start();
  const pending = poller.tick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(poller.timeoutCount(), 1, 'the request timer is retained during body parsing');
  poller.fireTimeout();
  await pending;
  assert.equal(firstSignal.aborted, true);
  assert.equal(poller.isTracked(), true, 'a timed-out body remains retryable');
  assert.equal(poller.timeoutCount(), 0);
  await poller.tick();
  assert.equal(requestCount, 2);
  assert.equal(poller.isTracked(), false);
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
    assert.equal(poller.timeoutCount(), 0, `HTTP ${status} clears its request timeout`);
  }
});
