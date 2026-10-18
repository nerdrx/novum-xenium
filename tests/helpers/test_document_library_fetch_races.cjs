const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const source = fs.readFileSync(path.join(root, 'static/js/documentLibrary.js'), 'utf8');
const fetchStart = source.indexOf('async function libraryFetch(append) {');
const fetchEnd = source.indexOf('\n  function libraryRenderStats()', fetchStart);
const invalidateStart = source.indexOf('function _invalidateLibraryFetches() {');
const invalidateEnd = source.indexOf('\n\n// Highlight', invalidateStart);
assert.ok(fetchStart >= 0 && fetchEnd > fetchStart, 'libraryFetch source boundaries found');
assert.ok(invalidateStart >= 0 && invalidateEnd > invalidateStart, 'invalidation source boundaries found');
const fetchSource = source.slice(fetchStart, fetchEnd);
const invalidateSource = source.slice(invalidateStart, invalidateEnd);

function createHarness() {
  const calls = [];
  const fakeFetch = url => new Promise((resolve, reject) => calls.push({ url, resolve, reject }));
  fakeFetch.calls = calls;
  const create = new Function('fakeFetch', `
    const fetch = fakeFetch;
    const API_BASE = '';
    let _libraryOffset = 0, _librarySort = 'recent', _librarySearch = '';
    let _libraryActiveLanguage = null, _libraryArchivedView = false;
    let _libraryFetchGeneration = 0, _libraryAppliedGeneration = 0;
    let _libraryDocs = [], _docsVisibleLimit = 20;
    let _libraryTotal = 0, _libraryLanguages = {}, _librarySessionCount = 0;
    const renders = [];
    function libraryRenderStats() {}
    function libraryRenderLangChips() {}
    function libraryRenderGrid() { renders.push(_libraryDocs.map(doc => doc.id)); }
    function libraryRenderLoadMore() {}
    ${invalidateSource}
    ${fetchSource}
    return {
      libraryFetch,
      invalidate: _invalidateLibraryFetches,
      setSearch: value => { _librarySearch = value; },
      setOffset: value => { _libraryOffset = value; },
      state: () => ({ docs: _libraryDocs.map(doc => doc.id), total: _libraryTotal, generation: _libraryFetchGeneration, appliedGeneration: _libraryAppliedGeneration }),
      calls: fakeFetch.calls,
      renders,
    };
  `);
  const harness = create(fakeFetch);
  return harness;
}

const response = documents => ({ ok: true, statusText: 'OK', json: async () => ({ documents, total: 100, languages: { text: 100 }, session_count: 0 }) });
const doc = id => ({ id, title: id });
async function settle(harness, index, documents) {
  harness.calls[index].resolve(response(documents));
  await new Promise(setImmediate);
}

(async () => {
  {
    const h = createHarness();
    h.setSearch('alpha'); const alpha = h.libraryFetch(false);
    h.setSearch('beta'); const beta = h.libraryFetch(false);
    assert.match(h.calls[0].url, /search=alpha/);
    assert.match(h.calls[1].url, /search=beta/);
    await settle(h, 1, [doc('beta')]); await beta;
    await settle(h, 0, [doc('alpha')]); await alpha;
    assert.deepEqual(h.state().docs, ['beta'], 'late alpha search is ignored');
    assert.deepEqual(h.renders, [['beta']], 'stale response does not render');
  }
  {
    const h = createHarness();
    const old = h.libraryFetch(false); // previous opening
    h.invalidate();                   // close invalidates the old opening
    const reopened = h.libraryFetch(false);
    await settle(h, 1, [doc('reopened')]); await reopened;
    await settle(h, 0, [doc('closed')]); await old;
    assert.deepEqual(h.state().docs, ['reopened'], 'closed panel response cannot replace reopened list');
  }
  {
    const h = createHarness();
    const first = h.libraryFetch(false);
    await settle(h, 0, [doc('alpha')]); await first;
    h.setOffset(1);
    const staleAppend = h.libraryFetch(true);
    h.setSearch('beta');
    const reset = h.libraryFetch(false);
    await settle(h, 2, [doc('beta')]); await reset;
    await settle(h, 1, [doc('old-page')]); await staleAppend;
    assert.deepEqual(h.state().docs, ['beta'], 'append from previous filter is ignored');
  }
  {
    const h = createHarness();
    const first = h.libraryFetch(false);
    await settle(h, 0, [doc('alpha')]); await first;
    h.setSearch('beta');
    const reset = h.libraryFetch(false);
    h.setOffset(1);
    const appendDuringReset = h.libraryFetch(true);
    assert.equal(await appendDuringReset, false, 'append is rejected until current base list applies');
    assert.equal(h.calls.length, 2, 'no beta page request is sent against old alpha rows');
    await settle(h, 1, [doc('beta')]); await reset;
    assert.deepEqual(h.state().docs, ['beta']);
  }
  {
    const h = createHarness();
    const first = h.libraryFetch(false);
    await settle(h, 0, [doc('alpha')]); await first;
    h.setSearch('beta');
    const originalError = console.error;
    console.error = () => {};
    try {
      const failedReset = h.libraryFetch(false);
      h.calls[1].resolve({ ok: false, statusText: 'offline' });
      await failedReset;
    } finally { console.error = originalError; }
    assert.deepEqual(h.state().docs, ['alpha'], 'failed reset retains last good list');
    h.setOffset(1);
    assert.equal(await h.libraryFetch(true), false, 'append stays blocked until a fresh base list succeeds');
    assert.equal(h.calls.length, 2);
  }
  {
    const h = createHarness();
    const first = h.libraryFetch(false);
    await settle(h, 0, [doc('a')]); await first;
    h.setOffset(1);
    const pageOne = h.libraryFetch(true);
    const duplicatePageOne = h.libraryFetch(true);
    assert.equal(h.calls.length, 3, 'both same-offset requests were started');
    await settle(h, 2, [doc('b')]); await duplicatePageOne;
    await settle(h, 1, [doc('b')]); await pageOne;
    assert.deepEqual(h.state().docs, ['a', 'b'], 'same-page completion cannot duplicate rows');
  }
  {
    const h = createHarness();
    const first = h.libraryFetch(false);
    await settle(h, 0, [doc('a')]); await first;
    h.setOffset(1);
    const originalError = console.error;
    console.error = () => {};
    try {
      const failed = h.libraryFetch(true);
      h.calls[1].resolve({ ok: false, statusText: 'offline' });
      await failed;
      const retry = h.libraryFetch(true);
      await settle(h, 2, [doc('b')]); await retry;
    } finally { console.error = originalError; }
    assert.deepEqual(h.state().docs, ['a', 'b'], 'failed append can be retried successfully');
  }
  const closeStart = source.indexOf('export function closeLibrary()');
  const closeEnd = source.indexOf('\n  export function isLibraryOpen()', closeStart);
  assert.match(source.slice(closeStart, closeEnd), /_invalidateLibraryFetches\(\)/, 'close invalidates in-flight requests');
  console.log('PASS: library list generations reject stale results; append waits for a base page, keeps offsets, avoids duplicates, and retries after errors');
})().catch(error => { console.error(error); process.exitCode = 1; });
