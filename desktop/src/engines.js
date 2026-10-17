const $ = (selector) => document.querySelector(selector);

export function initImageEngine(invoke) {
  const panel = $('#image-engine-panel');
  if (!panel || !invoke) {
    panel?.querySelectorAll('button, input, select').forEach(control => { control.disabled = true; });
    if (panel) $('#image-engine-status').textContent = 'Image engine controls are available in the desktop manager.';
    return;
  }

  const elements = {
    mode: $('#image-engine-mode'), idle: $('#image-engine-idle'), autoStart: $('#image-engine-auto-start'),
    status: $('#image-engine-status'), error: $('#image-engine-error'), loaded: $('#image-engine-loaded'),
    generation: $('#image-engine-generation'), models: $('#image-engine-models'), pending: $('#image-engine-pending'),
    configure: $('#image-engine-configure'), start: $('#image-engine-start'), stop: $('#image-engine-stop'),
    refresh: $('#image-engine-refresh'),
  };
  let status = null;
  let actionBusy = false;
  let pollBusy = false;
  let settingsDirty = false;

  const controls = [elements.mode, elements.idle, elements.autoStart,
    elements.configure, elements.start, elements.stop, elements.refresh];
  const setBusy = (busy) => {
    actionBusy = busy;
    controls.forEach(control => { control.disabled = busy || !invoke; });
    renderButtons();
  };
  const renderButtons = () => {
    if (actionBusy) return;
    const available = status?.available === true;
    elements.configure.disabled = !status || !invoke;
    elements.start.disabled = !available || status?.running === true;
    elements.stop.disabled = !available || status?.running !== true;
    elements.refresh.disabled = false;
  };
  const render = (value) => {
    if (!value || typeof value !== 'object') throw new Error('The image engine returned invalid status.');
    status = value;
    const mode = value.effective_mode || value.mode || 'auto';
    const modeLabel = mode.charAt(0).toUpperCase() + mode.slice(1);
    elements.status.textContent = value.healthy
      ? `Ready · ${modeLabel}`
      : `${value.state || 'unknown'} · ${modeLabel}`;
    if (!settingsDirty) {
      if (['auto', 'cpu', 'vulkan', 'zvram'].includes(value.mode)) elements.mode.value = value.mode;
      if (Number.isInteger(value.idle_seconds) && value.idle_seconds >= 30 && value.idle_seconds <= 3600) elements.idle.value = String(value.idle_seconds);
      elements.autoStart.checked = value.auto_start === true;
    }
    elements.loaded.textContent = value.loaded_model ? `Loaded: ${value.loaded_model}` : 'No image model loaded';
    elements.generation.textContent = value.generation_active ? 'Image generation active' : 'No generation active';
    const models = Array.isArray(value.models) ? value.models : [];
    elements.models.textContent = models.length
      ? `Available image models: ${models.map(model => `${model.name || model.id} (${formatSize(model.size_bytes)})`).join(', ')}`
      : 'No local image models discovered.';
    const pending = Array.isArray(value.pending) ? value.pending : [];
    elements.pending.hidden = pending.length === 0;
    elements.pending.textContent = pending.length
      ? `Waiting for downloads: ${pending.map(model => `${model.name}: ${model.reason}`).join('; ')}`
      : '';
    elements.error.hidden = !value.error;
    elements.error.textContent = value.error || '';
    renderButtons();
  };
  const formatSize = (bytes) => Number.isFinite(bytes) && bytes > 0
    ? `${(bytes / 1073741824).toFixed(1)} GB` : 'size unknown';
  const send = async (action, fields = {}) => {
    const result = await invoke('image_engine_action', { action: { action, ...fields } });
    render(result);
    return result;
  };
  const showError = (error) => {
    elements.error.textContent = String(error?.message || error || 'The image engine request failed.');
    elements.error.hidden = false;
  };
  const poll = async () => {
    if (pollBusy || actionBusy || document.visibilityState === 'hidden') return;
    pollBusy = true;
    try {
      render(await invoke('image_engine_status'));
    } catch (error) {
      showError(error);
      elements.status.textContent = 'Status unavailable';
      renderButtons();
    } finally {
      pollBusy = false;
    }
  };
  const act = async (work) => {
    if (actionBusy) return;
    elements.error.hidden = true;
    setBusy(true);
    try { await work(); }
    catch (error) { showError(error); }
    finally { setBusy(false); }
  };

  for (const control of [elements.mode, elements.idle, elements.autoStart]) {
    control.addEventListener('change', () => { settingsDirty = true; });
  }
  elements.configure.addEventListener('click', () => act(async () => {
    const idleSeconds = Number(elements.idle.value);
    if (!Number.isInteger(idleSeconds) || idleSeconds < 30 || idleSeconds > 3600) {
      throw new Error('Idle timeout must be between 30 and 3600 seconds.');
    }
    await send('configure', { mode: elements.mode.value, auto_start: elements.autoStart.checked, idle_seconds: idleSeconds });
    settingsDirty = false;
  }));
  elements.start.addEventListener('click', () => act(async () => {
    const idleSeconds = Number(elements.idle.value);
    if (!Number.isInteger(idleSeconds) || idleSeconds < 30 || idleSeconds > 3600) {
      throw new Error('Idle timeout must be between 30 and 3600 seconds.');
    }
    await send('configure', { mode: elements.mode.value, auto_start: elements.autoStart.checked, idle_seconds: idleSeconds });
    settingsDirty = false;
    await send('start');
  }));
  elements.stop.addEventListener('click', () => act(async () => { await send('stop'); }));
  elements.refresh.addEventListener('click', () => act(async () => { await send('refresh'); }));

  void poll();
  const timer = window.setInterval(poll, 10_000);
  window.addEventListener('pagehide', () => window.clearInterval(timer), { once: true });
}
