const BROWSER_TOOL_PREFIX = 'mcp__builtin_browser__';
const MAX_SCREENSHOT_BYTES = 3 * 1024 * 1024;
const MAX_CACHED_SESSIONS = 12;
const previews = new Map();
let visibleSessionId = '';

function validSessionId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : '';
}

function safeScreenshot(value) {
  if (typeof value !== 'string') return '';
  const match = value.match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match || match[2].length * 0.75 > MAX_SCREENSHOT_BYTES) return '';
  return value;
}

function safeUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url : null;
  } catch (_) { return null; }
}

function currentSessionId() {
  try { return validSessionId(window.sessionModule?.getCurrentSessionId?.() || ''); }
  catch (_) { return ''; }
}

function dropPanel() {
  document.getElementById('browser-preview-panel')?.remove();
}

function closeBrowserPreview(sessionId, restoreFocus = true) {
  const state = previews.get(sessionId);
  if (state) state.closed = true;
  dropPanel();
  if (restoreFocus) document.querySelector(`.browser-preview-card[data-session-id="${sessionId}"]`)?.focus({ preventScroll: true });
}

document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && document.getElementById('browser-preview-panel')) {
    event.preventDefault();
    closeBrowserPreview(visibleSessionId);
  }
});

function buildCard(sessionId, state) {
  const history = document.getElementById('chat-history');
  if (!history) return null;
  let card = history.querySelector(`.browser-preview-card[data-session-id="${sessionId}"]`);
  if (!card) {
    card = document.createElement('button');
    card.type = 'button';
    card.className = 'browser-preview-card';
    card.dataset.sessionId = sessionId;
    card.setAttribute('aria-label', 'Watch browser activity');
    card.addEventListener('click', () => openBrowserPreview(sessionId));
    history.prepend(card);
  }
  card.replaceChildren();
  const icon = document.createElement('span');
  icon.className = 'browser-preview-card-icon';
  icon.textContent = '◉';
  const label = document.createElement('span');
  label.className = 'browser-preview-card-label';
  label.textContent = 'Watch browser';
  const title = document.createElement('span');
  title.className = 'browser-preview-card-title';
  title.textContent = state.title || state.status;
  const status = document.createElement('span');
  status.className = 'browser-preview-card-status';
  status.textContent = state.status || '';
  card.append(icon, label, title, status);
  return card;
}

function openBrowserPreview(sessionId) {
  const state = previews.get(sessionId);
  if (!state) return false;
  const oldPanel = document.getElementById('browser-preview-panel');
  const oldFocusClass = oldPanel?.contains(document.activeElement)
    ? document.activeElement.className : '';
  visibleSessionId = sessionId;
  state.closed = false;
  dropPanel();
  const panel = document.createElement('aside');
  panel.id = 'browser-preview-panel';
  panel.className = 'browser-preview-panel';
  panel.setAttribute('role', 'region');
  panel.setAttribute('aria-labelledby', 'browser-preview-heading');

  const header = document.createElement('header');
  header.className = 'browser-preview-header';
  const heading = document.createElement('h2');
  heading.id = 'browser-preview-heading';
  heading.textContent = 'Browser preview';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'browser-preview-close';
  close.setAttribute('aria-label', 'Close browser preview');
  close.textContent = '×';
  close.addEventListener('click', () => closeBrowserPreview(sessionId));
  header.append(heading, close);

  const title = document.createElement('div');
  title.className = 'browser-preview-title';
  title.textContent = state.screenshotStale && state.title
    ? `Last successful page: ${state.title}` : (state.title || 'Waiting for browser activity');
  const status = document.createElement('div');
  status.className = 'browser-preview-status';
  status.setAttribute('aria-live', 'polite');
  status.textContent = ['Updates after each browser action', state.action, state.status].filter(Boolean).join(' · ');
  panel.append(header, title, status);
  if (state.screenshot) {
    const image = document.createElement('img');
    image.className = 'browser-preview-image';
    image.alt = state.screenshotStale
      ? 'Previous successful screenshot; it may not show the current browser page.'
      : (state.title ? `Screenshot: ${state.title}` : 'Current browser screenshot');
    image.src = state.screenshot;
    panel.appendChild(image);
  } else {
    const empty = document.createElement('div');
    empty.className = 'browser-preview-empty';
    empty.textContent = state.status || 'No browser screenshot is available.';
    panel.appendChild(empty);
  }
  const url = safeUrl(state.url);
  if (url) {
    const link = document.createElement('a');
    link.className = 'browser-preview-url';
    link.href = url.href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = state.screenshotStale ? `Last known page: ${url.href}` : url.href;
    panel.appendChild(link);
  }
  document.body.appendChild(panel);
  if (oldFocusClass) {
    [...panel.querySelectorAll('button, a')].find(element => element.className === oldFocusClass)?.focus({ preventScroll: true });
  }
  return true;
}

function trimPreviews() {
  while (previews.size > MAX_CACHED_SESSIONS) previews.delete(previews.keys().next().value);
}

function showIfOpen(id, state, card) {
  const activeId = currentSessionId();
  const isActive = (!activeId || activeId === id) && (!visibleSessionId || visibleSessionId === id);
  if (isActive && card && state.status === 'Updated' && state.freshScreenshot && !state.autoOpened && !state.closed) {
    state.autoOpened = true;
    openBrowserPreview(id);
  } else if (isActive && !state.closed && document.getElementById('browser-preview-panel')) {
    openBrowserPreview(id);
  }
}

function updateBrowserPreview(event, sessionId) {
  const id = validSessionId(sessionId);
  if (!id || !event || typeof event !== 'object') return false;
  if (event.type === 'tool_start') {
    if (typeof event.tool !== 'string' || !event.tool.startsWith(BROWSER_TOOL_PREFIX)) return false;
    const state = previews.get(id) || { closed: false, autoOpened: false };
    state.status = 'Browser action in progress';
    state.action = event.tool.slice(BROWSER_TOOL_PREFIX.length).replace(/^browser_/, '').replaceAll('_', ' ').slice(0, 100);
    state.title ||= 'Using browser';
    state.screenshotStale = !!state.screenshot;
    state.freshScreenshot = false;
    previews.delete(id);
    previews.set(id, state);
    trimPreviews();
    const card = (!visibleSessionId || visibleSessionId === id) ? buildCard(id, state) : null;
    showIfOpen(id, state, card);
    return true;
  }
  if (event.type !== 'tool_output' || typeof event.tool !== 'string' || !event.tool.startsWith(BROWSER_TOOL_PREFIX)) return false;
  const preview = event.browser_preview;
  const old = previews.get(id) || { closed: false, autoOpened: false };
  const fallbackAction = event.tool.slice(BROWSER_TOOL_PREFIX.length).replace(/^browser_/, '').replaceAll('_', ' ').slice(0, 100);
  if (!preview || typeof preview !== 'object') {
    const state = {
      ...old,
      status: event.ask_user ? 'Waiting for approval' : event.exit_code === 0 ? 'Browser action complete' : 'Browser action failed',
      action: fallbackAction,
      screenshotStale: !!old.screenshot,
      freshScreenshot: false,
    };
    previews.delete(id);
    previews.set(id, state);
    trimPreviews();
    const card = (!visibleSessionId || visibleSessionId === id) ? buildCard(id, state) : null;
    showIfOpen(id, state, card);
    return true;
  }
  const screenshot = safeScreenshot(preview.screenshot);
  const updated = preview.state === 'updated';
  const state = {
    ...old,
    status: updated ? 'Updated' : 'Preview unavailable',
    action: typeof preview.action === 'string' ? preview.action.replace(/^browser_/, '').replaceAll('_', ' ').slice(0, 120) : fallbackAction,
    title: typeof preview.title === 'string' && preview.title ? preview.title.slice(0, 240) : old.title || '',
    url: safeUrl(preview.url)?.href || old.url || '',
    screenshot: screenshot || old.screenshot || '',
    screenshotStale: !screenshot,
    freshScreenshot: !!screenshot && updated,
  };
  previews.delete(id);
  previews.set(id, state);
  trimPreviews();
  const isVisible = !visibleSessionId || visibleSessionId === id;
  const card = isVisible ? buildCard(id, state) : null;
  showIfOpen(id, state, card);
  return true;
}

function resetBrowserPreview(sessionId) {
  const id = validSessionId(sessionId);
  if (id) {
    if (visibleSessionId === id) {
      const state = previews.get(id);
      if (state) buildCard(id, state);
      return;
    }
    dropPanel();
    visibleSessionId = id;
    document.querySelectorAll('.browser-preview-card').forEach(card => card.remove());
    return;
  }
  dropPanel();
  visibleSessionId = '';
  previews.clear();
  document.querySelectorAll('.browser-preview-card').forEach(card => card.remove());
}

export { updateBrowserPreview, resetBrowserPreview };
