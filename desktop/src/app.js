import { initZvram } from './zvram.js';

const invoke = window.__TAURI__?.core?.invoke;
const $ = (selector) => document.querySelector(selector);
const state = { busy: false, config: null, confirmedFields: null, backend: { state: 'unconfigured' }, update: null };

const globalError = $('#global-error');
const globalNotice = $('#global-notice');
const configForm = $('#config-form');
const configMessage = $('#config-message');
const checkoutInput = $('#checkout');
const projectInput = $('#project');
const portInput = $('#port');
const main = $('#main');
const dashboard = $('.dashboard-grid');
dashboard.setAttribute('aria-busy', 'false');
let statusRequestSeq = 0;
let updateCheckSeq = 0;

function readConfigFields() {
  return { checkout: checkoutInput.value, project: projectInput.value, port: portInput.value };
}

function fieldsForConfig(config) {
  return { checkout: config.checkout ?? '', project: config.project ?? '', port: config.port == null ? '' : String(config.port) };
}

function setNotice(node, message = '') {
  node.textContent = message;
  node.hidden = !message;
}

function setInlineMessage(message = '', kind = '') {
  configMessage.textContent = message;
  configMessage.className = `inline-message${kind ? ` ${kind}` : ''}`;
}

function explainError(error, fallback) {
  const message = typeof error === 'string' ? error : error?.message;
  return message ? `${fallback} ${message}` : fallback;
}

function setBusy(value) {
  state.busy = value;
  document.body.classList.toggle('is-busy', value);
  dashboard.setAttribute('aria-busy', String(value));
  if (value) document.querySelectorAll('.app-shell [data-action]').forEach((button) => { button.disabled = true; });
  else syncActions();
}

function updateBackendView(backend = {}) {
  const known = ['unconfigured', 'stopped', 'running', 'unhealthy', 'unknown'].includes(backend.state);
  const backendState = known ? backend.state : 'unknown';
  state.backend = { ...backend, state: backendState };
  const chip = $('#backend-state');
  chip.className = `state-chip state-${backendState}`;
  $('#backend-state-text').textContent = backendState === 'unknown' ? 'Unknown' : backendState[0].toUpperCase() + backendState.slice(1);

  const detail = typeof backend.detail === 'string' && backend.detail.trim()
    ? backend.detail.trim()
    : backendState === 'running'
      ? 'The local service is ready.'
      : backendState === 'unconfigured'
        ? 'Choose an existing checkout and project to configure the local service.'
        : backendState === 'stopped'
          ? 'The local service is stopped.'
          : 'The local service is not ready. Check Docker and the service logs.';
  $('#backend-detail').textContent = detail;
  syncActions();
}

function syncActions() {
  const configured = Boolean(state.config?.checkout && state.config?.project && state.config?.port);
  $('[data-action="start"]').disabled = !invoke || state.busy || !configured || ['running', 'unknown'].includes(state.backend.state);
  $('[data-action="stop"]').disabled = !invoke || state.busy || !['running', 'unhealthy'].includes(state.backend.state);
  $('[data-action="open"]').disabled = !invoke || state.busy || state.backend.state !== 'running';
  $('[data-action="refresh"]').disabled = !invoke || state.busy;
  $('[data-action="logs"]').disabled = !invoke || state.busy;
  $('[data-action="check-update"]').disabled = !invoke || state.busy;
  $('[data-action="save"]').disabled = state.busy || !invoke;
  const updateButton = $('[data-action="update"]');
  if (updateButton) updateButton.disabled = !invoke || state.busy || !state.update?.supported || !(state.update?.available || state.update?.update_available);
}

function applyConfig(config, { onlyIfUnchanged = null } = {}) {
  if (!config || typeof config !== 'object') return;
  const current = {
    checkout: checkoutInput.value,
    project: projectInput.value,
    port: portInput.value,
  };
  const canApply = !onlyIfUnchanged || Object.keys(current).every((key) => current[key] === onlyIfUnchanged[key]);
  state.config = { checkout: config.checkout, project: config.project, port: config.port };
  if (canApply) {
    checkoutInput.value = config.checkout ?? '';
    projectInput.value = config.project ?? '';
    portInput.value = config.port ?? '';
  }
  syncActions();
}

async function refreshStatus() {
  const requestId = ++statusRequestSeq;
  const updateSeq = updateCheckSeq;
  const lastConfirmedFields = state.confirmedFields || readConfigFields();
  try {
    const result = await invoke('get_status');
    if (requestId !== statusRequestSeq) return null;
    if (!result || typeof result !== 'object') throw new Error('The manager returned an invalid status response.');
    if (result.config) {
      applyConfig(result.config, { onlyIfUnchanged: lastConfirmedFields });
      state.confirmedFields = fieldsForConfig(result.config);
    } else {
      state.config = null;
      state.confirmedFields = null;
    }
    updateBackendView(result.backend || {});
    setNotice(globalError);
    if (updateSeq === updateCheckSeq && result.update && typeof result.update === 'object') renderUpdateState(result.update);
    return result;
  } catch (error) {
    if (requestId !== statusRequestSeq) return null;
    setNotice(globalError, explainError(error, 'Could not read backend status. Try Refresh again.'));
    updateBackendView({ state: 'unknown', detail: 'Status could not be confirmed. The backend state may have changed.' });
    throw error;
  }
}

function renderUpdateState(update) {
  state.update = update;
  const supported = update.supported === true;
  const available = update.available === true || update.update_available === true;
  const message = typeof (update.message || update.detail) === 'string' && (update.message || update.detail).trim()
    ? (update.message || update.detail).trim()
    : supported
      ? available ? 'An update is available.' : 'No update is available.'
      : 'Backend updates are not supported by this installation yet.';
  $('#update-message').textContent = message;
  const review = $('#update-review');
  review.hidden = !(supported && available);
  if (supported && available) {
    const current = update.current_version || update.current;
    const target = update.latest_version || update.target;
    const from = current ? `Current version: ${current}. ` : '';
    const to = target ? `Available version: ${target}.` : '';
    $('#update-details').textContent = `${from}${to}` || message;
  } else {
    $('#update-details').textContent = '';
  }
  syncActions();
}

function validateConfig() {
  const config = {
    checkout: checkoutInput.value.trim(),
    project: projectInput.value.trim(),
    port: Number(portInput.value),
  };
  if (!config.checkout || !config.project) return { error: 'Enter a checkout folder and project name.' };
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) return { error: 'Enter a port from 1 to 65535.' };
  return { config };
}

async function performAction(name, action, onError = null, progress = `${name[0].toUpperCase()}${name.slice(1)}…`) {
  if (!invoke || state.busy) return;
  setNotice(globalError);
  setNotice(globalNotice, progress);
  setBusy(true);
  try {
    await action();
  } catch (error) {
    if (globalNotice.textContent === progress) setNotice(globalNotice);
    setNotice(globalError, explainError(error, `Could not ${name}. Try again.`));
    onError?.(error);
  } finally {
    if (globalNotice.textContent === progress) setNotice(globalNotice);
    setBusy(false);
  }
}

configForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const { config, error } = validateConfig();
  if (error) {
    setInlineMessage(error, 'error');
    return;
  }
  const submitted = { ...config };
  const fieldsAtSubmit = { checkout: checkoutInput.value, project: projectInput.value, port: portInput.value };
  setInlineMessage('Saving settings…');
  performAction('save settings', async () => {
    const saved = await invoke('save_config', { config: submitted });
    if (!saved || typeof saved !== 'object') throw new Error('The manager did not confirm the saved settings.');
    const normalized = saved.config || saved;
    applyConfig(normalized, { onlyIfUnchanged: fieldsAtSubmit });
    state.confirmedFields = fieldsForConfig(normalized);
    setInlineMessage('Settings saved.', 'success');
    try { await refreshStatus(); } catch { /* Keep the confirmed save separate from a status-refresh failure. */ }
  }, (error) => setInlineMessage(explainError(error, 'Settings were not confirmed. Retry when ready.'), 'error'), 'Saving settings…');
});

document.querySelectorAll('.app-shell [data-action]').forEach((button) => {
  button.addEventListener('click', () => {
    const action = button.dataset.action;
    if (action === 'refresh') {
      performAction('refresh status', async () => { await refreshStatus(); }, null, 'Refreshing status…');
    } else if (action === 'start' || action === 'stop') {
      performAction(`${action} the backend`, async () => {
        await invoke(action === 'start' ? 'start_backend' : 'stop_backend');
        setNotice(globalNotice, action === 'start' ? 'Start requested. Checking service status…' : 'Stop requested. Checking service status…');
        await refreshStatus();
      }, null, action === 'start' ? 'Starting backend…' : 'Stopping backend…');
    } else if (action === 'open') {
      performAction('open the workspace', async () => {
        const result = await invoke('open_workbench');
        if (!result || typeof result.url !== 'string' || !/^https?:\/\//i.test(result.url)) throw new Error('The manager did not return a valid workspace address.');
        setNotice(globalNotice, `Workspace opened at ${result.url}`);
      }, null, 'Opening workspace…');
    } else if (action === 'logs') {
      performAction('load logs', async () => {
        const result = await invoke('read_logs');
        if (!result || typeof result.text !== 'string') throw new Error('The manager returned invalid log data.');
        $('#logs-output').textContent = result.text;
        $('#logs-output').hidden = false;
        $('#logs-message').textContent = result.truncated ? 'Showing the most recent log output; earlier lines were omitted.' : 'Most recent backend log output.';
      }, null, 'Loading logs…');
    } else if (action === 'check-update') {
      performAction('check for updates', async () => {
        const result = await invoke('check_update');
        if (!result || typeof result !== 'object') throw new Error('The manager returned an invalid update response.');
        updateCheckSeq += 1;
        renderUpdateState(result);
      }, null, 'Checking for updates…');
    } else if (action === 'update') {
      if (!state.update?.supported || !(state.update?.available || state.update?.update_available)) return;
      performAction('apply the update', async () => {
        if (!window.confirm('Review the release and make a backup before applying this update. Continue?')) return;
        const result = await invoke('update_backend');
        if (result?.supported === false) {
          renderUpdateState(result);
          return;
        }
        const backup = typeof result?.backupPath === 'string' ? ` Recovery backup: ${result.backupPath}.` : '';
        const detail = typeof result?.detail === 'string' ? result.detail : 'Update request completed.';
        setNotice(globalNotice, `${detail}${backup} Check the backend status before continuing.`);
        await refreshStatus();
      }, null, 'Applying update…');
    }
  });
});

if (!invoke) {
  setNotice(globalError, 'Native manager controls are unavailable in browser preview. Open this app in the Novum Xenium desktop manager.');
  $('#backend-detail').textContent = 'Browser preview is read-only; it cannot inspect or control a local backend.';
  document.querySelectorAll('.app-shell [data-action], #config-form input').forEach((control) => { control.disabled = true; });
  syncActions();
} else {
  syncActions();
  invoke('mount_manager_chrome').catch((error) => console.warn('Could not mount manager window controls', error));
  // Initial status is a single real IPC request, not a simulated loading sequence.
  refreshStatus().catch(() => {});
  window.addEventListener('focus', () => {
    if (!state.busy && !document.hidden) refreshStatus().catch(() => {});
  });
}

initZvram(invoke);

export { applyConfig, refreshStatus, renderUpdateState };
