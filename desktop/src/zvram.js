const $ = selector => document.querySelector(selector);
const elements = {
  choose: $('#zvram-choose'), refresh: $('#zvram-refresh'), installation: $('#zvram-installation'),
  error: $('#zvram-error'), status: $('#zvram-status'), hardware: $('#zvram-hardware'),
  gpu: $('#zvram-gpu'), memory: $('#zvram-memory'), form: $('#zvram-router-form'),
  port: $('#zvram-port'), context: $('#zvram-context'), compressed: $('#zvram-compressed'),
  ignoreSwapGuard: $('#zvram-ignore-swap-guard'), start: $('#zvram-start'),
  connect: $('#zvram-connect'), stop: $('#zvram-stop'), legacyList: $('#zvram-legacy-list'),
  routerState: $('#zvram-router-state-value'), routerModels: $('#zvram-router-models'),
  routerLog: $('#zvram-router-log'), modelList: $('#zvram-model-list'), budgetDetails: $('#zvram-budget-details'),
};
const budgetInputs = ['resident', 'cold', 'clean-cache', 'headroom', 'virtual'].map(id => $(`#zvram-${id}`));
let invoke = null;
let busy = false;
let available = false;
let routerSupported = false;
let ignoreSwapGuardSupported = false;
let router = {};
let models = [];
let legacyProfiles = [];

function showError(message = '') {
  elements.error.textContent = message;
  elements.error.hidden = !message;
}

function setStatus(message) {
  elements.status.textContent = message;
}

function updateControls() {
  const usable = !!invoke && available && !busy;
  const running = router.running === true;
  const active = running || ['starting', 'running'].includes(router.state);
  const portConflict = legacyProfiles.some(profile => profile.running === true && Number(profile.port) === Number(elements.port.value));
  elements.choose.disabled = !invoke || busy;
  elements.refresh.disabled = !invoke || busy;
  elements.start.disabled = !usable || !routerSupported || active || portConflict;
  elements.connect.disabled = !usable || !routerSupported || router.healthy !== true;
  elements.stop.disabled = !usable || !routerSupported || !active;
  elements.port.disabled = !usable || active;
  elements.context.disabled = !usable || active;
  elements.compressed.disabled = !usable || active;
  elements.ignoreSwapGuard.disabled = !usable || active || !ignoreSwapGuardSupported;
  budgetInputs.forEach(input => { input.disabled = !usable || active || !elements.compressed.checked; });
  for (const button of elements.legacyList.querySelectorAll('button[data-legacy-profile]')) {
    const profile = legacyProfiles.find(item => item.name === button.dataset.legacyProfile);
    button.disabled = !usable || !profile || profile.running !== true;
  }
  $('#zvram-swap-guard-note').textContent = ignoreSwapGuardSupported
    ? 'For this router only. The available-RAM guard remains active.'
    : 'Requires zVram 0.4.2 or newer. The available-RAM guard remains active.';
}

function renderMetrics(node, value) {
  if (Array.isArray(value)) {
    node.textContent = value.slice(0, 8).map(card => {
      const usage = Number.isFinite(card.vram_used_mib) && Number.isFinite(card.vram_total_mib)
        ? `${card.vram_used_mib.toLocaleString()} / ${card.vram_total_mib.toLocaleString()} MiB allocated`
        : 'Allocation not reported';
      return `${card.card || 'GPU'}: ${usage}`;
    }).join(' · ') || 'Not reported';
    return;
  }
  if (!value || typeof value !== 'object') {
    node.textContent = typeof value === 'string' || typeof value === 'number' ? String(value) : 'Not reported';
    return;
  }
  const labels = {
    name: 'GPU', device: 'GPU', model: 'GPU', free_mib: 'Available MiB', vram_free_mib: 'VRAM available MiB',
    used_mib: 'VRAM used MiB', vram_used_mib: 'VRAM used MiB', memory_used_mib: 'VRAM used MiB',
    total_mib: 'VRAM total MiB', vram_total_mib: 'VRAM total MiB', memory_total_mib: 'VRAM total MiB',
    ram_available_mib: 'RAM available MiB', available_ram_mib: 'RAM available MiB', ram_total_mib: 'RAM total MiB',
    swap_available_mib: 'Swap available MiB', swap_total_mib: 'Swap total MiB',
    mem_available_mib: 'RAM available MiB', swap_used_mib: 'Swap used MiB',
  };
  node.textContent = Object.entries(value).slice(0, 8).map(([key, item]) => {
    const label = labels[key.toLowerCase()] || key.replaceAll('_', ' ').replace(/\b[a-z]/g, letter => letter.toUpperCase());
    const content = typeof item === 'string' || typeof item === 'number' ? String(item) : JSON.stringify(item);
    return `${label}: ${content}`;
  }).join(' · ') || 'Not reported';
}

function renderStatus(result) {
  if (!result || typeof result !== 'object') throw new Error('The manager returned an invalid zVram status.');
  available = result.available === true;
  routerSupported = result.router_supported === true;
  ignoreSwapGuardSupported = result.ignore_swap_guard_supported === true;
  router = result.router && typeof result.router === 'object' ? result.router : {};
  if (typeof result.installation === 'string') elements.installation.textContent = result.installation || 'No installation selected.';
  models = Array.isArray(result.models) ? result.models.filter(model => model && typeof model.name === 'string') : [];
  legacyProfiles = Array.isArray(result.profiles)
    ? result.profiles.filter(profile => profile && typeof profile === 'object' && profile.name !== 'nx-zvram-router')
    : [];
  elements.hardware.hidden = !available;
  renderMetrics(elements.gpu, result.gpu);
  renderMetrics(elements.memory, result.memory);

  const modelNames = models.slice(0, 12).map(model => model.name);
  elements.modelList.textContent = modelNames.length
    ? `${models.length} model${models.length === 1 ? '' : 's'} found: ${modelNames.join(', ')}${models.length > modelNames.length ? ', …' : ''}`
    : available ? 'No local GGUF models found.' : 'Choose an installation to discover GGUF models.';
  elements.routerState.textContent = router.healthy === true ? 'Provider ready'
    : router.state === 'starting' ? 'Starting provider'
      : router.running === true ? 'Server running · checking health'
        : 'Server stopped';
  const loadedModels = Array.isArray(router.models)
    ? router.models.filter(model => typeof model === 'string' || /^(loaded|loading)$/i.test(String(model?.status || '')))
      .map(model => typeof model === 'string' ? model : model?.id || model?.model).filter(Boolean)
    : [];
  elements.routerModels.textContent = loadedModels.length ? `Active: ${loadedModels.join(', ')}` : 'No model loaded';
  const conflict = legacyProfiles.find(profile => profile.running === true && Number(profile.port) === Number(elements.port.value));
  elements.routerLog.textContent = router.lastlog || (conflict ? `Legacy server ${conflict.alias || conflict.name} uses port ${conflict.port}; stop it below or choose another port.` : '');
  elements.routerLog.hidden = !elements.routerLog.textContent;
  renderLegacyProfiles();

  if (result.message) setStatus(String(result.message));
  else if (!available) setStatus('Choose a zVram installation or check its status.');
  else if (!routerSupported) setStatus('This llama-server build lacks model-router support. Install a llama-server build with --models-preset, --models-max, and --models-autoload, then refresh.');
  else if (router.healthy) setStatus('Provider is ready. Choose a registered local model in chat.');
  else if (router.state === 'starting') setStatus('Provider is starting.');
  else if (router.running) setStatus('Provider is running; waiting for health.');
  else if (conflict) setStatus(`Legacy server ${conflict.alias || conflict.name} is using port ${conflict.port}. Stop it below or choose another port.`);
  else setStatus(`${models.length} local GGUF model${models.length === 1 ? '' : 's'} found. Start the provider to use them in chat.`);
  updateControls();
}

function renderLegacyProfiles() {
  elements.legacyList.replaceChildren();
  if (!legacyProfiles.length) {
    const empty = document.createElement('p');
    empty.className = 'panel-description';
    empty.textContent = 'No legacy profiles.';
    elements.legacyList.append(empty);
    return;
  }
  for (const profile of legacyProfiles) {
    const row = document.createElement('div');
    row.className = 'zvram-legacy-row';
    const details = document.createElement('span');
    details.textContent = `${profile.alias || profile.name} · port ${profile.port || 'unknown'} · ${profile.running ? profile.state || 'running' : profile.state || 'stopped'}${profile.lastlog ? ` · ${profile.lastlog}` : ''}`;
    const stop = document.createElement('button');
    stop.type = 'button';
    stop.className = 'button button-secondary button-small';
    stop.dataset.legacyProfile = String(profile.name || '');
    stop.textContent = 'Stop';
    stop.disabled = profile.running !== true || !profile.name;
    row.append(details, stop);
    elements.legacyList.append(row);
  }
  updateControls();
}

async function loadStatus() {
  const result = await invoke('zvram_status');
  renderStatus(result);
  return result;
}

async function perform(label, operation) {
  if (!invoke || busy) return;
  busy = true;
  showError();
  setStatus(`${label}…`);
  updateControls();
  try {
    return await operation();
  } catch (error) {
    showError(`${label} failed. ${error?.message || String(error) || 'Try again.'}`);
    setStatus('zVram state could not be confirmed.');
    throw error;
  } finally {
    busy = false;
    updateControls();
  }
}

async function refreshStatus() {
  return perform('Refresh', loadStatus);
}

function buildRouterRequest() {
  const port = Number(elements.port.value);
  const context = Number(elements.context.value);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !Number.isInteger(context) || context < 256) {
    throw new Error('Enter a valid port and context size.');
  }
  const request = {
    action: 'router_start', port, context,
    compressed: elements.compressed.checked,
    ignore_swap_guard: elements.ignoreSwapGuard.checked,
  };
  if (request.compressed) {
    const values = budgetInputs.map(input => Number(input.value));
    if (values.some(value => !Number.isInteger(value) || value <= 0)) {
      throw new Error('Memory budgets must be positive whole numbers.');
    }
    [request.resident_mib, request.cold_mib, request.clean_cache_mib, request.headroom_mib, request.virtual_gib] = values;
  }
  return request;
}

async function waitUntilHealthy() {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const status = await loadStatus();
    if (status.router?.healthy === true) return status;
    if (['failed', 'exited', 'stopped'].includes(status.router?.state) && status.router?.running !== true) {
      throw new Error(status.router?.lastlog || 'The model router stopped before becoming ready.');
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error('The model router did not become ready within 30 seconds.');
}

elements.compressed.addEventListener('change', () => {
  const active = router.running === true || ['starting', 'running'].includes(router.state);
  budgetInputs.forEach(input => { input.disabled = !invoke || busy || !available || active || !elements.compressed.checked; });
  elements.budgetDetails.classList.toggle('is-opted-in', elements.compressed.checked);
});
elements.choose.addEventListener('click', async () => {
  try {
    const result = await perform('Choose installation', () => invoke('zvram_choose_installation'));
    const chosen = typeof result === 'string' ? result : result?.installation;
    if (!chosen) { setStatus('No installation was selected.'); return; }
    elements.installation.textContent = String(chosen);
    await refreshStatus();
  } catch (_) { /* Error is already visible. */ }
});
elements.refresh.addEventListener('click', () => { refreshStatus().catch(() => {}); });
elements.port.addEventListener('input', updateControls);
$('#zvram-panel').addEventListener('toggle', () => {
  if ($('#zvram-panel').open && invoke && !busy) refreshStatus().catch(() => {});
});

elements.form.addEventListener('submit', async event => {
  event.preventDefault();
  let request;
  try {
    request = buildRouterRequest();
  } catch (error) {
    showError(error.message);
    return;
  }
  if (!available || !routerSupported) { showError('Choose a compatible zVram installation first.'); return; }
  try {
    await perform('Start provider', async () => {
      await invoke('zvram_action', { request });
      await waitUntilHealthy();
      await invoke('zvram_action', { request: { action: 'router_register' } });
      await loadStatus();
      setStatus('Provider is ready. Choose a registered local model in chat.');
    });
  } catch (_) { /* Error is already visible. */ }
});

elements.connect.addEventListener('click', async () => {
  try {
    await perform('Connect provider', async () => {
      await invoke('zvram_action', { request: { action: 'router_register' } });
      await loadStatus();
      setStatus('Provider connected. Choose a registered local model in chat.');
    });
  } catch (_) { /* Error is already visible. */ }
});

elements.stop.addEventListener('click', async () => {
  try {
    await perform('Stop provider', async () => {
      await invoke('zvram_action', { request: { action: 'router_stop' } });
      await loadStatus();
      setStatus('Provider stopped.');
    });
  } catch (_) { /* Error is already visible. */ }
});

elements.legacyList.addEventListener('click', async event => {
  const button = event.target.closest('button[data-legacy-profile]');
  if (!button || button.disabled) return;
  try {
    await perform('Stop legacy model', async () => {
      await invoke('zvram_action', { request: { action: 'stop', profile: button.dataset.legacyProfile } });
      await loadStatus();
      setStatus('Legacy model stopped.');
    });
  } catch (_) { /* Error is already visible. */ }
});

setInterval(() => {
  if (invoke && !busy && router.running === true && $('#zvram-panel').open) loadStatus().catch(() => {});
}, 2000);

function initZvram(invokeFn) {
  invoke = typeof invokeFn === 'function' ? invokeFn : null;
  if (!invoke) {
    setStatus('Native zVram controls are unavailable in browser preview.');
    elements.choose.disabled = true;
    elements.refresh.disabled = true;
    updateControls();
    return;
  }
  updateControls();
}

export { initZvram, renderStatus, refreshStatus };
