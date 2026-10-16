import assert from 'node:assert/strict';
import { awaitNativeDeviceUnregister } from '../../static/js/settings/nativePush.mjs';

const listeners = new Set();
let request;
const bridge = {
  addEventListener(type, listener) {
    assert.equal(type, 'message');
    listeners.add(listener);
  },
  removeEventListener(type, listener) {
    assert.equal(type, 'message');
    listeners.delete(listener);
  },
  postMessage(payload) { request = JSON.parse(payload); },
};

let done = false;
const waiting = awaitNativeDeviceUnregister(bridge, 500);
waiting.then(() => { done = true; });
assert.equal(request.method, 'unregister');
for (const listener of [...listeners]) listener({ data: { request_id: 'other' } });
await Promise.resolve();
assert.equal(done, false, 'unrelated bridge replies must not finish unregister');
for (const listener of [...listeners]) listener({ data: JSON.stringify({ request_id: request.request_id, ok: true }) });
await waiting;
assert.equal(done, true);
assert.equal(listeners.size, 0, 'matching bridge reply removes its listener');

let previousCalls = 0;
const priorHandler = () => { previousCalls++; };
const fallback = {
  onmessage: priorHandler,
  postMessage(payload) {
    const message = JSON.parse(payload);
    this.onmessage({ data: { request_id: message.request_id } });
  },
};
await awaitNativeDeviceUnregister(fallback, 500);
assert.equal(fallback.onmessage, priorHandler, 'fallback restores existing injected-object handler');
assert.equal(previousCalls, 0, 'fallback must wait on injected bridge, not global window events');

console.log(JSON.stringify({ bridgeObjectReply: true, unrelatedReplyIgnored: true, listenerRemoved: true }));
