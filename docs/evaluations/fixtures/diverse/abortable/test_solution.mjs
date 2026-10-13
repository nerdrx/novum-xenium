import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { abortable } from './solution.mjs';

const options = { timeout: 2000 };
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function inspectListeners(signal) {
  const originalAdd = signal.addEventListener.bind(signal);
  const originalRemove = signal.removeEventListener.bind(signal);
  const calls = { add: 0, remove: 0 };
  signal.addEventListener = function(type, ...args) {
    if (type === 'abort') calls.add++;
    return originalAdd(type, ...args);
  };
  signal.removeEventListener = function(type, ...args) {
    if (type === 'abort') calls.remove++;
    return originalRemove(type, ...args);
  };
  return { calls, assertClean() { assert.equal(getEventListeners(signal, 'abort').length, 0); } };
}

test('fulfillment preserves identity and removes listener', options, async () => {
  const controller = new AbortController();
  const listeners = inspectListeners(controller.signal);
  const source = deferred(), value = { result: 7 };
  const result = abortable(source.promise, controller.signal);
  source.resolve(value);
  assert.equal(await result, value);
  listeners.assertClean();
  assert.equal(controller.signal.aborted, false);
});

test('source rejection preserves exact error and removes listener', options, async () => {
  const controller = new AbortController();
  const listeners = inspectListeners(controller.signal);
  const source = deferred(), error = new Error('source');
  const checked = assert.rejects(abortable(source.promise, controller.signal), caught => caught === error);
  source.reject(error);
  await checked;
  listeners.assertClean();
});

test('already aborted signal wins without installing a listener and observes later rejection', options, async () => {
  const controller = new AbortController(), reason = { cancelled: true };
  controller.abort(reason);
  const listeners = inspectListeners(controller.signal);
  const source = deferred();
  const checked = assert.rejects(abortable(source.promise, controller.signal), caught => caught === reason);
  source.reject(new Error('late source failure must be handled'));
  await checked;
  await Promise.resolve();
  assert.equal(listeners.calls.add, 0);
  listeners.assertClean();
});

test('already aborted signal beats previously fulfilled source', options, async () => {
  const controller = new AbortController(), reason = new Error('already stopped');
  controller.abort(reason);
  await assert.rejects(abortable(Promise.resolve('source value'), controller.signal), caught => caught === reason);
});

test('later abort rejects exact reason, cleans listener, and still observes late source rejection', options, async () => {
  const controller = new AbortController(), reason = new Error('stop');
  const listeners = inspectListeners(controller.signal);
  const source = deferred();
  const checked = assert.rejects(abortable(source.promise, controller.signal), caught => caught === reason);
  controller.abort(reason);
  await checked;
  listeners.assertClean();
  source.reject(new Error('source continues and fails after abort'));
  await Promise.resolve();
});

test('settled fulfillment wins over later abort and does not cancel source', options, async () => {
  const controller = new AbortController();
  const source = deferred(), value = { done: true };
  const result = abortable(source.promise, controller.signal);
  source.resolve(value);
  assert.equal(await result, value);
  controller.abort(new Error('too late'));
  assert.equal(await result, value);
  assert.equal(await source.promise, value);
});

test('settled rejection wins over later abort', options, async () => {
  const controller = new AbortController(), error = new Error('first failure');
  const result = abortable(Promise.reject(error), controller.signal);
  await assert.rejects(result, caught => caught === error);
  controller.abort(new Error('too late'));
  await assert.rejects(result, caught => caught === error);
});

test('multiple calls sharing signal remain independent and clean up all listeners', options, async () => {
  const controller = new AbortController(), reason = new Error('stop remaining');
  const listeners = inspectListeners(controller.signal);
  const first = deferred(), second = deferred();
  const firstResult = abortable(first.promise, controller.signal);
  const secondChecked = assert.rejects(abortable(second.promise, controller.signal), caught => caught === reason);
  first.resolve(0);
  assert.equal(await firstResult, 0);
  controller.abort(reason);
  await secondChecked;
  second.resolve(false);
  assert.equal(await second.promise, false);
  assert.equal(await firstResult, 0);
  listeners.assertClean();
});


test('existing signal listeners and onabort handler remain intact', options, async () => {
  const controller = new AbortController();
  let eventCalls = 0, propertyCalls = 0;
  const external = () => { eventCalls++; };
  const handler = () => { propertyCalls++; };
  controller.signal.addEventListener('abort', external);
  controller.signal.onabort = handler;
  const before = getEventListeners(controller.signal, 'abort');
  assert.equal(await abortable(Promise.resolve('ok'), controller.signal), 'ok');
  assert.equal(controller.signal.onabort, handler);
  assert.deepEqual(getEventListeners(controller.signal, 'abort'), before);
  controller.abort('later');
  assert.equal(eventCalls, 1);
  assert.equal(propertyCalls, 1);
});
