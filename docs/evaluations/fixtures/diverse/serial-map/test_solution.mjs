import test from 'node:test';
import assert from 'node:assert/strict';
import { mapSeries } from './solution.mjs';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const options = { timeout: 2000 };

test('empty input resolves to an empty new array without calls', options, async () => {
  const input = [];
  const result = await mapSeries(input, () => { assert.fail('must not call worker'); });
  assert.deepEqual(result, []);
  assert.notEqual(result, input);
});

test('sync results preserve duplicates, index, and falsey values', options, async () => {
  const values = [0, false, '', null, undefined];
  const calls = [];
  const result = await mapSeries(['x', 'x', 'x', 'x', 'x'], (item, index) => {
    calls.push([item, index]);
    return values[index];
  });
  assert.deepEqual(calls, [['x', 0], ['x', 1], ['x', 2], ['x', 3], ['x', 4]]);
  assert.deepEqual(result, values);
});

test('mixed synchronous and promise workers preserve output identity', options, async () => {
  const first = { result: 1 }, second = { result: 2 };
  const result = await mapSeries([10, 20], (_, index) => index === 0 ? first : Promise.resolve(second));
  assert.equal(result[0], first);
  assert.equal(result[1], second);
});

test('controlled promises never allow overlapping worker calls', options, async () => {
  const first = deferred(), second = deferred();
  const firstStarted = deferred(), secondStarted = deferred();
  const calls = [];
  let active = 0;
  const pending = mapSeries(['a', 'b', 'c'], (item, index) => {
    calls.push([item, index]);
    assert.equal(active, 0, 'previous worker must settle before next call');
    active++;
    if (index === 0) {
      firstStarted.resolve();
      return first.promise.then(value => { active--; return value; });
    }
    if (index === 1) {
      secondStarted.resolve();
      return second.promise.then(value => { active--; return value; });
    }
    active--;
    return 'C';
  });
  // Observe early failures immediately, avoiding unhandled-rejection noise.
  const observed = pending.then(value => ({ value }), error => ({ error }));
  await Promise.race([firstStarted.promise, pending]);
  await Promise.resolve();
  assert.deepEqual(calls, [['a', 0]]);
  first.resolve('A');
  await Promise.race([secondStarted.promise, pending]);
  await Promise.resolve();
  assert.deepEqual(calls, [['a', 0], ['b', 1]]);
  second.resolve('B');
  const outcome = await observed;
  assert.equal(outcome.error, undefined);
  assert.deepEqual(outcome.value, ['A', 'B', 'C']);
  assert.deepEqual(calls, [['a', 0], ['b', 1], ['c', 2]]);
});

test('synchronous throw stops later calls and preserves error identity', options, async () => {
  const error = new Error('original sync failure');
  const calls = [];
  await assert.rejects(mapSeries([1, 2, 3], (item, index) => {
    calls.push(index);
    if (index === 1) throw error;
    return item;
  }), caught => caught === error);
  assert.deepEqual(calls, [0, 1]);
});

test('promise rejection stops later calls and preserves error identity', options, async () => {
  const error = new Error('original async failure');
  const calls = [];
  await assert.rejects(mapSeries([1, 2, 3], (_, index) => {
    calls.push(index);
    return index === 0 ? Promise.resolve('ok') : Promise.reject(error);
  }), caught => caught === error);
  assert.deepEqual(calls, [0, 1]);
});

test('input array and objects remain unchanged', options, async () => {
  const first = Object.freeze({ n: 3 }), second = Object.freeze({ n: 1 });
  const input = Object.freeze([first, second]);
  const result = await mapSeries(input, value => value.n * 2);
  assert.deepEqual(result, [6, 2]);
  assert.deepEqual(input, [{ n: 3 }, { n: 1 }]);
  assert.equal(input[0], first);
  assert.equal(input[1], second);
});
