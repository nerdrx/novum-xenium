const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

const source = fs.readFileSync('static/js/settings.js', 'utf8');
const start = source.indexOf('function _bindFallbackWidget(opts) {');
const end = source.indexOf('\n/* ── Default Chat Model ── */', start);
assert.ok(start >= 0 && end > start, 'fallback widget source is present');
const widgetSource = source.slice(start, end);

(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.BROWSER_EXECUTABLE || '/opt/google/chrome/chrome',
    args: ['--no-sandbox', '--disable-gpu'],
  });
  try {
    const page = await browser.newPage();
    await page.setContent('<div id="fallback"></div><button id="add">Add</button>');
    const result = await page.evaluate(widgetSource => {
      const endpoints = [
        { id: 'active', name: 'Active endpoint', is_enabled: true, online: true, models: ['qwen2-vl'] },
        { id: 'ac59ef6e', name: 'Old endpoint', is_enabled: false, online: false, models: ['qwen3.5:9b-local'] },
      ];
      const saved = [{ endpoint_id: 'ac59ef6e', model: 'qwen3.5:9b-local' }];
      const original = JSON.parse(JSON.stringify(saved));
      const saves = [];
      const ids = { fallback: document.querySelector('#fallback'), add: document.querySelector('#add') };
      const bindWidget = new Function('el', 'sortModelIds', '_postSettings',
        `${widgetSource}\nreturn _bindFallbackWidget;`)(
          id => ids[id], values => values.slice().sort(), async body => saves.push(body));
      const widget = bindWidget({
        containerId: 'fallback', addBtnId: 'add', endpoints: () => endpoints,
        settingKey: 'vision_model_fallbacks', initial: saved,
      });
      const first = document.querySelector('.settings-fallback-row');
      const before = {
        endpointValue: first.querySelector('select').value,
        endpointLabel: first.querySelector('select').selectedOptions[0].textContent,
        endpointOptionDisabled: first.querySelector('select').selectedOptions[0].disabled,
        modelValue: first.querySelectorAll('select')[1].value,
        modelLabel: first.querySelectorAll('select')[1].selectedOptions[0].textContent,
        modelDisabled: first.querySelectorAll('select')[1].disabled,
        saves: saves.length,
      };
      widget.refresh();
      endpoints.splice(0, endpoints.length);
      widget.refresh();
      const missing = document.querySelector('.settings-fallback-row');
      const missingState = {
        endpointValue: missing.querySelector('select').value,
        endpointLabel: missing.querySelector('select').selectedOptions[0].textContent,
        endpointOptionDisabled: missing.querySelector('select').selectedOptions[0].disabled,
        modelValue: missing.querySelectorAll('select')[1].value,
        modelLabel: missing.querySelectorAll('select')[1].selectedOptions[0].textContent,
        modelDisabled: missing.querySelectorAll('select')[1].disabled,
      };
      endpoints.push({ id: 'active', name: 'Active endpoint', is_enabled: true, online: true, models: ['qwen2-vl'] });
      document.querySelector('#add').click();
      const added = document.querySelectorAll('.settings-fallback-row')[1];
      const addedState = {
        endpoint: added.querySelector('select').value,
        model: added.querySelectorAll('select')[1].value,
      };
      return { before, missingState, addedState, original, saves };
    }, widgetSource);
    assert.equal(result.before.endpointValue, 'ac59ef6e');
    assert.equal(result.before.endpointLabel, 'Old endpoint (disabled)');
    assert.equal(result.before.endpointOptionDisabled, true);
    assert.equal(result.before.modelValue, 'qwen3.5:9b-local');
    assert.equal(result.before.modelLabel, 'qwen3.5:9b-local (unavailable)');
    assert.equal(result.before.modelDisabled, true);
    assert.equal(result.before.saves, 0, 'initial render must not persist');
    assert.equal(result.missingState.endpointValue, 'ac59ef6e');
    assert.equal(result.missingState.endpointLabel, 'Unavailable endpoint (ac59ef6e)');
    assert.equal(result.missingState.endpointOptionDisabled, true);
    assert.equal(result.missingState.modelValue, 'qwen3.5:9b-local');
    assert.equal(result.missingState.modelLabel, 'qwen3.5:9b-local (unavailable)');
    assert.equal(result.missingState.modelDisabled, true);
    assert.deepEqual(result.original, [{ endpoint_id: 'ac59ef6e', model: 'qwen3.5:9b-local' }],
      'render and endpoint refresh must not mutate original saved values');
    assert.equal(result.saves.length, 1, 'only explicit Add action persists');
    assert.deepEqual(result.saves[0].vision_model_fallbacks[0], result.original[0],
      'adding another row must not discard unavailable saved fallback');
    assert.deepEqual(result.addedState, { endpoint: 'active', model: 'qwen2-vl' },
      'new row displays its first available model');
    assert.deepEqual(result.saves[0].vision_model_fallbacks[1],
      { endpoint_id: 'active', model: 'qwen2-vl' },
      'Add action persists the model shown in the new row');
    console.log('PASS unavailable fallback remains visible and saved');
    await page.close();
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
