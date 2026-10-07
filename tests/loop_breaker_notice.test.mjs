import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../static/js/chat.js', import.meta.url), 'utf8');
const startMarker = "} else if (json.type === 'loop_breaker_triggered' || json.type === 'intent_nudge_exhausted') {";
const endMarker = "} else if (json.type === 'teacher_takeover') {";
const start = source.indexOf(startMarker);
const end = source.indexOf(endMarker, start + startMarker.length);
assert.ok(start >= 0 && end > start, 'chat stream guard handler exists');
const handler = source.slice(start + startMarker.length, end);

function runHandler(json, isBackground = false) {
  const calls = { created: [], appended: [], cancelled: 0, removed: 0 };
  const chatBox = { appendChild: node => calls.appended.push(node) };
  const document = {
    createElement: tag => {
      const node = {
        tag,
        appendChild(child) { (node.children ??= []).push(child); },
      };
      calls.created.push(node);
      return node;
    },
    getElementById: () => chatBox,
  };
  new Function(
    'json', '_isBg', '_cancelThinkingTimer', '_removeThinkingSpinner',
    'roundHolder', 'document', `do { ${handler} } while (false);`,
  )(
    json, isBackground,
    () => calls.cancelled++, () => calls.removed++, null, document,
  );
  return calls;
}

test('persisted guard notice suppresses duplicate UI in foreground and background', () => {
  const foreground = runHandler({ type: 'loop_breaker_triggered', persisted_in_text: true });
  assert.equal(foreground.created.length, 0);
  assert.equal(foreground.cancelled, 1);
  assert.equal(foreground.removed, 1);

  const background = runHandler({ type: 'loop_breaker_triggered', persisted_in_text: true }, true);
  assert.equal(background.created.length, 0);
  assert.equal(background.appended.length, 0);
});

test('legacy guard event still renders its stop indicator', () => {
  const calls = runHandler({ type: 'loop_breaker_triggered', message: 'Stopped.' });
  assert.equal(calls.created.length, 2);
  assert.equal(calls.appended.length, 1);
  assert.equal(calls.appended[0].className, 'stopped-indicator');
});
