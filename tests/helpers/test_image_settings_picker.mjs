import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const source = fs.readFileSync(path.join(repo, 'static/js/settings.js'), 'utf8');
const start = source.indexOf('async function initImageSettings()');
const end = source.indexOf('/* ── Vision ── */', start);
assert(start >= 0 && end > start, 'could not locate image settings initializer');
const initSource = source.slice(start, end).trim();

class Select {
  constructor(options = []) {
    this._options = options;
    // HTMLSelectElement.options is a collection, not an Array.
    this.options = new Proxy(options, { get: (target, key) => key === 'some' ? undefined : Reflect.get(target, key) });
    this._value = options[0]?.value || '';
    this.listeners = new Map();
    this.dataset = {};
    this.style = {};
    this.card = { style: {}, querySelector: () => null };
  }

  get value() { return this._value; }
  set value(value) {
    const wanted = String(value ?? '');
    this._value = this._options.some(option => option.value === wanted) ? wanted : '';
  }
  get selectedIndex() { return this.options.findIndex(option => option.value === this._value); }
  appendChild(option) {
    this.options.push(option);
    if (this.options.length === 1) this._value = option.value;
  }
  remove(index) {
    const removed = this.options.splice(index, 1)[0];
    if (removed?.value === this._value) this._value = this.options[0]?.value || '';
  }
  closest() { return this.card; }
  addEventListener(event, callback) {
    const listeners = this.listeners.get(event) || [];
    listeners.push(callback);
    this.listeners.set(event, listeners);
  }
  async fire(event) {
    for (const callback of this.listeners.get(event) || []) await callback();
  }
}

function makeHarness({ endpoints, savedModel = '', savedQuality = 'medium' }) {
  const model = new Select([{ value: '', textContent: 'Auto-detect' }]);
  const quality = new Select([
    { value: 'low', textContent: 'Low' },
    { value: 'medium', textContent: 'Medium' },
    { value: 'high', textContent: 'High' },
  ]);
  const backendMsg = { textContent: '' };
  const statusMsg = { textContent: '', style: {} };
  const toggle = new Select();
  toggle.checked = true;
  const elements = {
    'set-imgModelSelect': model,
    'set-imgQualitySelect': quality,
    'set-imgBackendMsg': backendMsg,
    'set-imgSettingsMsg': statusMsg,
    'set-imgEnabledToggle': toggle,
  };
  const saves = [];
  let refreshHandler = null;
  const context = {
    el: id => elements[id],
    _fetchModelEndpoints: async () => endpoints,
    _registerAiEndpointRefresh: fn => { refreshHandler = fn; },
    sortModelIds: models => [...models].sort((a, b) => String(a).localeCompare(String(b))),
    fetch: async () => ({
      json: async () => ({
        image_model: savedModel,
        image_quality: savedQuality,
        image_gen_enabled: true,
      }),
    }),
    _postSettings: async body => { saves.push(body); return { ok: true }; },
    document: { createElement: () => ({ value: '', textContent: '', dataset: {} }) },
    console: { warn() {} },
    setTimeout() {},
  };
  const init = vm.runInNewContext(`(${initSource})`, context);
  return {
    init,
    model,
    quality,
    backendMsg,
    toggle,
    saves,
    refresh: async next => refreshHandler(next),
  };
}

const endpoints = [
  { id: 'bridge', name: 'Codex bridge', is_enabled: true, model_type: 'image', models: ['chatgpt-image-codex'] },
  { id: 'mixed', name: 'Mixed LLM', is_enabled: true, model_type: 'llm', models: [
    'chatgpt-image-codex', 'gpt-5-image', 'stable-diffusion-inpainting', 'gpt-4o',
  ] },
  { id: 'disabled', name: 'Disabled image', is_enabled: false, model_type: 'image', models: ['hidden-generator'] },
];

const configured = makeHarness({ endpoints, savedModel: 'chatgpt-image-codex' });
await configured.init();
assert.equal(configured.model.value, 'chatgpt-image-codex@Codex bridge');
assert(Array.from(configured.model.options).some(option => option.value === 'chatgpt-image-codex@Mixed LLM'));
assert(Array.from(configured.model.options).some(option => option.value === 'gpt-5-image@Mixed LLM'));
assert(Array.from(configured.model.options).some(option => option.value === 'stable-diffusion-inpainting@Mixed LLM'));
assert(!Array.from(configured.model.options).some(option => option.value.includes('hidden-generator')));
assert.match(configured.backendMsg.textContent, /optional host Codex bridge/);
assert.match(configured.backendMsg.textContent, /Quality and size guide/);

await configured.quality.fire('change');
assert.equal(configured.saves.at(-1).image_model, 'chatgpt-image-codex@Codex bridge');
await configured.refresh([
  { ...endpoints[0], is_enabled: false },
  { ...endpoints[1], models: ['gpt-5-image'] },
  endpoints[2],
]);
assert.equal(configured.model.value, 'chatgpt-image-codex@Codex bridge');
assert.match(configured.model.options.find(option => option.value === configured.model.value).textContent, /not listed/);
await configured.toggle.fire('change');
assert.equal(configured.saves.at(-1).image_model, 'chatgpt-image-codex@Codex bridge');

const empty = makeHarness({ endpoints: [], savedModel: '' });
await empty.init();
assert.equal(empty.model.options.length, 1);
assert.match(empty.backendMsg.textContent, /No image-generation backend detected/);
assert.match(empty.backendMsg.textContent, /Add and enable an image provider/);

const unknown = makeHarness({ endpoints: [], savedModel: 'custom-art-model@Remote provider' });
await unknown.init();
assert.equal(unknown.model.value, 'custom-art-model@Remote provider');
assert.match(unknown.model.options.find(option => option.value === unknown.model.value).textContent, /saved; not listed/);
await unknown.quality.fire('change');
assert.equal(unknown.saves.at(-1).image_model, 'custom-art-model@Remote provider');

console.log(JSON.stringify({
  bridgeAndMixedModels: true,
  duplicateEndpointQualification: true,
  disabledEndpointExcluded: true,
  savedModelSurvivesRefreshAndSave: true,
  emptyAndUnknownBackendMessages: true,
}));
