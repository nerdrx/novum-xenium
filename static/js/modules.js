import { makeWindowDraggable } from './windowDrag.js';

/* Optional panels stay in opaque sandbox frames. Tools use the MCP registry. */
let modules = [];
let admin = false;
let options = {};
let initialized = false;
let refreshing = null;
let activeFrame = null;
let activeId = null;
let activeVersion = null;
let returnFocus = null;
let statusText = '';
let statusError = false;

function element(tag, className, text) {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (text !== undefined) item.textContent = String(text);
  return item;
}
function control(text, action, className = 'modules-button') {
  const item = element('button', className, text);
  item.type = 'button';
  item.addEventListener('click', action);
  return item;
}
async function api(url, init = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  let response;
  try { response = await fetch(url, { credentials: 'same-origin', signal: controller.signal, ...init }); }
  catch (error) { throw new Error(error.name === 'AbortError' ? 'Module request timed out. Check the module list before retrying a change.' : 'Module request could not reach the backend.'); }
  finally { clearTimeout(timeout); }
  let data;
  try { data = await response.json(); } catch { data = {}; }
  if (!response.ok) {
    const detail = typeof data.detail === 'string' ? data.detail : null;
    throw new Error(detail || `Module request failed (HTTP ${response.status}).`);
  }
  return data;
}
function setStatus(text, error = false) {
  statusText = text;
  statusError = error;
  const status = document.getElementById('modules-status');
  if (status) {
    status.textContent = text;
    status.setAttribute('role', error ? 'alert' : 'status');
  }
}
async function changeModule(button, item, action) {
  button.disabled = true;
  setStatus(action === 'rollback' ? `Restoring ${item.name}…` : `${item.enabled ? 'Disabling' : 'Enabling'} ${item.name}…`);
  try {
    await api(`/api/modules/${encodeURIComponent(item.id)}/${action}`, action === 'enabled' ? {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: !item.enabled }),
    } : { method: 'POST' });
    setStatus(action === 'rollback' ? `${item.name} restored. Review and enable the version when ready.` : `${item.name} ${item.enabled ? 'disabled' : 'enabled'}.`);
    if (activeId === item.id) closePanel();
    await refreshModules();
  } catch (error) { setStatus(error.message, true); button.disabled = false; }
}
function themeMessage() {
  if (!activeFrame?.contentWindow) return;
  const style = getComputedStyle(document.documentElement);
  const tokens = {};
  ['bg', 'fg', 'panel', 'border', 'red'].forEach(key => { tokens[key] = style.getPropertyValue(`--${key}`).trim().slice(0, 200); });
  // Opaque sandbox origins require '*'; only this frame receives the message.
  activeFrame.contentWindow.postMessage({ type: 'novum:theme', api_version: 1, tokens }, '*');
}
function closePanel() {
  document.getElementById('module-window')?.classList.add('hidden');
  document.getElementById('module-frame-host')?.replaceChildren();
  activeFrame = null;
  activeId = null;
  activeVersion = null;
  if (returnFocus?.isConnected) returnFocus.focus();
}
function openPanel(item) {
  const modal = document.getElementById('module-window');
  const host = document.getElementById('module-frame-host');
  if (!modal || !host || !item.enabled || !item.panel_url) return;
  returnFocus = document.activeElement;
  activeId = item.id;
  activeVersion = item.version;
  document.getElementById('module-window-title').textContent = item.name;
  const tools = element('div', 'modules-frame-controls');
  const note = element('span', 'modules-detail', 'Isolated panel. It cannot access your chats, app cookies or desktop controls.');
  const reload = control('Reload panel', () => {
    if (activeFrame) activeFrame.src = `/api/modules/${encodeURIComponent(item.id)}/panel`;
  });
  tools.append(note, reload);
  const frame = element('iframe', 'modules-frame');
  frame.title = `${item.name} panel`;
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.setAttribute('referrerpolicy', 'no-referrer');
  frame.src = `/api/modules/${encodeURIComponent(item.id)}/panel`;
  activeFrame = frame;
  frame.addEventListener('load', themeMessage);
  host.replaceChildren(tools, frame);
  modal.classList.remove('hidden');
  document.getElementById('module-window-close')?.focus();
}
function render() {
  const panel = document.getElementById('modules-panel');
  if (!panel) return;
  panel.replaceChildren();
  const heading = element('div', 'modules-heading');
  const intro = element('div');
  intro.append(element('h2', '', 'Modules'), element('p', 'modules-detail', 'Add panels and connect extra tools without rebuilding the app.'));
  heading.append(intro);
  panel.append(heading);
  if (admin) {
    const installer = element('section', 'modules-installer');
    const label = element('label', 'modules-file-label', 'Module ZIP');
    label.htmlFor = 'modules-file';
    const file = element('input');
    file.type = 'file'; file.id = 'modules-file'; file.accept = '.zip,application/zip';
    const install = control('Install / update', async () => {
      if (!file.files.length) { setStatus('Choose a module ZIP first.', true); file.focus(); return; }
      install.disabled = true; file.disabled = true;
      setStatus('Installing module…');
      const form = new FormData(); form.append('file', file.files[0]);
      try {
        const result = await api('/api/modules/install', { method: 'POST', body: form });
        if (activeId && result.module?.id === activeId) closePanel();
        setStatus(`${result.module?.name || 'Module'} ${result.updated ? 'updated' : 'installed'}. Review it before enabling. MCP tools are configured separately.`);
        await refreshModules();
      } catch (error) { setStatus(error.message, true); install.disabled = false; file.disabled = false; }
    });
    installer.append(label, file, install, element('p', 'modules-detail modules-install-note', 'New installs and updates stay disabled until you enable them. Only install modules you trust.'));
    panel.append(installer);
  }
  const status = element('p', 'modules-status', statusText);
  status.id = 'modules-status'; status.setAttribute('role', statusError ? 'alert' : 'status');
  panel.append(status);
  if (!modules.length) panel.append(element('p', 'modules-empty', admin ? 'No modules installed. Add a ZIP to get started.' : 'No modules available. An administrator can install and enable them.'));
  const list = element('div', 'modules-list');
  modules.forEach(item => {
    const card = element('article', 'modules-card');
    card.dataset.moduleId = item.id;
    const header = element('div', 'modules-card-heading');
    const name = element('h3', '', item.name);
    header.append(name, element('span', 'modules-badge', item.enabled ? 'Enabled' : 'Disabled'));
    card.append(header, element('p', 'modules-detail', `Version ${item.version}`));
    if (item.description) card.append(element('p', 'modules-description', item.description));
    const actions = element('div', 'modules-actions');
    if (item.enabled && item.panel_url) actions.append(control('Open panel', () => openPanel(item)));
    if (admin) {
      const toggle = control(item.enabled ? 'Disable' : 'Enable', () => changeModule(toggle, item, 'enabled'));
      toggle.setAttribute('aria-label', `${item.enabled ? 'Disable' : 'Enable'} ${item.name}`);
      actions.append(toggle);
      if (item.previous_version) {
        const rollback = control(`Restore ${item.previous_version}`, () => changeModule(rollback, item, 'rollback'));
        actions.append(rollback);
      }
    }
    card.append(actions);
    if (item.mcp_servers?.length || item.mcp) {
      const tools = element('section', 'modules-tools');
      tools.append(element('h4', '', 'Agent tools'));
      (item.mcp_servers || []).forEach(server => tools.append(element('p', 'modules-detail', `${server.name || server.id}: ${server.configured ? server.status || (server.enabled ? 'configured' : 'disabled') : 'not configured'}`)));
      if (item.mcp) {
        tools.append(element('p', 'modules-detail', `${item.mcp.transport} · ${item.mcp.url}`));
        if (admin && !item.mcp_servers?.some(server => server.configured && server.manifest_match === true)) {
          const connect = control('Connect MCP server', async () => {
            connect.disabled = true;
            setStatus(`Connecting ${item.mcp.name}…`);
            try {
              const form = new FormData();
              form.append('name', item.mcp.name); form.append('transport', item.mcp.transport); form.append('url', item.mcp.url);
              const result = await api('/api/mcp/servers', { method: 'POST', body: form });
              setStatus(result.connected ? `${item.mcp.name} connected.` : `${item.mcp.name} registered. Check its connection in Integrations.`);
              await refreshModules();
            } catch (error) {
              setStatus(error.message, true);
              // Registration can finish before a connection error. Reconcile first.
              await refreshModules();
            }
          });
          tools.append(connect);
        }
      }
      tools.append(element('p', 'modules-detail', 'MCP tools have their own connection and permission settings. Enabling this panel does not enable its tools.'));
      if (admin && options.openIntegrations) tools.append(control('Configure tools', options.openIntegrations));
      card.append(tools);
    }
    list.append(card);
  });
  panel.append(list);
}
export async function refreshModules() {
  if (refreshing) return refreshing;
  const panel = document.getElementById('modules-panel');
  if (!panel) return;
  panel.setAttribute('aria-busy', 'true');
  if (!panel.children.length) panel.append(element('p', 'modules-empty', 'Loading modules…'));
  refreshing = (async () => {
    try {
      const result = await api('/api/modules');
      if (!Array.isArray(result.modules)) throw new Error('Module list returned an incomplete response.');
      modules = result.modules; admin = result.is_admin === true;
      if (activeId && !modules.some(item => item.id === activeId && item.enabled && item.version === activeVersion)) closePanel();
      render();
    } catch (error) {
      panel.replaceChildren(element('p', 'modules-empty', error.message), control('Try again', refreshModules));
      panel.firstChild.setAttribute('role', 'alert');
    } finally { panel.removeAttribute('aria-busy'); refreshing = null; }
  })();
  return refreshing;
}
export function openModules() { return refreshModules(); }
export function initModules(config = {}) {
  options = config;
  if (initialized) return;
  initialized = true;
  const modal = document.getElementById('module-window');
  if (modal) makeWindowDraggable(modal, { content: modal.querySelector('.modal-content'), header: document.getElementById('module-window-header'), enableDock: false, minWidth: 320, minHeight: 280 });
  document.getElementById('module-window-close')?.addEventListener('click', closePanel);
  document.getElementById('module-window')?.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.stopPropagation(); closePanel(); }
  });
  // Theme updates are one-way. No module messages invoke application actions.
  new MutationObserver(themeMessage).observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] });
}
