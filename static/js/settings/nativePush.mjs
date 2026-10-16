export function awaitNativeDeviceUnregister(bridge, timeoutMs = 5000) {
  if (!bridge?.postMessage) return Promise.resolve();
  return new Promise(resolve => {
    const requestId = globalThis.crypto?.randomUUID?.()
      || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let settled = false;
    let timer;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      bridge.removeEventListener?.('message', onMessage);
      if (!bridge.removeEventListener && bridge.onmessage === onMessage) bridge.onmessage = previous;
      resolve();
    };
    const onMessage = event => {
      let message = event?.data;
      if (typeof message === 'string') {
        try { message = JSON.parse(message); } catch (_) { return; }
      }
      if (message?.request_id === requestId) finish();
    };
    const previous = bridge.onmessage;
    if (bridge.addEventListener) bridge.addEventListener('message', onMessage);
    else bridge.onmessage = onMessage;
    timer = setTimeout(finish, timeoutMs);
    try {
      bridge.postMessage(JSON.stringify({ method: 'unregister', request_id: requestId }));
    } catch (_) { finish(); }
  });
}
