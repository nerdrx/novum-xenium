// Search Chat Module — Ctrl+K command palette for searching conversations

import uiModule from './ui.js?v=20260916largetoolscroll1';
import sessionModule from './sessions.js';

let API_BASE = '';
let debounceTimer = null;
let selectedIndex = -1;
let results = [];
let returnFocus = null;
let restoreMobileNavigation = null;
let searchGeneration = 0;
const QUICK_ACTIONS = [
  { id: 'new_chat', label: 'New chat', detail: 'Start a fresh conversation', keywords: 'new conversation' },
  { id: 'workspace_files', label: 'Files & project tools', detail: 'Choose a project and review its files', keywords: 'workspace project files repository' },
  { id: 'settings', label: 'Settings', detail: 'Preferences and shortcuts', keywords: 'preferences shortcuts' },
];

function el(id) { return document.getElementById(id); }

function hideMobileSidebarForSearch() {
  if (window.innerWidth >= 768) return () => {};
  const sidebar = el('sidebar');
  const rail = el('icon-rail');
  const backdrop = el('sidebar-backdrop');
  const sidebarVisible = sidebar && !sidebar.classList.contains('hidden');
  const railWasMini = rail?.classList.contains('mobile-mini');
  const railStyle = rail?.style.cssText;
  const backdropWasVisible = backdrop?.classList.contains('visible');
  let changed = false;
  if (sidebar && !sidebar.classList.contains('hidden')) {
    sidebar.classList.add('hidden');
    changed = true;
  }
  if (rail && rail.classList.contains('mobile-mini')) {
    rail.classList.remove('mobile-mini');
    rail.style.cssText = '';
    changed = true;
  }
  if (backdrop) backdrop.classList.remove('visible');
  if (changed && typeof window.syncRailSide === 'function') {
    try { window.syncRailSide(); } catch (_) {}
  }
  return () => {
    if (sidebar) sidebar.classList.toggle('hidden', !sidebarVisible);
    if (rail) {
      rail.classList.toggle('mobile-mini', !!railWasMini);
      rail.style.cssText = railStyle || '';
    }
    if (backdrop) backdrop.classList.toggle('visible', !!backdropWasVisible);
    if (changed && typeof window.syncRailSide === 'function') {
      try { window.syncRailSide(); } catch (_) {}
    }
  };
}

export function openSearch() {
  if (isOpen()) return;
  const overlay = el('search-overlay');
  if (!overlay) return;
  searchGeneration++;
  if (debounceTimer) clearTimeout(debounceTimer);
  returnFocus = document.activeElement;
  restoreMobileNavigation = hideMobileSidebarForSearch();
  // Freeze the opening offset before focus summons the mobile keyboard.
  // A live `vh` value shrinks during the keyboard animation and visibly
  // pulls the search popup upward even though it is already unobscured.
  const openingHeight = window.innerHeight || document.documentElement.clientHeight;
  const openingTop = Math.max(56, Math.min(140, Math.round(openingHeight * 0.15)));
  overlay.style.setProperty('--search-overlay-top', `${openingTop}px`);
  overlay.classList.remove('hidden');
  const input = el('search-input');
  if (input) {
    input.setAttribute('aria-expanded', 'true');
    input.value = '';
    input.focus();
  }
  selectedIndex = -1;
  results = [];
  const container = el('search-results');
  if (container) {
    container.setAttribute('aria-busy', 'false');
  }
  el('search-input')?.removeAttribute('aria-activedescendant');
  renderResults([], '');
}

export function closeSearch({ restoreFocus = true, restoreNavigation = true } = {}) {
  const overlay = el('search-overlay');
  if (!overlay) return;
  searchGeneration++;
  if (debounceTimer) clearTimeout(debounceTimer);
  overlay.classList.add('hidden');
  const input = el('search-input');
  input?.setAttribute('aria-expanded', 'false');
  input?.removeAttribute('aria-activedescendant');
  const container = el('search-results');
  if (container) {
    container.innerHTML = '';
    container.setAttribute('aria-busy', 'false');
  }
  selectedIndex = -1;
  results = [];
  if (restoreNavigation) restoreMobileNavigation?.();
  restoreMobileNavigation = null;
  const target = returnFocus;
  returnFocus = null;
  if (restoreFocus && target?.isConnected && typeof target.focus === 'function') target.focus();
}

export function isOpen() {
  const overlay = el('search-overlay');
  return overlay && !overlay.classList.contains('hidden');
}

var escapeHtml = uiModule.esc;

function highlightMatch(text, query) {
  if (!query) return escapeHtml(text);
  const escaped = escapeHtml(text);
  const regex = new RegExp('(' + query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
  return escaped.replace(regex, '<mark class="search-highlight">$1</mark>');
}

function formatTimestamp(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  const diff = now - d;
  if (diff < 86400000) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  if (diff < 604800000) {
    return d.toLocaleDateString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}

function actionMarkup(action, index) {
  return `<div class="search-result-item search-command-item" id="search-option-${index}" role="option" aria-label="${escapeHtml(action.label)} — ${escapeHtml(action.detail)}" aria-selected="false" data-index="${index}" data-action="${action.id}">
    <div class="search-result-role">Action</div>
    <div class="search-result-snippet">${escapeHtml(action.label)} <span class="search-command-detail">${escapeHtml(action.detail)}</span></div>
  </div>`;
}

function restoreActionSelection(container, actionId) {
  const items = container.querySelectorAll('.search-result-item');
  selectedIndex = actionId ? Array.from(items).findIndex(item => item.dataset.action === actionId) : -1;
  updateSelection();
}

function showSearchError(query) {
  const container = el('search-results');
  if (!container) return;
  const selectedAction = container.querySelectorAll('.search-result-item')[selectedIndex]?.dataset.action;
  const normalizedQuery = query.toLocaleLowerCase();
  const actions = QUICK_ACTIONS.filter(action =>
    `${action.label} ${action.detail} ${action.keywords}`.toLocaleLowerCase().includes(normalizedQuery));
  const html = actions.map(actionMarkup).join('')
    + '<div class="search-empty" role="status">Conversation search failed. Try again.</div>';
  container.innerHTML = html;
  container.setAttribute('aria-busy', 'false');
  restoreActionSelection(container, selectedAction);
  container.querySelectorAll('.search-result-item').forEach(item => item.addEventListener('click', () => activateResult(item)));
}

function renderResults(data, query) {
  const container = el('search-results');
  if (!container) return;
  const selectedAction = container.querySelectorAll('.search-result-item')[selectedIndex]?.dataset.action;
  results = data;

  const normalizedQuery = query.toLocaleLowerCase();
  const actions = QUICK_ACTIONS.filter(action => !normalizedQuery
    || `${action.label} ${action.detail} ${action.keywords}`.toLocaleLowerCase().includes(normalizedQuery));
  const sessionResults = Array.isArray(data) ? data : [];

  // Group by session
  const grouped = {};
  for (const r of sessionResults) {
    if (!grouped[r.session_id]) {
      grouped[r.session_id] = { name: r.session_name, items: [] };
    }
    grouped[r.session_id].items.push(r);
  }

  let html = '';
  let idx = 0;
  for (const action of actions) html += actionMarkup(action, idx++);
  for (const [sessionId, group] of Object.entries(grouped)) {
    html += `<div class="search-group-header" role="presentation" aria-hidden="true">${escapeHtml(group.name)}</div>`;
    for (const item of group.items) {
      const roleLabel = item.role === 'user' ? 'You' : 'AI';
      html += `<div class="search-result-item" id="search-option-${idx}" role="option" aria-label="${escapeHtml(group.name)} — ${roleLabel}: ${escapeHtml(item.content_snippet)}" aria-selected="false" data-index="${idx}" data-session="${escapeHtml(sessionId)}">
        <div class="search-result-role">${roleLabel}</div>
        <div class="search-result-snippet">${highlightMatch(item.content_snippet, query)}</div>
        <div class="search-result-time">${formatTimestamp(item.timestamp)}</div>
      </div>`;
      idx++;
    }
  }
  if (!html && query) html = '<div class="search-empty" role="status">No results found</div>';
  container.innerHTML = html;
  container.setAttribute('aria-busy', 'false');
  restoreActionSelection(container, selectedAction);

  // Click handlers
  container.querySelectorAll('.search-result-item').forEach(item => {
    item.addEventListener('click', () => activateResult(item));
  });
}

function activateResult(item) {
  if (item.dataset.action) {
    const action = item.dataset.action;
    closeSearch({ restoreFocus: false, restoreNavigation: false });
    if (action === 'new_chat') {
      (el('sidebar-new-chat-btn') || el('rail-new-session'))?.click();
    } else if (action === 'settings') {
      (el('user-bar-settings') || el('rail-settings'))?.click();
    } else if (action === 'workspace_files') {
      import('./workspace.js').then(workspace => workspace.openWorkspaceBrowser())
        .catch(error => {
          console.error('Could not open project tools:', error);
          uiModule.showToast('Could not open project tools. Please try again.');
        });
    }
    return;
  }
  navigateToSession(item.dataset.session);
}

function navigateToSession(sessionId) {
  closeSearch({ restoreFocus: false, restoreNavigation: false });
  if (sessionModule && sessionModule.selectSession) {
    sessionModule.selectSession(sessionId);
  }
}

function updateSelection() {
  const container = el('search-results');
  if (!container) return;
  const items = container.querySelectorAll('.search-result-item');
  items.forEach((item, i) => {
    item.classList.toggle('selected', i === selectedIndex);
    item.setAttribute('aria-selected', String(i === selectedIndex));
  });
  const input = el('search-input');
  if (input) {
    if (selectedIndex >= 0 && items[selectedIndex]) input.setAttribute('aria-activedescendant', items[selectedIndex].id);
    else input.removeAttribute('aria-activedescendant');
  }
  // Scroll selected into view
  if (selectedIndex >= 0 && items[selectedIndex]) {
    items[selectedIndex].scrollIntoView({ block: 'nearest' });
  }
}

function handleKeydown(e) {
  if (!isOpen()) return;

  const container = el('search-results');
  const items = container ? container.querySelectorAll('.search-result-item') : [];
  const count = items.length;

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    selectedIndex = count > 0 ? Math.min(selectedIndex + 1, count - 1) : -1;
    updateSelection();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    selectedIndex = Math.max(selectedIndex - 1, 0);
    updateSelection();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (selectedIndex >= 0 && items[selectedIndex]) {
      activateResult(items[selectedIndex]);
    }
  } else if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    closeSearch();
  }
}

function handleInput(e) {
  const query = e.target.value.trim();
  const requestId = ++searchGeneration;
  if (debounceTimer) clearTimeout(debounceTimer);

  if (!query) {
    el('search-results')?.setAttribute('aria-busy', 'false');
    renderResults([], '');
    return;
  }
  el('search-results')?.setAttribute('aria-busy', 'true');
  const container = el('search-results');
  if (container) {
    const actions = QUICK_ACTIONS.filter(action => `${action.label} ${action.detail} ${action.keywords}`
      .toLocaleLowerCase().includes(query.toLocaleLowerCase()));
    const html = actions.map(actionMarkup).join('');
    container.innerHTML = html || '<div class="search-empty" role="status">Searching conversations…</div>';
    container.querySelectorAll('.search-result-item').forEach(item => item.addEventListener('click', () => activateResult(item)));
    selectedIndex = -1;
    updateSelection();
  }

  debounceTimer = setTimeout(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/search?q=${encodeURIComponent(query)}&limit=20`);
      if (requestId !== searchGeneration || !isOpen() || el('search-input')?.value.trim() !== query) return;
      if (!res.ok) {
        showSearchError(query);
        return;
      }
      const data = await res.json();
      if (requestId !== searchGeneration || !isOpen() || el('search-input')?.value.trim() !== query) return;
      renderResults(data, query);
    } catch (err) {
      if (requestId !== searchGeneration) return;
      showSearchError(query);
      console.error('Search error:', err);
    }
  }, 300);
}

export function init(apiBase) {
  API_BASE = apiBase || '';

  const input = el('search-input');
  if (input) {
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-label', 'Search chats or actions');
    input.placeholder = 'Search chats or actions…';
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-expanded', 'false');
    input.setAttribute('aria-controls', 'search-results');
    input.addEventListener('input', handleInput);
    input.addEventListener('keydown', handleKeydown);
  }
  const resultsList = el('search-results');
  if (resultsList) {
    resultsList.setAttribute('role', 'listbox');
    resultsList.setAttribute('aria-label', 'Conversation search results');
  }

  // Close on overlay click (not popup click)
  const overlay = el('search-overlay');
  if (overlay) {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeSearch();
    });
  }

}

const searchChatModule = {
  init,
  openSearch,
  closeSearch,
  isOpen,
};

export default searchChatModule;
