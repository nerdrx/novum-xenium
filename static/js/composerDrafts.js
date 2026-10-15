// Persist only bounded plain-text drafts. Attachments are intentionally excluded.
const STORAGE_PREFIX = 'ody-composer-drafts:';
const MAX_DRAFTS = 40;
const MAX_DRAFT_CHARS = 20000;
const memoryDrafts = new Map();
const deletedDrafts = new Set();
const deleteChannel = (() => {
  try {
    return typeof window !== 'undefined' && 'BroadcastChannel' in window
      ? new BroadcastChannel('ody-composer-draft-deletes') : null;
  } catch { return null; }
})();

function _deletedKey(accountId, sessionId) {
  return `${String(accountId || '')}\u0000${String(sessionId || '')}`;
}

function _applyDraftDeletion(accountId, sessionId, storage) {
  const key = _draftKey(accountId, sessionId);
  deletedDrafts.add(_deletedKey(accountId, sessionId));
  memoryDrafts.delete(key);
  try { storage?.removeItem(key); } catch {}
}

if (deleteChannel) {
  deleteChannel.addEventListener('message', ({ data }) => {
    if (!data || typeof data.accountId !== 'string' || typeof data.sessionId !== 'string') return;
    _applyDraftDeletion(data.accountId, data.sessionId, _getStorage());
  });
}

function _accountPrefix(accountId) {
  return `${STORAGE_PREFIX}${encodeURIComponent(String(accountId || ''))}:`;
}

function _draftKey(accountId, sessionId) {
  return `${_accountPrefix(accountId)}${encodeURIComponent(String(sessionId || ''))}`;
}

function _draftCount(accountId, storage) {
  const prefix = _accountPrefix(accountId);
  let count = 0;
  try {
    for (let i = 0; i < storage.length; i += 1) {
      if (storage.key(i)?.startsWith(prefix)) count += 1;
    }
  } catch {}
  return count;
}

function _getStorage(storage) {
  if (storage) return storage;
  try { return globalThis.localStorage; } catch { return null; }
}

export function saveComposerDraft(sessionId, text, { accountId, incognito = false, storage: providedStorage } = {}) {
  if (!sessionId || !accountId) return { persisted: false, reason: 'unavailable' };
  const storage = _getStorage(providedStorage);
  const memoryKey = _draftKey(accountId, sessionId);
  if (deletedDrafts.has(_deletedKey(accountId, sessionId))) return { persisted: false, reason: 'deleted' };
  const value = String(text || '');
  if (!value) {
    memoryDrafts.delete(memoryKey);
    if (incognito) return { persisted: false, reason: null };
    try {
      storage.removeItem(memoryKey);
      return { persisted: true, reason: null };
    } catch {
      memoryDrafts.set(memoryKey, '');
      return { persisted: false, reason: 'storage' };
    }
  }
  if (incognito) {
    memoryDrafts.set(memoryKey, value);
    return { persisted: false, reason: 'incognito' };
  }
  if (value.length > MAX_DRAFT_CHARS) {
    memoryDrafts.set(memoryKey, value);
    try { storage.removeItem(memoryKey); } catch {}
    return { persisted: false, reason: 'size' };
  }
  let exists = false;
  try { exists = storage.getItem(memoryKey) !== null; } catch {}
  if (!exists && _draftCount(accountId, storage) >= MAX_DRAFTS) {
    memoryDrafts.set(memoryKey, value);
    return { persisted: false, reason: 'count' };
  }
  try {
    storage.setItem(memoryKey, JSON.stringify({ text: value }));
    memoryDrafts.delete(memoryKey);
    return { persisted: true, reason: null };
  } catch {
    memoryDrafts.set(memoryKey, value);
    return { persisted: false, reason: 'storage' };
  }
}

export function getComposerDraft(sessionId, { accountId, incognito = false, storage: providedStorage } = {}) {
  if (!sessionId || !accountId) return '';
  if (deletedDrafts.has(_deletedKey(accountId, sessionId))) return '';
  const key = _draftKey(accountId, sessionId);
  if (memoryDrafts.has(key)) return memoryDrafts.get(key);
  if (incognito) return '';
  const storage = _getStorage(providedStorage);
  try {
    const item = JSON.parse(storage.getItem(key) || 'null');
    return item && typeof item.text === 'string' ? item.text : '';
  } catch {
    return '';
  }
}

export function deleteComposerDraft(sessionId, { accountId, storage: providedStorage } = {}) {
  if (!sessionId || !accountId) return;
  const storage = _getStorage(providedStorage);
  _applyDraftDeletion(accountId, sessionId, storage);
  deleteChannel?.postMessage({ accountId: String(accountId), sessionId: String(sessionId) });
}
