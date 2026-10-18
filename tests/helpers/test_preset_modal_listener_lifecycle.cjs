const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('static/js/presets.js', 'utf8');
function extract(startMarker, endMarker, replacement) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert(start >= 0 && end > start, `locate ${startMarker}`);
  return source.slice(start, end).replace(replacement[0], replacement[1]);
}
const openFunction = extract('export function openCustomPresetModal(', '/**\n * Save custom preset', ['export function openCustomPresetModal(', 'function openCustomPresetModal(']);
const templateLoader = extract('function _tryLoadTemplate(name) {', 'function _populateCharSelect()', ['function _tryLoadTemplate(name) {', 'function _tryLoadTemplate(name) {']);

function setup() {
  class Element {
    constructor(id = '') {
      this.id = id; this.value = ''; this.checked = true; this.style = {};
      this.listeners = {}; this.dataset = { chartab: 'character' };
      this.classList = { add() {}, remove() {}, toggle() {}, contains() { return false; } };
    }
    addEventListener(type, callback) { (this.listeners[type] ||= []).push(callback); }
    removeEventListener(type, callback) { this.listeners[type] = (this.listeners[type] || []).filter(fn => fn !== callback); }
    dispatch(type) { for (const fn of [...(this.listeners[type] || [])]) fn({ target: this }); }
    dispatchEvent(event) { this.dispatch(event.type); }
    focus() {}
    remove() {}
    querySelector(selector) { return selector === '.modal-body' ? body : selector === '.preset-tab.active' ? tab : null; }
    querySelectorAll() { return []; }
  }
  const ids = ['custom-preset-modal', 'custom-character-name', 'custom-temperature', 'custom-max-tokens',
    'custom-system-prompt', 'custom-reasoning-mode', 'custom-thinking-mode', 'custom-show-persona-name',
    'char-template-select', 'temp-value', 'tokens-value', 'inject-prefix', 'inject-suffix',
    'save-custom-preset', 'reset-character-btn', 'cancel-custom-preset', 'char-delete-template-btn',
    'create-persistent-chat-btn', 'char-new-btn', 'char-lock-notice', 'char-name-row'];
  const elements = Object.fromEntries(ids.map(id => [id, new Element(id)]));
  const body = new Element('body'), tab = new Element('tab');
  const templates = [
    { name: 'Example', isCharacter: true, prompt: 'Example prompt', temperature: 0.7 },
    { name: 'Second', isCharacter: true, prompt: 'Second prompt', temperature: 0.8 },
  ];
  const document = {
    getElementById: id => elements[id] || null,
    querySelectorAll: () => [tab], querySelector: () => tab, createElement: () => new Element(),
  };
  let fetchCalls = 0;
  const context = {
    document, window: {}, presets: {}, userTemplates: [], PROMPT_TEMPLATES: templates, Event,
    fetch() { fetchCalls++; throw new Error('unexpected API call'); }, console,
    setTimeout() { throw new Error('modal listener should not schedule delayed snapshots'); },
    clearTimeout() {},
  };
  vm.createContext(context);
  vm.runInContext(`${templateLoader}\n${openFunction}\nglobalThis.openCustomPresetModal=openCustomPresetModal;`, context);
  const selector = elements['char-template-select'];
  const nameInput = elements['custom-character-name'];
  const promptInput = elements['custom-system-prompt'];
  const tempInput = elements['custom-temperature'];
  const tokensInput = elements['custom-max-tokens'];
  const reasoningInput = elements['custom-reasoning-mode'];
  const thinkingInput = elements['custom-thinking-mode'];
  // Mirrors initNameDropdown's already-registered change handler: template data
  // is populated synchronously before the modal's per-open snapshot handler.
  selector.addEventListener('change', () => {
    if (!selector.value || selector.value === '__default__') {
      nameInput.value = ''; promptInput.value = ''; tempInput.value = 1.0; tokensInput.value = 8448;
      reasoningInput.value = 'auto'; thinkingInput.value = '';
      tempInput.dispatchEvent(new Event('input')); tokensInput.dispatchEvent(new Event('input'));
      return;
    }
    const selected = templates.find(template => template.name === selector.value);
    nameInput.value = selected && selected.isCharacter ? selected.name : '';
    context._tryLoadTemplate(selector.value);
  });
  // Existing + New and reset controls both select the default entry; neither
  // should trigger a server request.
  elements['char-new-btn'].addEventListener('click', () => {
    selector.value = '__default__'; selector.dispatch('change'); nameInput.value = ''; nameInput.focus();
  });
  elements['reset-character-btn'].addEventListener('click', () => {
    selector.value = '__default__'; selector.dispatch('change');
  });
  return { context, elements, fetchCalls: () => fetchCalls };
}

{
  const { context, elements } = setup();
  context.openCustomPresetModal();
  context.openCustomPresetModal();
  const inputIds = ['custom-character-name', 'custom-system-prompt', 'custom-temperature', 'custom-max-tokens', 'custom-thinking-mode', 'custom-show-persona-name'];
  for (const id of inputIds) {
    const input = elements[id];
    const expectedTotal = id === 'custom-character-name' ? 2 : 1; // name also has one-time row-sync listener
    assert.equal(input.listeners.input.length, expectedTotal, `${id} does not accumulate handlers`);
  }
  assert.equal(elements['custom-reasoning-mode'].listeners.change.length, 1);
  assert.equal(elements['char-template-select'].listeners.change.length, 2, 'one existing loader plus one current snapshot handler');
}

{
  const { context, elements, fetchCalls } = setup();
  const selector = elements['char-template-select'];
  const name = elements['custom-character-name'];
  const prompt = elements['custom-system-prompt'];
  const button = elements['save-custom-preset'];
  context.openCustomPresetModal();
  selector.value = 'Example';
  selector.dispatch('change');
  assert.equal(name.value, 'Example');
  assert.equal(prompt.value, 'Example prompt');
  assert.equal(button.textContent, 'Start Persona', 'synchronous template selection establishes clean baseline');
  name.value = 'Edited Example'; name.dispatch('input');
  assert.equal(button.textContent, 'Save & Start Persona');

  selector.value = 'Second'; selector.dispatch('change');
  assert.equal(name.value, 'Second');
  assert.equal(prompt.value, 'Second prompt');
  assert.equal(button.textContent, 'Start Persona', 'new selection replaces the previous snapshot');
  name.value = 'Edited Second'; name.dispatch('input');
  assert.equal(button.textContent, 'Save & Start Persona');

  elements['char-new-btn'].dispatch('click');
  assert.equal(name.value, '');
  assert.equal(prompt.value, '');
  assert.equal(button.textContent, 'Start Persona');
  elements['reset-character-btn'].dispatch('click');
  assert.equal(button.textContent, 'Start Persona');
  assert.equal(fetchCalls(), 0, '+ New and reset stay local');
}

console.log('PASS: prompt modal listener lifecycle, synchronous template snapshots, + New/reset');
