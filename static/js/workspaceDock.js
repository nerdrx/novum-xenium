// Live activity plus explicitly requested, owner-scoped run evidence. No polling.
const sessions = new Map();
const tabs = ['Preview', 'Files', 'Browser', 'Subagents', 'Runs'];
let current = '';
let activeTab = 'Preview';
let panel;
let opener;
let evidenceRequest;
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : '';
const text = (value, limit = 240) => typeof value === 'string' ? value.slice(0, limit) : '';
function screenshot(value) {
  return typeof value === 'string' && value.length <= 4 * 1024 * 1024
    && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value) ? value : '';
}
function url(value) {
  try {
    if (typeof value !== 'string' || value.length > 2048) return '';
    const parsed = new URL(value);
    return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password ? parsed.href : '';
  } catch { return ''; }
}
function el(tag, value, className) {
  const node = document.createElement(tag);
  if (value) node.textContent = value;
  if (className) node.className = className;
  return node;
}
function close(restore = true) {
  evidenceRequest?.abort(); evidenceRequest = null;
  panel?.remove(); panel = null;
  document.getElementById('chat-container')?.classList.remove('workspace-dock-open');
  opener?.setAttribute('aria-expanded', 'false');
  if (restore) opener?.focus();
}
async function renderRuns(content) {
  if (!current) { content.append(el('p', 'Open a chat to see its runs.')); return; }
  const controller = new AbortController(); evidenceRequest = controller;
  const session = current;
  const status = el('p', 'Loading recorded runs…'); status.setAttribute('role', 'status');
  content.append(status);
  const refresh = el('button', 'Refresh runs'); refresh.type = 'button';
  refresh.addEventListener('click', renderContent);
  try {
    const response = await fetch(`/api/chat/evidence/${encodeURIComponent(session)}`, {
      credentials: 'same-origin', signal: controller.signal,
    });
    if (!response.ok) throw new Error('unavailable');
    const data = await response.json();
    if (!Array.isArray(data.runs)) throw new Error('invalid');
    if (controller.signal.aborted || current !== session || !content.isConnected) return;
    status.textContent = data.runs.length ? 'Recorded runs. Refresh to see newer activity.' : 'No recorded runs for this chat yet.';
    const labels = { done: 'Finished', running: 'Running', error: 'Failed', stopped: 'Stopped',
      interrupted: 'Interrupted', awaiting_approval: 'Needs approval', awaiting_input: 'Needs your answer',
      paused: 'Paused at a limit', unverified: 'Verification incomplete' };
    for (const run of data.runs.slice(0, 20)) {
      if (!run || typeof run !== 'object') continue;
      const card = el('details');
      const duration = Number.isFinite(run.duration_seconds) ? `${Math.max(0, run.duration_seconds)}s` : 'Duration unavailable';
      card.append(el('summary', `${labels[run.status] || 'Unknown status'} · ${duration}`));
      card.append(el('p', text(run.model) || 'Unknown model'));
      const events = Array.isArray(run.events) ? run.events.slice(-256) : [];
      if (!events.length) card.append(el('p', 'No tool events recorded.'));
      for (const event of events) {
        if (!event || typeof event !== 'object') continue;
        const result = Number.isInteger(event.exit_code) ? ` · exit ${event.exit_code}`
          : typeof event.passed === 'boolean' ? (event.passed ? ' · passed' : ' · failed')
          : event.status ? ` · ${text(String(event.status), 100)}` : '';
        card.append(el('p', `${text(event.tool || event.type, 100) || 'Event'}${result}`));
      }
      content.append(card);
    }
  } catch (error) {
    if (controller.signal.aborted) return;
    status.textContent = 'Could not load runs. Check your connection and try again.';
  }
  if (!controller.signal.aborted && content.isConnected) content.append(refresh);
}
function renderContent() {
  if (!panel) return;
  evidenceRequest?.abort(); evidenceRequest = null;
  const content = panel.querySelector('.workspace-dock-content');
  content.replaceChildren();
  content.setAttribute('aria-labelledby', `workspace-tab-${activeTab}`);
  const state = sessions.get(current);
  if (activeTab === 'Runs') {
    void renderRuns(content);
  } else if (activeTab === 'Files') {
    content.append(el('p', 'Observed edits this visit. This is not a complete Git diff.'));
    if (!state?.diffs.length) content.append(el('p', 'No file edits received for this chat yet.'));
    for (const diff of state?.diffs || []) {
      const details = el('details');
      details.append(el('summary', diff.label));
      details.append(el('pre', diff.text));
      content.append(details);
    }
  } else if (activeTab === 'Subagents') {
    if (!state?.children.size) content.append(el('p', 'No subagent activity received for this chat yet.'));
    for (const [id, title] of state?.children || []) {
      const link = el('a', title || 'Subagent chat');
      link.href = `#${id}`;
      content.append(link);
    }
  } else {
    const isBrowser = activeTab === 'Browser' || (!state?.preview?.screenshot && !!state?.browser);
    const preview = isBrowser ? state?.browser : state?.preview;
    content.append(el('p', preview?.title || (activeTab === 'Browser' ? 'No browser activity received for this chat yet.' : 'No desktop preview received for this chat yet.')));
    if (preview?.state) content.append(el('p', preview.state));
    if (preview?.screenshot) {
      if (preview.screenshotStale) content.append(el('p', 'Last available screenshot; it may not show the current page.'));
      const img = el('img'); img.src = preview.screenshot;
      img.alt = isBrowser
        ? (preview.screenshotStale ? 'Previous browser screenshot; the current page may differ' : 'Browser screenshot from the latest received activity')
        : 'Desktop screenshot from the latest received preview';
      content.append(img);
    } else if (preview) content.append(el('p', 'No screenshot available for this activity.'));
    if (preview?.url) {
      const link = el('a', preview.url); link.href = preview.url;
      link.target = '_blank'; link.rel = 'noopener noreferrer'; content.append(link);
    }
  }
}
function selectTab(name, focus = false) {
  activeTab = name;
  panel.querySelectorAll('[role=tab]').forEach(tab => {
    const selected = tab.textContent === name;
    tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1;
    if (selected && focus) tab.focus();
  });
  renderContent();
}
function open() {
  if (panel) { close(); return; }
  panel = el('aside', '', 'workspace-dock'); panel.id = 'workspace-dock';
  panel.setAttribute('aria-label', 'Workspace activity');
  const header = el('header'); header.append(el('h2', 'Workspace'));
  const dismiss = el('button', 'Close'); dismiss.type = 'button';
  dismiss.addEventListener('click', () => close()); header.append(dismiss); panel.append(header);
  const project = el('section', '', 'workspace-dock-project');
  project.append(el('p', 'Browse your workspace, choose a project, and review Git changes and checks.'));
  const browse = el('button', 'Files & project tools'); browse.type = 'button';
  const notice = el('p'); notice.setAttribute('role', 'status'); notice.hidden = true;
  browse.addEventListener('click', async () => {
    browse.disabled = true;
    try {
      const workspace = await import('./workspace.js');
      // The drawer may have been closed while the module was loading.
      if (!browse.isConnected) return;
      close();
      await workspace.openWorkspaceBrowser();
    } catch {
      notice.textContent = 'Could not open project tools. Please try again.';
      notice.hidden = false;
    } finally { browse.disabled = false; }
  });
  project.append(browse, notice); panel.append(project);
  const tablist = el('div', '', 'workspace-dock-tabs'); tablist.setAttribute('role', 'tablist');
  tablist.setAttribute('aria-label', 'Workspace views');
  tabs.forEach(name => {
    const tab = el('button', name); tab.type = 'button'; tab.id = `workspace-tab-${name}`;
    tab.setAttribute('role', 'tab'); tab.setAttribute('aria-controls', 'workspace-dock-content');
    tab.addEventListener('click', () => selectTab(name));
    tab.addEventListener('keydown', event => {
      const index = tabs.indexOf(name);
      const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1;
      if (next >= 0) { event.preventDefault(); selectTab(tabs[next], true); }
    });
    tablist.append(tab);
  });
  panel.append(tablist);
  const content = el('div', '', 'workspace-dock-content'); content.id = 'workspace-dock-content';
  content.setAttribute('role', 'tabpanel'); content.tabIndex = 0; panel.append(content);
  panel.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
  });
  document.body.append(panel);
  document.getElementById('chat-container')?.classList.add('workspace-dock-open');
  opener.setAttribute('aria-expanded', 'true'); selectTab(activeTab, true);
}
function init() {
  const bar = document.querySelector('.chat-top-bar');
  if (!bar || opener?.isConnected) return;
  opener = el('button', 'Workspace', 'workspace-dock-toggle'); opener.type = 'button';
  opener.setAttribute('aria-controls', 'workspace-dock'); opener.setAttribute('aria-expanded', 'false');
  opener.addEventListener('click', open); bar.append(opener);
}
export function resetWorkspaceDock(sessionId) {
  current = validId(sessionId);
  if (!current) sessions.clear();
  init();
  if (panel && current) renderContent();
  else close(false);
}
export function updateWorkspaceDock(event, sessionId) {
  const id = validId(sessionId);
  if (!id || !event || typeof event !== 'object') return;
  init();
  const state = sessions.get(id) || { diffs: [], children: new Map() };
  let changed = false;
  if (event.type === 'tool_output' && event.tool === 'native_preview') {
    state.preview = { screenshot: screenshot(event.screenshot), title: 'Desktop preview', state: event.exit_code === 0 ? 'Preview received' : 'Preview did not complete successfully' };
    changed = true;
  }
  const browser = event.browser_preview || (event.type === 'browser_preview' ? event : null);
  if (browser && typeof browser === 'object') {
    const previous = state.browser;
    const image = screenshot(browser.screenshot);
    state.browser = {
      screenshot: image || previous?.screenshot || '',
      screenshotStale: !image && !!previous?.screenshot,
      url: url(browser.url) || previous?.url || '',
      title: text(browser.title) || previous?.title || 'Browser activity',
      state: text(browser.state),
    };
    changed = true;
  }
  const diff = event.diff || (event.type === 'diff' ? event : null);
  if (diff && typeof diff.text === 'string') {
    const counts = Number.isInteger(diff.added) && Number.isInteger(diff.removed)
      ? ` (+${diff.added} / −${diff.removed})` : '';
    const entry = { text: text(diff.text, 24000) + (diff.text.length > 24000 ? '\n[Preview truncated]' : ''), label: (text(diff.path || diff.file) || 'Observed edit') + counts };
    if (!state.diffs.some(old => old.text === entry.text && old.label === entry.label)) state.diffs.push(entry);
    state.diffs = state.diffs.slice(-30); changed = true;
  }
  const child = event.subagent || (event.type === 'subagent' ? event : null);
  if (child && validId(child.session_id)) {
    state.children.set(child.session_id, text(child.title));
    while (state.children.size > 30) state.children.delete(state.children.keys().next().value);
    changed = true;
  }
  if (!changed) return;
  sessions.delete(id); sessions.set(id, state);
  while (sessions.size > 8) sessions.delete(sessions.keys().next().value);
  if (id === current && activeTab !== 'Runs') renderContent();
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
else init();
