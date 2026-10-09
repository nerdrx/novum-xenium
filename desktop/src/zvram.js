const $ = (selector) => document.querySelector(selector);
const elements = {
  choose: $('#zvram-choose'), refresh: $('#zvram-refresh'), installation: $('#zvram-installation'),
  error: $('#zvram-error'), status: $('#zvram-status'), hardware: $('#zvram-hardware'),
  gpu: $('#zvram-gpu'), memory: $('#zvram-memory'), form: $('#zvram-profile-form'),
  model: $('#zvram-model'), alias: $('#zvram-alias'), port: $('#zvram-port'), context: $('#zvram-context'),
  compressed: $('#zvram-compressed'), ignoreSwapGuard: $('#zvram-ignore-swap-guard'),
  budgetDetails: $('#zvram-budget-details'), profileList: $('#zvram-profile-list'),
};
const budgetInputs = ['resident', 'cold', 'clean-cache', 'headroom', 'virtual'].map(id => $(`#zvram-${id}`));
let invoke = null;
let busy = false;
let available = false;
let profiles = [];
let models = [];
let aliasTouched = false;
let ignoreSwapGuardSupported = false;

function showError(message = '') {
  elements.error.textContent = message;
  elements.error.hidden = !message;
}

function setStatus(message) {
  elements.status.textContent = message;
}

function slug(value) {
  const valueSlug = String(value || '').normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'model';
  return valueSlug.startsWith('nx-') ? valueSlug : `nx-${valueSlug}`;
}

function selectedModel() {
  return models.find(model => model.path === elements.model.value) || null;
}

function formatModelSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  const gib = bytes / (1024 ** 3);
  if (gib >= 1) return `${gib.toFixed(1)} GiB`;
  const mib = bytes / (1024 ** 2);
  return mib >= 1 ? `${mib.toFixed(1)} MiB` : `${(bytes / 1024).toFixed(1)} KiB`;
}

function updateControls() {
  const usable = !!invoke && available && !busy;
  elements.choose.disabled = !invoke || busy;
  elements.refresh.disabled = !invoke || busy;
  elements.model.disabled = !usable || !models.length;
  $('#zvram-save').disabled = !usable || !selectedModel();
  elements.compressed.disabled = !usable;
  elements.ignoreSwapGuard.disabled = !usable || !ignoreSwapGuardSupported;
  $('#zvram-swap-guard-note').textContent = ignoreSwapGuardSupported
    ? 'For this profile only. The available-RAM guard remains active.'
    : 'Requires zVram 0.4.2 or newer. The available-RAM guard remains active.';
  budgetInputs.forEach(input => { input.disabled = !usable || !elements.compressed.checked; });
  for (const button of elements.profileList.querySelectorAll('button')) {
    const profile = profiles.find(item => String(item.profile || item.name || '') === button.dataset.profile);
    const action = button.dataset.zvramAction;
    button.disabled = !usable || !profile
      || action === 'start' && profile.running === true
      || action === 'stop' && profile.running !== true
      || action === 'register' && (profile.healthy !== true || profile.running !== true);
  }
  for (const input of [elements.alias, elements.port, elements.context]) input.disabled = !usable;
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
  const entries = Object.entries(value).slice(0, 8).map(([key, item]) => {
    const label = labels[key.toLowerCase()] || key.replaceAll('_', ' ').replace(/\b[a-z]/g, letter => letter.toUpperCase());
    const content = typeof item === 'string' || typeof item === 'number' ? String(item) : JSON.stringify(item);
    return `${label}: ${content}`;
  });
  node.textContent = entries.join(' · ') || 'Not reported';
}

function renderProfiles() {
  elements.profileList.replaceChildren();
  if (!profiles.length) {
    const empty = document.createElement('p');
    empty.className = 'panel-description';
    empty.textContent = 'No saved model profiles.';
    elements.profileList.append(empty);
    updateControls();
    return;
  }
  for (const profile of profiles) {
    const card = document.createElement('article');
    card.className = 'zvram-profile-card';
    const head = document.createElement('div');
    head.className = 'zvram-profile-head';
    const name = document.createElement('h4');
    name.textContent = profile.alias || profile.name || profile.profile || 'zVram profile';
    const state = document.createElement('span');
    state.className = 'zvram-profile-state';
    state.textContent = profile.healthy === true ? 'Healthy' : profile.running ? profile.state || 'Running' : profile.state || 'Stopped';
    head.append(name, state);
    const meta = document.createElement('p');
    meta.className = 'zvram-profile-meta';
    meta.textContent = `${profile.model || profile.name || profile.profile || 'Model'} · ${profile.port || 'No port'} · context ${profile.context || 'unknown'}${profile.compressed ? ' · experimental BP16' : ''}${profile.ignore_swap_guard ? ' · swap guard ignored' : ''}`;
    const actions = document.createElement('div');
    actions.className = 'zvram-profile-actions';
    const addButton = (action, label, disabled = false) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'button button-secondary button-small';
      button.dataset.zvramAction = action;
      button.dataset.profile = String(profile.profile || profile.name || '');
      button.dataset.healthy = profile.healthy === true ? 'true' : 'false';
      button.disabled = disabled;
      button.textContent = label;
      actions.append(button);
    };
    const profileId = String(profile.profile || profile.name || '');
    addButton('start', 'Start', !!profile.running || !profileId);
    addButton('stop', 'Stop', !profile.running || !profileId);
    addButton('register', 'Register provider', profile.healthy !== true || profile.running !== true || !profileId);
    card.append(head, meta);
    if (profile.lastlog) {
      const log = document.createElement('p');
      log.className = 'zvram-profile-log';
      log.textContent = String(profile.lastlog).slice(-1200);
      card.append(log);
    }
    card.append(actions);
    elements.profileList.append(card);
  }
  updateControls();
}

function renderStatus(result) {
  if (!result || typeof result !== 'object') throw new Error('The manager returned an invalid zVram status.');
  available = result.available === true;
  ignoreSwapGuardSupported = result.ignore_swap_guard_supported === true;
  if (typeof result.installation === 'string') elements.installation.textContent = result.installation || 'No installation selected.';
  models = Array.isArray(result.models) ? result.models.filter(model => model && typeof model.name === 'string' && typeof model.path === 'string') : [];
  profiles = Array.isArray(result.profiles) ? result.profiles.filter(profile => profile && typeof profile === 'object') : [];
  const oldValue = elements.model.value;
  elements.model.replaceChildren();
  for (const model of models) {
    const option = document.createElement('option');
    option.value = model.path;
    const size = formatModelSize(model.size);
    option.textContent = `${model.name}${size ? ` · ${size}` : ''}`;
    elements.model.append(option);
  }
  if (!models.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = available ? 'No GGUF models found' : 'Choose an installation first';
    elements.model.append(option);
  } else if (models.some(model => model.path === oldValue)) {
    elements.model.value = oldValue;
  }
  if (!aliasTouched && selectedModel()) elements.alias.value = slug(selectedModel().name);
  elements.hardware.hidden = !available;
  renderMetrics(elements.gpu, result.gpu);
  renderMetrics(elements.memory, result.memory);
  if (result.message) setStatus(String(result.message));
  else setStatus(available ? `${models.length} GGUF model${models.length === 1 ? '' : 's'} found. Save a profile before starting it.` : 'Choose an installation or check the manager status.');
  renderProfiles();
  updateControls();
}

async function perform(label, operation, after = null) {
  if (!invoke || busy) return;
  busy = true;
  showError();
  setStatus(`${label}…`);
  updateControls();
  try {
    const result = await operation();
    if (after) await after(result);
    return result;
  } catch (error) {
    showError(`${label} failed. ${error?.message || String(error) || 'Try again.'}`);
    setStatus('zVram state could not be confirmed.');
    throw error;
  } finally {
    busy = false;
    updateControls();
  }
}

async function loadStatus() {
  const result = await invoke('zvram_status');
  renderStatus(result);
  return result;
}

async function refreshStatus() {
  return perform('Refresh', loadStatus);
}

elements.compressed.addEventListener('change', () => {
  budgetInputs.forEach(input => { input.disabled = !invoke || busy || !available || !elements.compressed.checked; });
  elements.budgetDetails.classList.toggle('is-opted-in', elements.compressed.checked);
});
elements.alias.addEventListener('input', () => { aliasTouched = true; });
elements.model.addEventListener('change', () => {
  if (!aliasTouched && selectedModel()) elements.alias.value = slug(selectedModel().name);
  updateControls();
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
$('#zvram-panel').addEventListener('toggle', () => {
  if ($('#zvram-panel').open && invoke && !busy) refreshStatus().catch(() => {});
});

elements.form.addEventListener('submit', async event => {
  event.preventDefault();
  const model = selectedModel();
  const alias = elements.alias.value.trim();
  const port = Number(elements.port.value);
  const context = Number(elements.context.value);
  if (!model || !available) { showError('Choose an available GGUF model first.'); return; }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(alias)) { showError('Enter a model alias using letters, numbers, dots, underscores or hyphens.'); return; }
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !Number.isInteger(context) || context < 256) { showError('Enter a valid port and context size.'); return; }
  const request = { action: 'save', profile: slug(alias), model: model.path, alias, port, context,
    compressed: elements.compressed.checked, ignore_swap_guard: elements.ignoreSwapGuard.checked };
  if (request.compressed) {
    const values = budgetInputs.map(input => Number(input.value));
    if (values.some(value => !Number.isInteger(value) || value <= 0)) { showError('Memory budgets must be positive whole numbers.'); return; }
    [request.resident_mib, request.cold_mib, request.clean_cache_mib, request.headroom_mib, request.virtual_gib] = values;
  }
  try {
    await perform('Save profile', () => invoke('zvram_action', { request }), async () => {
      setStatus('Profile saved. Start it when ready.');
      await loadStatus();
    });
  } catch (_) { /* Error is already visible. */ }
});

elements.profileList.addEventListener('click', async event => {
  const button = event.target.closest('button[data-zvram-action]');
  if (!button || button.disabled) return;
  const action = button.dataset.zvramAction;
  const profile = profiles.find(item => String(item.profile || item.name || '') === button.dataset.profile);
  if (!profile || !['start', 'stop', 'register'].includes(action)) return;
  if (action === 'register' && (profile.healthy !== true || profile.running !== true)) return;
  const request = { action, profile: button.dataset.profile };
  try {
    await perform(action === 'register' ? 'Register provider' : `${action[0].toUpperCase()}${action.slice(1)} model`,
      () => invoke('zvram_action', { request }), async result => {
        if (result?.message) setStatus(String(result.message));
        await loadStatus();
      });
  } catch (_) { /* Error is already visible. */ }
});

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

export { initZvram, renderStatus, refreshStatus, slug };
