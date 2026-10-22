// Image model settings with provider-aware routing and serialized saves.
import { byId as el } from './dom.js';
import { postSettings as _postSettings } from './api.js';
import { sortModelIds } from '../modelSort.js';

export async function initImageSettings({ registerEndpointRefresh = () => {} } = {}) {
  const modelSel = el('set-imgModelSelect');
  const qualSel = el('set-imgQualitySelect');
  const msg = el('set-imgSettingsMsg');
  const backendMsg = el('set-imgBackendMsg');
  const enabledToggle = el('set-imgEnabledToggle');
  const configWrap = modelSel ? modelSel.closest('div[style*="flex-direction"]') : null;
  if (!modelSel) return;

  const controls = [modelSel, qualSel, enabledToggle].filter(Boolean);
  let settingsLoaded = false;
  controls.forEach(control => { control.disabled = true; });
  if (msg) {
    msg.setAttribute('role', 'status');
    msg.setAttribute('aria-live', 'polite');
    msg.textContent = 'Loading saved image settings…';
    msg.style.color = 'var(--fg)';
  }

  let _endpoints = [];
  let _savedModelSpec = '';
  let _imageSaveQueue = Promise.resolve();
  let _imageSaveSequence = 0;
  const _imagePrefixes = [
    'gpt-image', 'dall-e', 'chatgpt-image', 'hidream', 'qwen-image',
    'z-image', 'flux', 'stable-diffusion', 'sdxl', 'boogu', 'krea-2',
  ];
  function isImageModel(mid) {
    const leaf = String(mid || '').trim().toLowerCase().split('/').pop();
    return _imagePrefixes.some(function(prefix) { return leaf.startsWith(prefix); })
      || (leaf.startsWith('gpt-') && leaf.includes('-image'))
      || leaf.includes('inpaint')
      || leaf.includes('3.5-medium')
      || leaf.includes('3-5-medium')
      || leaf.includes('sd-3.5-med');
  }

  function refreshModels(preferred) {
    const wanted = String(preferred !== undefined ? preferred : modelSel.value || _savedModelSpec || '').trim();
    const blankText = modelSel.options[0] && modelSel.options[0].value === ''
      ? modelSel.options[0].textContent : 'Auto-detect';
    while (modelSel.options.length) modelSel.remove(0);
    const blank = document.createElement('option');
    blank.value = '';
    blank.textContent = blankText;
    modelSel.appendChild(blank);

    const options = [];
    const seen = new Set();
    (_endpoints || []).forEach(function(ep) {
      if (!ep || !ep.is_enabled || !ep.name) return;
      const endpointIsImage = String(ep.model_type || '').toLowerCase() === 'image';
      (Array.isArray(ep.models) ? ep.models : []).forEach(function(rawMid) {
        const mid = String(rawMid || '').trim();
        if (!mid || (!endpointIsImage && !isImageModel(mid))) return;
        const value = mid + '@' + ep.name;
        if (seen.has(value)) return;
        seen.add(value);
        options.push({ value: value, model: mid, endpoint: ep.name });
      });
    });
    options.sort(function(a, b) {
      return sortModelIds([a.model, b.model])[0] === a.model
        ? (a.model === b.model ? a.endpoint.localeCompare(b.endpoint) : -1) : 1;
    });
    options.forEach(function(entry) {
      const option = document.createElement('option');
      option.value = entry.value;
      option.textContent = entry.model + ' @ ' + entry.endpoint;
      option.dataset.model = entry.model;
      option.dataset.endpoint = entry.endpoint;
      modelSel.appendChild(option);
    });

    let selected = '';
    if (wanted) {
      const exact = options.find(function(entry) {
        return entry.value.toLowerCase() === wanted.toLowerCase();
      });
      const bare = wanted.includes('@') ? null : options.find(function(entry) {
        return entry.model.toLowerCase() === wanted.toLowerCase();
      });
      if (exact || bare) {
        selected = (exact || bare).value;
      } else {
        const saved = document.createElement('option');
        saved.value = wanted;
        saved.textContent = wanted + ' (saved; not listed)';
        saved.dataset.model = wanted.split('@')[0];
        saved.dataset.savedUnknown = 'true';
        modelSel.appendChild(saved);
        selected = wanted;
      }
    }
    modelSel.value = selected;
    updateBackendMessage();
  }

  function updateBackendMessage() {
    if (!backendMsg) return;
    const selectedOption = modelSel.options[modelSel.selectedIndex];
    const selectedModel = selectedOption && selectedOption.dataset
      ? selectedOption.dataset.model || selectedOption.value.split('@')[0] : '';
    if (selectedOption && selectedOption.dataset && selectedOption.dataset.savedUnknown === 'true') {
      backendMsg.textContent = 'This saved model is not in the enabled endpoint inventory. Enable its provider and refresh the model list.';
    } else if (selectedModel && selectedModel.toLowerCase().includes('chatgpt-image')) {
      backendMsg.textContent = 'For chatgpt-image-codex, configure the optional host Codex bridge. Quality and size guide generation; Codex may choose the final resolution.';
    } else if (selectedModel === 'sd-cpp-local') {
      backendMsg.textContent = 'Local stable-diffusion.cpp engine. Keep its Cookbook server running; image size is supported, but the cloud quality setting is ignored.';
    } else if (!selectedModel && !Array.from(modelSel.options).some(function(option) { return option.value; })) {
      backendMsg.textContent = 'For local images, download a compatible Stable Diffusion checkpoint in Cookbook and launch its built-in engine. You can also add an image provider under Settings → AI.';
    } else {
      backendMsg.textContent = 'Quality and size support depend on the selected provider.';
    }
  }

  async function fetchJsonWithTimeout(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(url, { credentials: 'same-origin', signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  try {
    const endpoints = await fetchJsonWithTimeout('/api/model-endpoints');
    if (!Array.isArray(endpoints)) throw new Error('Invalid model endpoint response');
    _endpoints = endpoints;
  } catch (e) { console.warn('Failed to load endpoints for image settings', e); }
  try {
    const settings = await fetchJsonWithTimeout('/api/auth/settings');
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      throw new Error('Invalid image settings response');
    }
    _savedModelSpec = settings.image_model || '';
    refreshModels(_savedModelSpec);
    if (settings.image_quality) qualSel.value = settings.image_quality;
    if (enabledToggle) enabledToggle.checked = settings.image_gen_enabled === true;
    settingsLoaded = true;
    controls.forEach(control => { control.disabled = false; });
    if (msg) msg.textContent = '';
  } catch (e) {
    console.warn('Failed to load image settings', e);
    if (msg) {
      msg.textContent = 'Could not load saved image settings. Reload the page before changing them.';
      msg.style.color = 'var(--red)';
    }
  }

  function syncImgDisabled() {
    var off = enabledToggle && !enabledToggle.checked;
    var card = enabledToggle ? enabledToggle.closest('.admin-card') : null;
    if (card) card.style.opacity = off ? '0.45' : '';
    if (configWrap) configWrap.style.pointerEvents = off ? 'none' : '';
  }
  if (settingsLoaded) syncImgDisabled();

  async function saveSettings() {
    if (!settingsLoaded) return;
    const sequence = ++_imageSaveSequence;
    const snapshot = {
      image_gen_enabled: enabledToggle ? enabledToggle.checked : false,
      image_model: modelSel.value,
      image_quality: qualSel.value,
    };
    msg.textContent = 'Saving…'; msg.style.color = 'var(--fg)';
    const save = async () => {
      try {
        const res = await _postSettings(snapshot);
        if (!res.ok) throw new Error(await res.text().catch(() => `HTTP ${res.status}`));
        _savedModelSpec = snapshot.image_model;
        if (sequence === _imageSaveSequence) {
          msg.textContent = 'Saved'; msg.style.color = 'var(--fg)';
          setTimeout(() => {
            if (sequence === _imageSaveSequence && msg.textContent === 'Saved') msg.textContent = '';
          }, 2000);
        }
      } catch (e) {
        if (sequence === _imageSaveSequence) {
          msg.textContent = 'Failed to save'; msg.style.color = 'var(--red)';
        }
      }
    };
    _imageSaveQueue = _imageSaveQueue.then(save, save);
    return _imageSaveQueue;
  }
  modelSel.addEventListener('change', function() { updateBackendMessage(); saveSettings(); });
  qualSel.addEventListener('change', saveSettings);
  if (enabledToggle) enabledToggle.addEventListener('change', function() { syncImgDisabled(); saveSettings(); });

  registerEndpointRefresh(function(endpoints) {
    _endpoints = endpoints;
    refreshModels(modelSel.value);
  });
}
