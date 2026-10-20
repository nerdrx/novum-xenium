import assert from 'node:assert/strict';
import http from 'node:http';
import { runProviderDeviceFlow } from '../../static/js/providerDeviceFlow.js';

const nativeSetTimeout = globalThis.setTimeout;
const nativeClearTimeout = globalThis.clearTimeout;
const activeDeadlineTimers = new Set();
globalThis.setTimeout = (callback, delay, ...args) => {
  if (delay !== 60_000) return nativeSetTimeout(callback, delay, ...args);
  let timer;
  timer = nativeSetTimeout(() => {
    activeDeadlineTimers.delete(timer);
    callback(...args);
  }, 1000);
  activeDeadlineTimers.add(timer);
  return timer;
};
globalThis.clearTimeout = timer => {
  activeDeadlineTimers.delete(timer);
  return nativeClearTimeout(timer);
};

let mode = 'normal';
const pending = new Map();
const sendStart = res => {
  if (res.destroyed) return;
  if (!res.headersSent) res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ poll_id: 'synthetic-poll', verification_uri: '/synthetic', interval: 2, expires_in: 60 }));
};
const sendAuthorized = res => {
  if (res.destroyed) return;
  if (!res.headersSent) res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'authorized', endpoint: { id: 'synthetic-endpoint', models: ['synthetic-model'] } }));
};
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/__state') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ pending: [...pending.keys()] }));
  }
  if (url.pathname === '/__release') {
    const key = url.searchParams.get('key');
    const held = pending.get(key);
    if (held) {
      pending.delete(key);
      if (key.startsWith('start')) sendStart(held);
      else sendAuthorized(held);
    }
    res.writeHead(204);
    return res.end();
  }
  if (url.pathname === '/api/copilot/device/start' && req.method === 'POST') {
    if (mode === 'http-error') {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ detail: 'synthetic backend detail' }));
    }
    if (mode === 'expired') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ poll_id: 'synthetic-poll', interval: 2, expires_in: 1 }));
    }
    if (mode === 'start-headers' || mode === 'start-body') {
      pending.set(mode, res);
      if (mode === 'start-body') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.flushHeaders();
      }
      return;
    }
    return sendStart(res);
  }
  if (url.pathname === '/api/copilot/device/poll' && req.method === 'POST') {
    if (mode === 'poll-headers' || mode === 'poll-body') {
      pending.set(mode, res);
      if (mode === 'poll-body') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.flushHeaders();
      }
      return;
    }
    return sendAuthorized(res);
  }
  res.writeHead(404); res.end();
});

async function waitUntilHeld(key) {
  const until = Date.now() + 3000;
  while (Date.now() < until) {
    const state = await (await fetch(`${origin}/__state`)).json();
    if (state.pending.includes(key)) return;
    await new Promise(resolve => nativeSetTimeout(resolve, 10));
  }
  throw new Error(`request was not held: ${key}`);
}
async function run(modeName, options = {}) {
  mode = modeName;
  try {
    return await runProviderDeviceFlow('copilot', {
      fetchImpl: (url, init) => {
        const target = new URL(url, origin);
        assert.equal(target.origin, origin, 'device-flow fixture forbids external requests');
        return fetch(target, init);
      },
      openWindow: () => {},
      sleep: async () => {},
      ...options,
    });
  } finally {
    assert.equal(activeDeadlineTimers.size, 0, `request deadline timer cleaned after ${modeName}`);
  }
}

let origin;
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  const timeoutMessage = 'Sign-in request timed out. Check Added Models before trying again; the connection may still complete.';
  const timeouts = {};
  for (const modeName of ['start-headers', 'start-body', 'poll-headers', 'poll-body']) {
    const outcome = run(modeName).then(value => ({ value }), error => ({ error: error.message }));
    await waitUntilHeld(modeName);
    assert.equal(activeDeadlineTimers.size, 1, 'deadline stays active while response is held');
    const result = await outcome;
    assert.deepEqual(result, { error: timeoutMessage }, `${modeName} is bounded through headers and body`);
    assert.equal(activeDeadlineTimers.size, 0);
    await fetch(`${origin}/__release?key=${modeName}`);
    timeouts[modeName] = true;
  }

  mode = 'normal';
  const success = await run('normal');
  assert.equal(success.status, 'authorized');
  const httpError = await run('http-error').then(() => null, error => error.message);
  assert.equal(httpError, 'synthetic backend detail');
  const networkError = await run('network-error', { fetchImpl: async () => { throw new Error('network offline'); } })
    .then(() => null, error => error.message);
  assert.equal(networkError, 'network offline');
  let now = 0;
  const expired = await run('expired', { now: () => now, sleep: async () => { now += 2000; } });
  assert.deepEqual(expired, { status: 'expired' });
  assert.equal(activeDeadlineTimers.size, 0, 'no deadline timers remain after all outcomes');
  console.log(JSON.stringify({ timeouts, successPreserved: success.status === 'authorized', httpDetailPreserved: httpError, networkErrorPreserved: networkError, existingExpiryPreserved: expired.status === 'expired', activeDeadlineTimers: activeDeadlineTimers.size, loopbackOnly: true }));
} finally {
  for (const [key, res] of pending) {
    pending.delete(key);
    if (!res.destroyed) {
      if (key.startsWith('start')) sendStart(res);
      else sendAuthorized(res);
    }
  }
  globalThis.setTimeout = nativeSetTimeout;
  globalThis.clearTimeout = nativeClearTimeout;
  if (server.closeAllConnections) server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
