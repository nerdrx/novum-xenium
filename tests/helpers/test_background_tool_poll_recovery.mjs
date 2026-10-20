import assert from 'node:assert/strict';
import http from 'node:http';
import { startBackgroundToolJobs } from '../../static/js/backgroundToolJobs.js';

// Actual module and native fetch; only DOM/timer scheduling are synthetic.
const nativeFetch = globalThis.fetch;
const nativeSetTimeout = globalThis.setTimeout;
const nativeClearTimeout = globalThis.clearTimeout;
const originals = Object.fromEntries(['document', 'window', 'setInterval', 'clearInterval'].map(k => [k, globalThis[k]]));
const deadlines = new Map();
const intervals = new Set();
const listeners = new Set();
const appended = [];
let current = 'a';
let mode = 'headers';
let requests = 0;
let bodyReads = 0;
let held;
let origin;
const box = {
  querySelector: () => null,
  querySelectorAll: () => appended.map(message => ({ dataset: { dbId: message.metadata._db_id } })),
};
globalThis.document = {
  hidden: false,
  querySelector: selector => selector === '#chat-history' ? box : null,
  addEventListener: (_event, callback) => listeners.add(callback),
  removeEventListener: (_event, callback) => listeners.delete(callback),
};
globalThis.window = { __odysseusSessionReadyId: current };
globalThis.setInterval = callback => { intervals.add(callback); return callback; };
globalThis.clearInterval = callback => intervals.delete(callback);
globalThis.setTimeout = (callback, delay, ...args) => {
  if (delay !== 15000) return nativeSetTimeout(callback, delay, ...args);
  const token = {};
  deadlines.set(token, () => { deadlines.delete(token); callback(...args); });
  return token;
};
globalThis.clearTimeout = token => deadlines.delete(token) || nativeClearTimeout(token);
globalThis.fetch = async (url, options) => {
  const target = new URL(url, origin);
  assert.equal(target.origin, origin, 'fixture forbids external requests');
  const response = await nativeFetch(target, options);
  const readJson = response.json.bind(response);
  response.json = () => { bodyReads++; return readJson(); };
  return response;
};
const reply = response => {
  if (response.destroyed) return;
  if (!response.headersSent) response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ jobs: [{ status: 'delivered', message: {
    role: 'assistant', content: 'synthetic research result', metadata: { _db_id: 'result-1' },
  } }] }));
};
const server = http.createServer((request, response) => {
  assert.match(request.url, /^\/api\/research\/chat-jobs\/[ab]$/);
  requests++;
  if (mode === 'headers' || mode === 'body') {
    held = response;
    if (mode === 'body') { response.writeHead(200, { 'Content-Type': 'application/json' }); response.flushHeaders(); }
    return;
  }
  if (mode === 'http-error') { response.writeHead(503); response.end(); return; }
  reply(response);
});
const waitFor = async (predicate, message) => {
  const until = Date.now() + 5000;
  while (!predicate()) {
    assert.ok(Date.now() < until, message);
    await new Promise(resolve => nativeSetTimeout(resolve, 10));
  }
};
let stop;
const start = () => startBackgroundToolJobs({
  getSessionId: () => current,
  addMessage: (role, content, model, metadata) => appended.push({ role, content, model, metadata }),
  base: origin,
});
const tick = () => { for (const callback of intervals) callback(); };
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  for (const phase of ['headers', 'body']) {
    mode = phase; held = null; appended.length = 0;
    const previousBodyReads = bodyReads;
    stop = start();
    await waitFor(() => held, 'held poll reached server');
    if (phase === 'body') await waitFor(() => bodyReads > previousBodyReads, 'native JSON read is waiting for body');
    assert.equal(deadlines.size, 1, `${phase}: held poll must have a whole-request deadline`);
    const oldCount = requests;
    tick(); await new Promise(resolve => nativeSetTimeout(resolve, 20));
    assert.equal(requests, oldCount, 'held poll prevents overlapping requests');
    for (const expire of [...deadlines.values()]) expire();
    await waitFor(() => held.destroyed, 'abort closes held response');
    mode = 'normal';
    tick();
    await waitFor(() => requests > oldCount, 'later poll retries after timeout');
    await waitFor(() => appended.length === 1, 'recovered result appended');
    assert.equal(deadlines.size, 0);
    tick(); await waitFor(() => deadlines.size === 0, 'normal poll settles');
    assert.equal(appended.length, 1, 'repeated delivered result deduplicated');
    stop(); stop = null;
    assert.equal(intervals.size, 0); assert.equal(listeners.size, 0);
  }
  mode = 'body'; held = null; appended.length = 0;
  stop = start(); await waitFor(() => held, 'cleanup poll held');
  stop(); stop = null;
  await waitFor(() => deadlines.size === 0, 'cleanup clears request deadline');
  await waitFor(() => held.destroyed, 'cleanup aborts native fetch');
  assert.equal(appended.length, 0);
  mode = 'body'; held = null;
  stop = start(); await waitFor(() => held, 'ownership poll held');
  current = 'b'; window.__odysseusSessionReadyId = current;
  reply(held);
  await waitFor(() => deadlines.size === 0, 'stale response settles');
  assert.equal(appended.length, 0, 'chat B never receives A result');
  stop(); stop = null;
  assert.equal(intervals.size, 0); assert.equal(listeners.size, 0);
  console.log(JSON.stringify({ headersAndBodyRetry: true, cleanupAborts: true, ownershipPreserved: true, deduplicated: true, loopbackOnly: true, activeTimers: deadlines.size }));
} finally {
  stop?.();
  globalThis.fetch = nativeFetch;
  globalThis.setTimeout = nativeSetTimeout;
  globalThis.clearTimeout = nativeClearTimeout;
  for (const [key, value] of Object.entries(originals)) {
    if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
  }
  server.closeAllConnections?.();
  await new Promise(resolve => server.close(resolve));
}
