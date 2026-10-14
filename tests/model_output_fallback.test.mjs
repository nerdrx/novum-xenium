import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { modelOutputFallback } from '../static/js/modelOutputFallback.js';

const output = 'The search results are generic, so the available sources do not confirm a match.';
const base = {
  thinking: output,
  round_texts: ['I will search the web now.', '', ''],
  tool_events: [{ tool: 'web_search' }],
};

test('exposes reasoning payload only when completed tool work has no final round text', () => {
  assert.equal(modelOutputFallback('I will search the web now.', base), output);
});

test('also exposes output when the final round only emitted tool events', () => {
  const sourceOnly = { ...base, round_texts: ['I will search the web now.', ''] };
  assert.equal(modelOutputFallback('I will search the web now.', sourceOnly), output);
});

test('live completion can provide its tagged final-round reasoning as the candidate', () => {
  const { thinking, ...metrics } = base;
  assert.equal(modelOutputFallback('I will search the web now.', metrics, output), output);
});

test('preserves a distinct final answer channel', () => {
  const distinct = { ...base, round_texts: ['I searched.', 'Here is the answer.'] };
  assert.equal(modelOutputFallback('I searched. Here is the answer.', distinct), null);
});

test('does not replace unrelated visible content or ordinary non-Agent replies', () => {
  assert.equal(modelOutputFallback('I searched. A separate final answer exists.', base), null);
  assert.equal(modelOutputFallback('A normal reply.', { thinking: output }), null);
  assert.equal(modelOutputFallback('I searched.', { ...base, tool_events: [] }), null);
});

test('live chat imports the named fallback renderer it invokes', async () => {
  const source = await readFile(new URL('../static/js/chat.js', import.meta.url), 'utf8');
  assert.match(source, /import chatRenderer, \{ modelOutputFallbackHtml \} from ['"]\.\/chatRenderer\.js\?v=/);
  assert.match(source, /modelOutputFallbackHtml\(_modelOutputFallback\)/);
});
