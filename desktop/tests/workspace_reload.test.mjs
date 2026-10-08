import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

test('workspace reload shortcuts work without native management access', () => {
  let handler, reloads = 0;
  runInNewContext(readFileSync(new URL('../src-tauri/src/workspace_reload.js', import.meta.url), 'utf8'), {
    document: { addEventListener(type, callback, capture) {
      assert.equal(type, 'keydown'); assert.equal(capture, true); handler = callback;
    } },
    window: { location: { reload() { reloads++; } } },
  });
  for (const options of [{ key: 'F5' }, { key: 'r', ctrlKey: true }, { key: 'R', metaKey: true }]) {
    let prevented = false, stopped = false;
    handler({ ...options, preventDefault() { prevented = true; }, stopImmediatePropagation() { stopped = true; } });
    assert.ok(prevented && stopped);
  }
  assert.equal(reloads, 3);
  for (const options of [{ key: 'r' }, { key: 'r', ctrlKey: true, altKey: true }, { key: 'F5', repeat: true }]) handler(options);
  assert.equal(reloads, 3);
});
