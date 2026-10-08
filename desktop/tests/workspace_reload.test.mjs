import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

test('workspace reload and mouse history shortcuts work without native management access', () => {
  let handler, auxclick, reloads = 0, historyIndex = 0;
  const historyMoves = [];
  runInNewContext(readFileSync(new URL('../src-tauri/src/workspace_reload.js', import.meta.url), 'utf8'), {
    document: { addEventListener(type, callback, capture) {
      assert.equal(capture, true);
      if (type === 'keydown') handler = callback;
      else if (type === 'auxclick') auxclick = callback;
      else assert.fail(`unexpected event ${type}`);
    } },
    window: {
      history: { get length() { return historyIndex ? 2 : 1; }, go(delta) { historyMoves.push(delta); } },
      location: { reload() { reloads++; } },
    },
  });
  for (const options of [{ key: 'F5' }, { key: 'r', ctrlKey: true }, { key: 'R', metaKey: true }]) {
    let prevented = false, stopped = false;
    handler({ ...options, preventDefault() { prevented = true; }, stopImmediatePropagation() { stopped = true; } });
    assert.ok(prevented && stopped);
  }
  assert.equal(reloads, 3);
  for (const options of [{ key: 'r' }, { key: 'r', ctrlKey: true, altKey: true }, { key: 'F5', repeat: true }]) handler(options);
  assert.equal(reloads, 3);

  const sideButton = button => {
    let prevented = false, stopped = false;
    auxclick({ button, preventDefault() { prevented = true; }, stopImmediatePropagation() { stopped = true; } });
    return { prevented, stopped };
  };
  assert.deepEqual(sideButton(3), { prevented:true, stopped:true });
  assert.deepEqual(historyMoves, [], 'back does nothing when there is no prior entry');
  historyIndex = 1;
  assert.deepEqual(sideButton(3), { prevented:true, stopped:true });
  assert.deepEqual(sideButton(4), { prevented:true, stopped:true });
  assert.deepEqual(historyMoves, [-1, 1]);
  sideButton(2);
  assert.deepEqual(historyMoves, [-1, 1], 'ordinary middle click keeps its default behavior');
});
