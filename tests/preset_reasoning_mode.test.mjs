import assert from 'node:assert/strict';
import { saveCustomPreset, getSelectedPreset } from '../static/js/presets.js';

const elements = new Map();
const field = (value = '') => ({ value, style: {}, classList: { toggle() {} } });
elements.set('custom-character-name', field(''));
elements.set('custom-temperature', field('1'));
elements.set('custom-max-tokens', field('8448'));
elements.set('custom-system-prompt', field(''));
elements.set('custom-reasoning-mode', field('off'));
elements.set('inject-prefix', field(''));
elements.set('inject-suffix', field(''));
elements.set('overflow-preset-btn', field());

globalThis.document = {
  getElementById: (id) => elements.get(id) || null,
  querySelector: (selector) => selector === '.preset-tab.active'
    ? { dataset: { chartab: 'inject' } }
    : null,
};
globalThis.window = { groupModule: { isActive: () => false } };
globalThis.setTimeout = () => 0;

let saved;
globalThis.fetch = async (_url, options) => {
  saved = JSON.parse(options.body);
  return { json: async () => ({ success: true }) };
};

await saveCustomPreset();
assert.equal(saved.reasoning_mode, 'off');
assert.equal(getSelectedPreset(), 'custom', 'thinking-only tuning must activate the preset');
console.log('PASS reasoning-only custom tuning is persisted and selected');
