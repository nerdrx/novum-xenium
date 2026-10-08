export function setSessionHistory(id, { replace = false } = {}) {
  const route = `${window.location.pathname}${window.location.search}${id ? `#${id}` : ''}`;
  if (`${window.location.pathname}${window.location.search}${window.location.hash}` === route) return false;
  window.history[replace ? 'replaceState' : 'pushState'](null, '', route);
  return true;
}

export function installSessionHistory({ getCurrentSessionId, getSessions, selectSession, showHome, isReady }) {
  const navigate = () => {
    if (!isReady()) return;
    const id = window.location.hash.slice(1);
    if (/^(document|note|image|email|event|task|skill|research)-/.test(id) || /^open=notes&note=/.test(id)) return;
    if (id === (getCurrentSessionId() || '')) return;
    if (!id) return showHome();
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
