// Reconcile browser-private state before it is used by startup or sends.
const USER_KEY = 'odysseus-auth-user';
const KEEP_KEYS = new Set(['odysseus-last-user', USER_KEY]);

function clearPrivateState() {
  const remove = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && !KEEP_KEYS.has(key)) remove.push(key);
  }
  remove.forEach(key => localStorage.removeItem(key));
  sessionStorage.clear();
  window.__odysseusDefaultChat = null;
}

async function reconcileAuthState() {
  const startingStorageRevision = externalStorageRevision;
  const controller = new AbortController();
  let resolveDeadline;
  const deadline = new Promise(resolve => { resolveDeadline = resolve; });
  const timer = setTimeout(() => {
    controller.abort();
    resolveDeadline(null);
  }, 15000);
  try {
    const response = await Promise.race([
      (async () => {
        const res = await fetch('/api/auth/status', { credentials: 'same-origin', signal: controller.signal });
        if (!res.ok) return null;
        return await res.json();
      })(),
      deadline,
    ]);
    const validUser = response && response.authenticated === true
      && typeof response.username === 'string' && response.username.trim();
    const anonymous = response && response.configured === false
      && response.authenticated === false && response.username === null;
    if (!validUser && !anonymous) return { verified: false, switched: false, data: null };

    const identity = validUser ? response.username.trim() : '';
    let cached;
    try { cached = localStorage.getItem(USER_KEY); }
    catch (_) { return { verified: true, switched: false, storageAvailable: false, data: response, identity }; }
    const switched = !!cached && cached !== identity;
    const changedDuringRequest = externalStorageRevision !== startingStorageRevision
      && externalStorageIdentity !== identity;
    let storageAvailable = true;
    if (switched && !changedDuringRequest) {
      try { clearPrivateState(); } catch (_) { storageAvailable = false; }
    }
    if (!changedDuringRequest) {
      try { localStorage.setItem(USER_KEY, identity); } catch (_) { storageAvailable = false; }
    }
    try { void sessionStorage.length; } catch (_) { storageAvailable = false; }
    return { verified: true, switched: switched || changedDuringRequest, storageAvailable, data: response, identity };
  } catch (_) {
    return { verified: false, switched: false, data: null };
  } finally {
    clearTimeout(timer);
  }
}

let verifiedState = null;
let inflight = null;
let externalStorageRevision = 0;
let externalStorageIdentity = null;

window.addEventListener('storage', event => {
  if (event.key !== USER_KEY && event.key !== null) return;
  externalStorageRevision++;
  externalStorageIdentity = event.newValue ?? '';
  if (verifiedState?.verified && externalStorageIdentity !== verifiedState.identity) verifiedState.switched = true;
});

function latchChangedIdentity() {
  if (!verifiedState?.verified || verifiedState.switched) return verifiedState;
  try {
    const cachedIdentity = localStorage.getItem(USER_KEY);
    if (cachedIdentity !== verifiedState.identity
      && !(verifiedState.storageAvailable === false && cachedIdentity === null)) verifiedState.switched = true;
  } catch (_) {}
  return verifiedState;
}

function requestAuthState() {
  latchChangedIdentity();
  if (verifiedState) return Promise.resolve(verifiedState);
  if (inflight) return inflight;
  const request = reconcileAuthState().then(state => {
    if (state.verified) {
      if (externalStorageRevision && externalStorageIdentity !== state.identity) state.switched = true;
      verifiedState = state;
      latchChangedIdentity();
    }
    return state;
  }).finally(() => {
    if (inflight === request) inflight = null;
  });
  inflight = request;
  return request;
}

export const authStatePromise = requestAuthState();
export function getAuthState() { return requestAuthState(); }
export function getKnownAuthState() { return latchChangedIdentity(); }
