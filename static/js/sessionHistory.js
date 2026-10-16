export function setSessionHistory(id, { replace = false } = {}) {
  const route = `${window.location.pathname}${window.location.search}${id ? `#${id}` : ''}`;
  if (`${window.location.pathname}${window.location.search}${window.location.hash}` === route) return false;
  window.history[replace ? 'replaceState' : 'pushState'](null, '', route);
  return true;
}

export function setPendingChatHistory(id, { replace = false } = {}) {
  const route = `${window.location.pathname}${window.location.search}#newchat-${encodeURIComponent(String(id))}`;
  if (`${window.location.pathname}${window.location.search}${window.location.hash}` === route) return false;
  window.history[replace ? 'replaceState' : 'pushState'](null, '', route);
  return true;
}

export function pendingChatRouteId(hash = window.location.hash) {
  const match = String(hash || '').slice(1).match(/^newchat-(.+)$/);
  if (!match) return '';
  try { return decodeURIComponent(match[1]); } catch { return ''; }
}

export function installSessionHistory({ getCurrentSessionId, getCurrentPendingDraftId, getSessions, selectSession, restorePendingChat, showHome, isReady }) {
  const navigate = () => {
    if (!isReady()) return;
    const id = window.location.hash.slice(1);
    if (/^(document|note|image|email|event|task|skill|research|notification)-/.test(id) || /^open=notes&note=/.test(id)) return;
    const pendingId = pendingChatRouteId();
    if (pendingId) {
      if (pendingId !== (getCurrentPendingDraftId?.() || '')) restorePendingChat?.(pendingId);
      return;
    }
    if (!id) {
      if (getCurrentPendingDraftId?.() || getCurrentSessionId()) showHome();
      return;
    }
    if (id === getCurrentSessionId()) return;
    if (getSessions().some(session => !session.archived && String(session.id) === id)) {
      selectSession(id);
    } else {
      showHome();
    }
  };
  window.addEventListener('popstate', navigate);
  window.addEventListener('hashchange', navigate);
  return () => {
    window.removeEventListener('popstate', navigate);
    window.removeEventListener('hashchange', navigate);
  };
}
