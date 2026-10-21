// Persist only bounded plain-text drafts. Attachments are intentionally excluded.
const STORAGE_PREFIX = 'ody-composer-drafts:';
const MAX_DRAFTS = 40;
const MAX_DRAFT_CHARS = 20000;
const memoryDrafts = new Map();
const memoryPendingMetadata = new Map();
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
  memoryPendingMetadata.delete(key);
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

function _cleanPendingMetadata(value) {
  if (!value || typeof value !== 'object') return null;
  const { url = '', modelId = '', endpointId = '', source = 'manual' } = value;
  if ([url, modelId, endpointId, source].some(part => typeof part !== 'string')) return null;
  if (url.length > 2000 || modelId.length > 500 || endpointId.length > 500 || source.length > 40) return null;
  if (!url || !modelId) return null;
  return { url, modelId, endpointId, source };
}

export function saveComposerDraft(sessionId, text, { accountId, incognito = false, memoryOnly = false, storage: providedStorage, pendingMetadata } = {}) {
  if (!sessionId || !accountId) return { persisted: false, reason: 'unavailable' };
  const storage = _getStorage(providedStorage);
  const memoryKey = _draftKey(accountId, sessionId);
  if (deletedDrafts.has(_deletedKey(accountId, sessionId))) return { persisted: false, reason: 'deleted' };
  const value = String(text || '');
  const pending = _cleanPendingMetadata(pendingMetadata);
  if (!value && !pending) {
    memoryDrafts.delete(memoryKey);
    memoryPendingMetadata.delete(memoryKey);
    if (memoryOnly) return { persisted: false, reason: null };
    if (incognito) {
      try { storage?.removeItem(memoryKey); } catch {}
      return { persisted: false, reason: null };
    }
    try {
      storage.removeItem(memoryKey);
      return { persisted: true, reason: null };
    } catch {
      memoryDrafts.set(memoryKey, '');
      return { persisted: false, reason: 'storage' };
    }
  }
  if (memoryOnly) {
    memoryDrafts.set(memoryKey, value);
    if (pending) memoryPendingMetadata.set(memoryKey, pending);
    else memoryPendingMetadata.delete(memoryKey);
    return { persisted: false, reason: incognito ? 'incognito' : 'memory-only' };
  }
  if (incognito) {
    memoryDrafts.set(memoryKey, value);
    if (pending) memoryPendingMetadata.set(memoryKey, pending);
    else memoryPendingMetadata.delete(memoryKey);
    try { storage?.removeItem(memoryKey); } catch {}
    return { persisted: false, reason: 'incognito' };
  }
  if (value.length > MAX_DRAFT_CHARS) {
    memoryDrafts.set(memoryKey, value);
    if (pending) memoryPendingMetadata.set(memoryKey, pending);
    try { storage.removeItem(memoryKey); } catch {}
    return { persisted: false, reason: 'size' };
  }
  let exists = false;
  try { exists = storage.getItem(memoryKey) !== null; } catch {}
  if (!exists && _draftCount(accountId, storage) >= MAX_DRAFTS) {
    memoryDrafts.set(memoryKey, value);
    if (pending) memoryPendingMetadata.set(memoryKey, pending);
    return { persisted: false, reason: 'count' };
  }
  try {
    storage.setItem(memoryKey, JSON.stringify(pending ? { text: value, pending } : { text: value }));
    memoryDrafts.delete(memoryKey);
    memoryPendingMetadata.delete(memoryKey);
    return { persisted: true, reason: null };
  } catch {
    memoryDrafts.set(memoryKey, value);
    if (pending) memoryPendingMetadata.set(memoryKey, pending);
    return { persisted: false, reason: 'storage' };
  }
}

export function getComposerDraft(sessionId, { accountId, incognito = false, memoryOnly = false, storage: providedStorage } = {}) {
  if (!sessionId || !accountId) return '';
  if (deletedDrafts.has(_deletedKey(accountId, sessionId))) return '';
  const key = _draftKey(accountId, sessionId);
  if (memoryDrafts.has(key)) return memoryDrafts.get(key);
  if (incognito || memoryOnly) return '';
  const storage = _getStorage(providedStorage);
  try {
    const item = JSON.parse(storage.getItem(key) || 'null');
    return item && typeof item.text === 'string' ? item.text : '';
  } catch {
    return '';
  }
}

export function getPendingChatMetadata(sessionId, { accountId, incognito = false, memoryOnly = false, storage: providedStorage } = {}) {
  if (!sessionId || !accountId) return null;
  const key = _draftKey(accountId, sessionId);
  if (memoryPendingMetadata.has(key)) return memoryPendingMetadata.get(key);
  if (incognito || memoryOnly) return null;
  try {
    const record = JSON.parse(_getStorage(providedStorage).getItem(key) || 'null');
    return _cleanPendingMetadata(record?.pending);
  } catch { return null; }
}

export function transferComposerDraft(fromId, toId, options = {}) {
  if (!fromId || !toId || fromId === toId) return { persisted: false, reason: 'unavailable' };
  const { accountId, incognito = false, storage: providedStorage } = options;
  if (!accountId) return { persisted: false, reason: 'unavailable' };
  if (deletedDrafts.has(_deletedKey(accountId, toId))) return { persisted: false, reason: 'deleted' };
  const fromKey = _draftKey(accountId, fromId);
  const toKey = _draftKey(accountId, toId);
  if (incognito) {
    const result = saveComposerDraft(toId, getComposerDraft(fromId, options), options);
    if (result.reason !== 'unavailable' && result.reason !== 'deleted') saveComposerDraft(fromId, '', options);
    return result;
  }
  if (options.memoryOnly) {
    const pendingMetadata = getPendingChatMetadata(fromId, options);
    const result = saveComposerDraft(toId, getComposerDraft(fromId, options), { ...options, pendingMetadata });
    if (!['unavailable', 'deleted'].includes(result.reason)) saveComposerDraft(fromId, '', options);
    return result;
  }
  const storage = _getStorage(providedStorage);
  try {
    const stored = storage.getItem(fromKey);
    if (stored !== null && !memoryDrafts.has(fromKey)) {
      const record = JSON.parse(stored);
      if (typeof record?.text !== 'string') throw new Error('Invalid draft record');
      storage.setItem(toKey, JSON.stringify({ text: record.text }));
      storage.removeItem(fromKey);
      memoryDrafts.delete(fromKey);
      memoryPendingMetadata.delete(fromKey);
      return { persisted: true, reason: null };
    }
  } catch {
    // Keep the source intact if a storage move fails.
  }
  const text = getComposerDraft(fromId, options);
  const result = saveComposerDraft(toId, text, options);
  if (!result.reason || ['size', 'count', 'storage'].includes(result.reason)) {
    saveComposerDraft(fromId, '', options);
  }
  return result;
}

export function deleteComposerDraft(sessionId, { accountId, memoryOnly = false, storage: providedStorage } = {}) {
  if (!sessionId || !accountId) return;
  const storage = _getStorage(providedStorage);
  if (memoryOnly) {
    deletedDrafts.add(_deletedKey(accountId, sessionId));
    memoryDrafts.delete(_draftKey(accountId, sessionId));
    memoryPendingMetadata.delete(_draftKey(accountId, sessionId));
  } else {
    _applyDraftDeletion(accountId, sessionId, storage);
  }
  if (!memoryOnly) deleteChannel?.postMessage({ accountId: String(accountId), sessionId: String(sessionId) });
}
