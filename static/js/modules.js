import { makeWindowDraggable } from './windowDrag.js';

/* Optional panels stay in opaque sandbox frames. Tools use the MCP registry. */
let modules = [];
let sources = [];
let admin = false;
let options = {};
let initialized = false;
let refreshing = null;
let refreshingSources = null;
let sourceBusy = false;
let sourceLoadError = '';
const sourceOps = new Set();
let activeFrame = null;
let activeId = null;
let activeVersion = null;
let activeModule = null;
let visibleSubagents = new Set();
let returnFocus = null;
let statusText = '';
let statusError = false;
let moduleView = 'installed';
let moduleSearch = '';
let moduleFilter = 'all';
let repositoryDraft = '';
let zipExpanded = false;

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
  activeModule = null;
  if (returnFocus?.isConnected) returnFocus.focus();
}
function openPanel(item) {
  const modal = document.getElementById('module-window');
  const host = document.getElementById('module-frame-host');
  if (!modal || !host || !item.enabled || !item.panel_url) return;
  returnFocus = document.activeElement;
  activeId = item.id;
  activeVersion = item.version;
  activeModule = item;
  visibleSubagents.clear();
  document.getElementById('module-window-title').textContent = item.name;
  const tools = element('div', 'modules-frame-controls');
  const granted = (item.permissions || []).filter(value => ['downloads', 'git', 'models', 'images', 'research', 'runs', 'subagents'].includes(value));
  const note = element('span', 'modules-detail', `Isolated panel. Declared permissions: ${granted.length ? granted.join(', ') : 'none'}. No cookies or desktop access.`);
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
const SOURCE_CAPABILITIES = ['downloads', 'git', 'models', 'images', 'research', 'runs', 'subagents'];
const MODULE_DESTINATIONS = {
  gallery: '#tool-gallery-btn', research: '#tool-research-btn',
  tasks: '#tool-tasks-btn',
};
function moduleMessage(event) {
  const frame = activeFrame;
  const item = activeModule;
  const request = event.data;
  if (!frame?.contentWindow || event.source !== frame.contentWindow || !item || !request || typeof request !== 'object') return;
  if (request.type === 'novum:open') {
    if (request.action === 'session') {
      if (!item.permissions?.includes('subagents') || typeof request.session_id !== 'string' || !visibleSubagents.has(request.session_id)) return;
      const sessionId = request.session_id;
      closePanel();
      options.openChat?.(sessionId);
      return;
    }
    if (request.action === 'integrations') {
      if (typeof options.openIntegrations === 'function') options.openIntegrations();
      return;
    }
    if (typeof request.action !== 'string' || !Object.hasOwn(MODULE_DESTINATIONS, request.action)) return;
    const selector = MODULE_DESTINATIONS[request.action];
    if (!selector) return;
    document.querySelector(selector)?.click();
    return;
  }
  if (request.type !== 'novum:request' || typeof request.id !== 'string' || request.id.length < 1 || request.id.length > 80) return;
  const capability = request.capability;
  if (!SOURCE_CAPABILITIES.includes(capability) || !Array.isArray(item.permissions) || !item.permissions.includes(capability)) {
    frame.contentWindow.postMessage({ type: 'novum:response', id: request.id, error: 'Permission denied.' }, '*');
    return;
  }
  const moduleId = activeId;
  if (request.workspace !== undefined && (capability !== 'git' || typeof request.workspace !== 'string' || request.workspace.length > 4096)) {
    frame.contentWindow.postMessage({ type: 'novum:response', id: request.id, error: 'Invalid workspace.' }, '*');
    return;
  }
  const workspace = capability === 'git' && typeof request.workspace === 'string' ? `?workspace=${encodeURIComponent(request.workspace)}` : '';
  api(`/api/modules/${encodeURIComponent(moduleId)}/data/${encodeURIComponent(capability)}${workspace}`)
    .then(data => {
      if (activeFrame !== frame || activeId !== moduleId || activeModule !== item || frame.contentWindow !== event.source) return;
      if (capability === 'subagents') visibleSubagents = new Set((data.items || []).map(child => child.session_id).filter(id => typeof id === 'string'));
      frame.contentWindow.postMessage({ type: 'novum:response', id: request.id, data }, '*');
    })
    .catch(error => {
      if (activeFrame !== frame || activeId !== moduleId || activeModule !== item || frame.contentWindow !== event.source) return;
      frame.contentWindow.postMessage({ type: 'novum:response', id: request.id, error: error.message }, '*');
    });
}
async function refreshSources() {
  if (refreshingSources) return refreshingSources;
  refreshingSources = (async () => {
    try {
      const result = await api('/api/modules/sources');
      if (!Array.isArray(result.sources)) throw new Error('Source list returned an incomplete response.');
      sources = result.sources;
      sourceLoadError = '';
      return true;
    } catch (error) {
      sourceLoadError = error.message;
      setStatus(error.message, true);
      return false;
    } finally { refreshingSources = null; }
  })();
  return refreshingSources;
}
async function mutateSource(key, label, request) {
  if (sourceOps.has(key)) return;
  sourceOps.add(key); render(); setStatus(`${label}…`);
  try {
    await request();
    if (!await refreshSources()) return;
    setStatus(`${label} complete.`);
  } catch (error) { setStatus(error.message, true); }
  finally { sourceOps.delete(key); render(); }
}
async function installSourceModule(button, source, item, update = false) {
  const operation = `module:${item.id}`;
  if (sourceOps.has(operation)) return;
  sourceOps.add(operation);
  if (button) button.disabled = true;
  render();
  setStatus(`${update ? 'Updating' : 'Installing'} ${item.name}…`);
  try {
    const result = await api(`/api/modules/sources/${encodeURIComponent(source.id)}/install`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ module_id: item.id }),
    });
    setStatus(`${result.module?.name || item.name} ${update ? 'updated' : 'installed'} disabled. Review and enable it when ready.`);
    await refreshModules();
  } catch (error) {
    const message = error.message;
    await refreshModules();
    setStatus(message, true);
  } finally { sourceOps.delete(operation); render(); }
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
  if (!admin) moduleView = 'installed';
  const navigation = element('nav', 'modules-navigation');
  navigation.setAttribute('aria-label', 'Module views');
  const views = admin ? [['installed', `Installed (${modules.length})`], ['repositories', 'Repositories']] : [['installed', `Installed (${modules.length})`]];
  views.forEach(([view, label]) => {
    const button = control(label, () => { moduleView = view; render(); document.getElementById(`modules-view-${view}`)?.focus(); });
    button.id = `modules-view-${view}`;
    button.setAttribute('aria-pressed', String(moduleView === view));
    navigation.append(button);
  });
  panel.append(navigation);
  const status = element('p', 'modules-status', statusText);
  status.id = 'modules-status'; status.setAttribute('role', statusError ? 'alert' : 'status');
  panel.append(status);
  if (admin && moduleView === 'repositories') {
    const sourceBox = element('section', 'modules-installer modules-sources');
    sourceBox.append(element('h3', '', 'GitHub module sources'));
    const sourceForm = element('form', 'modules-source-form');
    const sourceLabel = element('label', 'modules-file-label', 'Repository URL');
    sourceLabel.htmlFor = 'modules-source-url';
    const sourceUrl = element('input'); sourceUrl.type = 'url'; sourceUrl.id = 'modules-source-url'; sourceUrl.required = true;
    sourceUrl.value = repositoryDraft;
    sourceUrl.addEventListener('input', () => { repositoryDraft = sourceUrl.value; });
    sourceUrl.placeholder = 'https://github.com/owner/repository'; sourceUrl.autocomplete = 'url';
    const addSource = element('button', 'modules-button', 'Add repo');
    addSource.type = 'submit'; addSource.disabled = sourceBusy;
    sourceForm.addEventListener('submit', async event => {
      event.preventDefault();
      const url = sourceUrl.value.trim();
      if (!url || sourceBusy) return;
      sourceBusy = true; addSource.disabled = true; setStatus('Adding or refreshing repository…');
      try {
        await api('/api/modules/sources', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) });
        sourceUrl.value = ''; repositoryDraft = '';
        if (await refreshSources()) setStatus('Repository added or refreshed.');
      } catch (error) { setStatus(error.message, true); }
      finally { sourceBusy = false; render(); }
    });
    sourceForm.append(sourceLabel, sourceUrl, addSource);
    sourceBox.append(sourceForm, element('p', 'modules-detail modules-install-note', 'Review permissions, then tick to install and enable. Updates stay disabled until you enable the reviewed version.'));
    if (sourceLoadError) {
      const retry = control('Retry source list', async () => { if (await refreshSources()) { setStatus('Source list loaded.'); render(); } });
      retry.setAttribute('aria-label', 'Retry loading GitHub sources');
      sourceBox.append(element('p', 'modules-detail modules-source-error', sourceLoadError), retry);
    }
    const sourceList = element('div', 'modules-source-list');
    sources.forEach(source => {
      const card = element('article', 'modules-card modules-source-card');
      const head = element('div', 'modules-card-heading');
      head.append(element('h3', '', String(source.url || source.id).replace('https://github.com/', '')), element('span', 'modules-badge', source.commit ? `Pinned ${String(source.commit).slice(0, 12)}` : 'Source'));
      card.append(head, element('p', 'modules-detail', source.url));
      const actions = element('div', 'modules-actions');
      const busy = sourceOps.has(source.id);
      actions.append(control(busy ? 'Refreshing…' : 'Refresh', () => mutateSource(source.id, 'Refreshing repository', async () => {
        await api('/api/modules/sources', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: source.url }) });
      })));
      actions.lastChild.disabled = busy;
      const forget = control('Forget source', () => mutateSource(source.id, 'Forgetting repository', async () => {
        await api(`/api/modules/sources/${encodeURIComponent(source.id)}`, { method: 'DELETE' });
      }));
      forget.disabled = busy; forget.setAttribute('aria-label', `Forget source ${source.url}; installed modules stay installed`); actions.append(forget);
      card.append(actions, element('p', 'modules-detail', 'Forgetting this source keeps its installed modules.'));
      const catalog = element('div', 'modules-source-modules');
      (source.modules || []).forEach(mod => {
        const row = element('div', 'modules-source-module');
        const info = element('div');
        info.append(element('strong', '', mod.name), element('p', 'modules-detail', `Version ${mod.version}${mod.installed_version ? ` · Installed ${mod.installed_version}` : ''}${mod.enabled ? ' · Enabled' : ''}`));
        if (mod.description) info.append(element('p', 'modules-detail', mod.description));
        const declared = (mod.permissions || []).filter(value => SOURCE_CAPABILITIES.includes(value));
        info.append(element('p', 'modules-detail', `Declared permissions: ${declared.length ? declared.join(', ') : 'none'}. Review before enabling.`));
        const conflict = mod.conflict === true;
        if (conflict) info.append(element('p', 'modules-source-error', 'This module ID is already installed from another source or ZIP. Remove the existing module or use a different ID.'));
        row.append(info);
        const controls = element('div', 'modules-actions');
        const installedPanel = modules.find(item => item.id === mod.id && item.enabled && item.panel_url);
        if (!conflict && mod.enabled && installedPanel) controls.append(control('Open panel', () => openPanel(installedPanel)));
        const operation = `module:${mod.id}`;
        const busyModule = sourceOps.has(operation);
        if (!conflict && !mod.installed_version) {
          const install = control('Install disabled', () => installSourceModule(install, source, mod));
          install.disabled = busyModule; controls.append(install);
        } else if (!conflict && mod.version !== mod.installed_version) {
          const update = control(`Update to ${mod.version}`, () => installSourceModule(update, source, mod, true));
          update.disabled = busyModule; controls.append(update);
        }
        const toggleLabel = element('label', 'modules-source-toggle');
        const toggle = element('input');
        toggle.type = 'checkbox'; toggle.checked = mod.enabled === true;
        toggle.disabled = busyModule || conflict;
        toggle.setAttribute('aria-label', `${mod.enabled ? 'Disable' : 'Enable'} ${mod.name}`);
        toggleLabel.append(toggle, document.createTextNode(` ${conflict ? 'Unavailable' : mod.enabled ? 'Enabled' : mod.installed_version ? 'Disabled' : 'Install and enable'}`));
        toggle.addEventListener('change', async () => {
          if (sourceOps.has(operation)) { toggle.checked = mod.enabled === true; return; }
          toggle.disabled = true; sourceOps.add(operation);
          controls.querySelectorAll('button').forEach(button => { button.disabled = true; });
          try {
            if (toggle.checked && !mod.installed_version) {
              await api(`/api/modules/sources/${encodeURIComponent(source.id)}/install`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ module_id: mod.id }),
              });
            }
            await api(`/api/modules/${encodeURIComponent(mod.id)}/enabled`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: toggle.checked }) });
            setStatus(`${mod.name} ${toggle.checked ? 'enabled' : 'disabled'}.`);
            await refreshModules();
          } catch (error) {
            const message = error.message;
            await refreshModules();
            setStatus(message, true);
          } finally { sourceOps.delete(operation); render(); }
        });
        controls.append(toggleLabel);
        row.append(controls); catalog.append(row);
      });
      if (!source.modules?.length) catalog.append(element('p', 'modules-empty', 'No modules found in this source. Refresh to retry.'));
      card.append(catalog); sourceList.append(card);
    });
    sourceBox.append(sourceList);
    panel.append(sourceBox);
    if (!sources.length && !sourceLoadError) sourceBox.append(element('p', 'modules-empty', 'Add a repository to browse its modules. Installed modules live in the Installed view.'));
    return;
  }
  let zipInstaller = null;
  if (admin) {
    const advanced = element('details', 'modules-advanced');
    advanced.open = zipExpanded;
    advanced.addEventListener('toggle', () => { zipExpanded = advanced.open; });
    advanced.append(element('summary', '', 'Install from ZIP'));
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
    advanced.append(installer);
    // Keep the optional installer after the module list.
    zipInstaller = advanced;
  }
  const toolbar = element('div', 'modules-toolbar');
  const search = element('input', 'modules-search');
  search.type = 'search'; search.placeholder = 'Find a module…'; search.value = moduleSearch;
  search.setAttribute('aria-label', 'Find installed modules');
  const filter = element('select', 'modules-filter');
  filter.setAttribute('aria-label', 'Module status');
  [['all', 'All modules'], ['enabled', 'Enabled'], ['disabled', 'Disabled']].forEach(([value, label]) => {
    const option = element('option', '', label); option.value = value; filter.append(option);
  });
  filter.value = moduleFilter;
  toolbar.append(search, filter); panel.append(toolbar);
  if (!modules.length) panel.append(element('p', 'modules-empty', admin ? 'No modules installed. Add a repository to get started.' : 'No modules available. An administrator can install and enable them.'));
  const list = element('div', 'modules-list');
  const noMatches = element('p', 'modules-empty', 'No matching modules. Try another name or status.');
  noMatches.hidden = true;
  function filterCards() {
    const query = moduleSearch.trim().toLocaleLowerCase();
    let visible = 0;
    for (const card of list.children) {
      const item = modules.find(module => module.id === card.dataset.moduleId);
      card.hidden = !`${item.name} ${item.description || ''}`.toLocaleLowerCase().includes(query) ||
        (moduleFilter !== 'all' && item.enabled !== (moduleFilter === 'enabled'));
      if (!card.hidden) visible++;
    }
    noMatches.hidden = !modules.length || visible > 0;
  }
  search.addEventListener('input', () => { moduleSearch = search.value; filterCards(); });
  filter.addEventListener('change', () => { moduleFilter = filter.value; filterCards(); });
  modules.forEach(item => {
    const card = element('article', 'modules-card');
    card.dataset.moduleId = item.id;
    const header = element('div', 'modules-card-heading');
    const name = element('h3', '', item.name);
    header.append(name, element('span', 'modules-badge', item.enabled ? 'Enabled' : 'Disabled'));
    card.append(header, element('p', 'modules-detail', `Version ${item.version}`));
    if (item.description) card.append(element('p', 'modules-description', item.description));
    const permissions = (item.permissions || []).filter(value => SOURCE_CAPABILITIES.includes(value));
    card.append(element('p', 'modules-detail', `Declared permissions: ${permissions.length ? permissions.join(', ') : 'none'}. Review before enabling.`));
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
  panel.append(list, noMatches);
  filterCards();
  if (zipInstaller) panel.append(zipInstaller);
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
      if (admin) await refreshSources(); else sources = [];
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
  // Messages can only request explicitly granted data from the active frame.
  window.addEventListener('message', moduleMessage);
  new MutationObserver(themeMessage).observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] });
}
