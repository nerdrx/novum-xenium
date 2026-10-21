import test from 'node:test';
import assert from 'node:assert/strict';
import { createNotesState } from '../frontend/src/features/notes/application/state.js';
import { createCardOperations } from '../frontend/src/features/notes/application/cardOperations.js';
import { createChecklistOperations } from '../frontend/src/features/notes/application/checklistOperations.js';
import { createNotesSubmission } from '../frontend/src/features/notes/application/submission.js';
import { createSelectionOperations } from '../frontend/src/features/notes/application/selection.js';
import { createNotesPersistence } from '../frontend/src/features/notes/infrastructure/storage.js';
import { createNotesLifecycle } from '../frontend/src/features/notes/ui/lifecycle.js';
import { createText } from '../frontend/src/features/notes/ui/text.js';
import { createDeletion } from '../frontend/src/features/notes/application/deletion.js';
import { createNotesWorkflows } from '../frontend/src/features/notes/application/workflows.js';
import { createNotesReminders } from '../frontend/src/features/notes/application/reminders.js';

const drain = () => new Promise(setImmediate);
function owner(notes) { const app = createNotesState(); app.replaceNotes(notes); return app; }

test('reorder retains desktop persistence-only and mobile post-response state ordering', async () => {
  const app = owner([{ id: 'a', sort_order: 9 }, { id: 'b', sort_order: 8 }]), requests = [];
  let resolve;
  const operations = createCardOperations({ app, api: { reorder: ids => { requests.push(ids); return new Promise(done => { resolve = done; }); } } });
  const desktop = operations.persistOrder(['b', 'a']);
  resolve({ ok: false }); await desktop;
  assert.deepEqual(app.state.notes.map(note => note.sort_order), [9, 8]);
  const mobile = operations.commitMobileOrder(['b', 'a']);
  assert.deepEqual(app.state.notes.map(note => note.sort_order), [9, 8]);
  resolve({ ok: false }); await mobile;
  assert.deepEqual(app.state.notes.map(note => note.sort_order), [1, 0]);
  assert.deepEqual(requests, [['b', 'a'], ['b', 'a']]);
});

test('editor deletion waits for confirmation and preserves optimistic failure/refetch timing', async () => {
  const app = owner([{ id: 'a' }]), events = [];
  app.setEditingId('a');
  let confirm, fail;
  const operations = createDeletion({ app, state: app.state,
    _deleteNoteApi: id => { events.push('delete:' + id); return new Promise((_resolve, reject) => { fail = reject; }); },
    _fetchNotes: async () => { events.push('fetch'); app.replaceNotes([{ id: 'a' }]); },
    _renderNotes: () => events.push('render'),
    effects: { styledConfirm: () => new Promise(resolve => { confirm = resolve; }), showToast: () => events.push('toast'), showError: error => events.push(error) },
  });
  const deletion = operations.deleteFromEditor('a');
  assert.equal(app.state.notes.length, 1);
  confirm(false); await deletion;
  assert.deepEqual(events, []);
  const accepted = operations.deleteFromEditor('a');
  confirm(true); await accepted;
  assert.equal(app.state.notes.length, 0);
  assert.equal(app.state.editingId, null);
  assert.deepEqual(events, ['render', 'delete:a']);
  fail(Error('403')); await drain();
  assert.equal(app.state.notes[0].id, 'a');
  assert.deepEqual(events, ['render', 'delete:a', 'Failed to delete', 'fetch', 'render']);
});

test('selected delete captures confirmation targets and preserves newer selection', async () => {
  const app = owner([{ id: 'a' }, { id: 'b' }, { id: 'c' }]), events = [];
  app.setSelectMode(true); app.selectId('a');
  let confirm, resolveDelete;
  const operations = createSelectionOperations({
    app,
    api: { deleteNote: id => { events.push(`delete:${id}`); return new Promise(resolve => { resolveDelete = resolve; }); } },
    effects: { styledConfirm: () => new Promise(resolve => { confirm = resolve; }), render: () => events.push('render'), showToast: text => events.push(`toast:${text}`), showError: text => events.push(`error:${text}`) },
    sendContext() {},
    exitSelection: () => { app.setSelectMode(false); app.clearSelection(); events.push('exit'); },
    fetchNotes: async () => { app.replaceNotes([{ id: 'b' }, { id: 'c' }]); events.push('fetch'); return true; },
  });
  const deletion = operations.deleteSelected();
  app.selectId('b');
  confirm(true);
  await drain();
  assert.deepEqual(events, ['delete:a'], 'only the selection captured before confirmation is sent');
  app.selectId('c');
  resolveDelete();
  await deletion;
  assert.deepEqual([...app.state.selectedIds], ['b', 'c']);
  assert.equal(app.state.selectMode, true);
  assert.deepEqual(events, ['delete:a', 'fetch', 'render', 'toast:Deleted 1']);
});

test('selected delete failure retains still-present selection and respects cancellation', async () => {
  const app = owner([{ id: 'a' }]), events = [];
  app.setSelectMode(true); app.selectId('a');
  let rejectDelete;
  const operations = createSelectionOperations({
    app,
    api: { deleteNote: () => new Promise((_resolve, reject) => { rejectDelete = reject; }) },
    effects: { styledConfirm: async () => true, render: () => events.push('render'), showToast: text => events.push(`toast:${text}`), showError: text => events.push(`error:${text}`) },
    sendContext() {},
    exitSelection: () => { app.setSelectMode(false); app.clearSelection(); events.push('exit'); },
    fetchNotes: async () => true,
  });
  const deletion = operations.deleteSelected();
  await drain();
  assert.equal(typeof rejectDelete, 'function');
  app.clearSelection(); app.setSelectMode(false);
  rejectDelete(Error('HTTP 403'));
  await deletion;
  assert.deepEqual([...app.state.selectedIds], [], 'the failed target is not reselected after user cancellation');
  assert.equal(app.state.selectMode, false);
  assert.equal(events.some(event => event.startsWith('error:') && /could not confirm 1 note delete operation/i.test(event)), true);
  assert.equal(events.some(event => event.startsWith('toast:')), false);
});

test('selected archive reports partial failure and keeps failed selection', async () => {
  const app = owner([{ id: 'a' }, { id: 'b' }]), events = [];
  app.setSelectMode(true); app.selectId('a'); app.selectId('b');
  const operations = createSelectionOperations({
    app,
    api: { patchNote: async id => { if (id === 'a') throw Error('HTTP 403'); } },
    effects: { render: () => events.push('render'), showToast: text => events.push(`toast:${text}`), showError: text => events.push(`error:${text}`) },
    sendContext() {},
    exitSelection: () => { app.setSelectMode(false); app.clearSelection(); events.push('exit'); },
    fetchNotes: async () => { app.replaceNotes([{ id: 'a' }]); return true; },
  });
  await operations.archiveSelected();
  assert.deepEqual([...app.state.selectedIds], ['a']);
  assert.equal(app.state.selectMode, true);
  assert.equal(events.some(event => event.startsWith('error:') && /archived 1; could not confirm 1 note archive operation/i.test(event)), true);
  assert.equal(events.some(event => event.startsWith('toast:')), false);
});

test('clearing past reminders distinguishes mutation failure from refresh failure', async () => {
  const app = owner([
    { id: 'failed', due_date: '2000-01-01T00:00:00Z' },
    { id: 'deleted', due_date: '2000-01-01T00:00:00Z' },
  ]), events = [];
  const deletion = createDeletion({
    app,
    state: app.state,
    _deleteNoteApi: async id => { if (id === 'failed') throw Error('HTTP 503'); },
    _fetchNotes: async () => false,
    _isPastReminder: () => true,
    _renderNotes: () => events.push('render'),
    effects: { styledConfirm: async () => true, showToast: text => events.push(`toast:${text}`), showError: text => events.push(`error:${text}`) },
  });
  await deletion._clearPastReminders();
  assert.equal(events.includes('render'), true);
  assert.equal(events.some(event => event.startsWith('error:') && /Cleared 1 past reminder; Could not confirm deletion of 1 past reminder\. Check Notes before retrying\. The Notes list also could not refresh\./i.test(event)), true);
  assert.equal(events.some(event => event.startsWith('toast:')), false);
});

test('clearing past reminders reports confirmed success when refresh succeeds', async () => {
  const app = owner([{ id: 'old', due_date: '2000-01-01T00:00:00Z' }]), events = [];
  const deletion = createDeletion({
    app,
    state: app.state,
    _deleteNoteApi: async () => {},
    _fetchNotes: async () => { app.replaceNotes([]); return true; },
    _isPastReminder: () => true,
    _renderNotes: () => events.push('render'),
    effects: { styledConfirm: async () => true, showToast: text => events.push(`toast:${text}`), showError: text => events.push(`error:${text}`) },
  });
  await deletion._clearPastReminders();
  assert.deepEqual(app.state.notes, []);
  assert.deepEqual(events, ['render', 'toast:Cleared 1 past reminder']);
});

test('pin and delete failures roll back captured state and order', async () => {
  const app = owner([{ id: 'a', pinned: false, sort_order: 4 }, { id: 'b', pinned: true, sort_order: -3 }]), errors = [];
  const operations = createCardOperations({ app, api: { patchNote: async () => { throw Error('403'); }, deleteNote: async () => { throw Error('403'); } }, effects: { render() {}, showError: error => errors.push(error) } });
  operations.togglePin('a');
  assert.equal(app.state.notes[0].pinned, true);
  assert.equal(app.state.notes[0].sort_order, -4);
  await drain();
  assert.equal(app.state.notes[0].pinned, false);
  assert.equal(app.state.notes[0].sort_order, 4);
  operations.deleteOptimistically('a');
  assert.deepEqual(app.state.notes.map(n => n.id), ['b']);
  await drain();
  assert.deepEqual(app.state.notes.map(n => n.id), ['a', 'b']);
  assert.deepEqual(errors, ['Failed to pin', 'Failed to delete']);
});

test('item removal, quick add and checkbox errors preserve checklist contents', async () => {
  const app = owner([{ id: 'a', items: [{ id: 'first', text: 'A', done: false }, { id: 'second', text: 'B', done: true }] }]);
  const operations = createChecklistOperations({ app, api: { patchNote: async () => { throw Error('offline'); } }, uid: () => 'new', effects: { render() {}, showError() {} } });
  operations.removeItem('a', 0);
  assert.equal(app.state.notes[0].items[0].id, 'second');
  await drain();
  assert.deepEqual(app.state.notes[0].items.map(it => it.id), ['first', 'second']);
  const done = [];
  operations.toggleItem('a', 0, value => done.push(value), () => {});
  await drain();
  assert.deepEqual(done, [true, false]);
  const persist = operations.addItem('a', 'C', () => {});
  assert.equal(app.state.notes[0].items.length, 3);
  persist(); await drain();
  assert.equal(app.state.notes[0].items.length, 2);
  operations.editItem(app.state.notes[0], 1, 'Changed');
  await drain();
  assert.equal(app.state.notes[0].items[1].text, 'B');
});

test('submission preserves top ordering, server ID replacement and newer draft recovery', async () => {
  const app = owner([{ id: 'existing', sort_order: -2 }]), values = new Map();
  const persistence = createNotesPersistence({ storage: { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) } });
  const draftKey = persistence._draftKey('__new__');
  values.set(draftKey, '{"content":"submitted"}');
  let resolve, renders = 0;
  const operations = createNotesSubmission({ app, persistence, clock: { now: () => 0 }, uid: () => 'id', api: { saveNote: () => new Promise(r => { resolve = r; }) }, effects: { render: () => renders++, showError() {} }, fetchNotes: async () => {} });
  operations.submitNote({ title: 'New' }, null, false);
  assert.equal(app.state.notes[0].id, 'tmp_id');
  assert.equal(app.state.notes[0].sort_order, -3);
  values.set(draftKey, '{"content":"newer"}');
  resolve({ id: 'server-id' }); await drain();
  assert.equal(app.state.notes[0].id, 'server-id');
  assert.equal(values.get(draftKey), '{"content":"newer"}');
  assert.equal(renders, 2);
});

test('concurrent create responses replace only their own temporary rows', async () => {
  for (const responseOrder of [[0, 1], [1, 0]]) {
    const app = owner([]), pending = [];
    const operations = createNotesSubmission({
      app,
      persistence: {
        _loadFiredReminders: () => new Set(), _saveFiredReminders() {},
        _loadGlowedReminders: () => new Set(), _saveGlowedReminders() {},
        _loadDraft: () => null, _clearDraft() {},
      },
      clock: { now: () => 0 }, uid: (() => { let next = 0; return () => String(++next); })(),
      api: { saveNote: payload => new Promise(resolve => pending.push({ payload, resolve })) },
      effects: { render() {}, showError() {} }, fetchNotes: async () => {},
    });
    operations.submitNote({ title: 'First' }, null, false);
    operations.submitNote({ title: 'Second' }, null, false);
    assert.deepEqual(app.state.notes.map(({ id, title }) => [id, title]), [['tmp_2', 'Second'], ['tmp_1', 'First']]);

    for (const responseIndex of responseOrder) {
      const saved = responseIndex === 0 ? { id: 'server-first', title: 'First' } : { id: 'server-second', title: 'Second' };
      pending[responseIndex].resolve(saved);
      await drain();
      const expected = responseIndex === 0
        ? [['tmp_2', 'Second'], ['server-first', 'First']]
        : [['server-second', 'Second'], ['tmp_1', 'First']];
      if (app.state.notes.some(note => note.id.startsWith('tmp_'))) {
        assert.deepEqual(app.state.notes.map(({ id, title }) => [id, title]), expected);
      }
    }
    assert.deepEqual(app.state.notes.map(({ id, title }) => [id, title]), [['server-second', 'Second'], ['server-first', 'First']]);
  }
});

test('removed create row response leaves other pending rows untouched', async () => {
  const app = owner([]), pending = [];
  const operations = createNotesSubmission({
    app,
    persistence: {
      _loadFiredReminders: () => new Set(), _saveFiredReminders() {},
      _loadGlowedReminders: () => new Set(), _saveGlowedReminders() {},
      _loadDraft: () => null, _clearDraft() {},
    },
    clock: { now: () => 0 }, uid: (() => { let next = 0; return () => String(++next); })(),
    api: { saveNote: payload => new Promise(resolve => pending.push({ payload, resolve })) },
    effects: { render() {}, showError() {} }, fetchNotes: async () => {},
  });
  operations.submitNote({ title: 'First' }, null, false);
  operations.submitNote({ title: 'Second' }, null, false);
  app.removeNoteAt(1);

  pending[0].resolve({ id: 'server-first', title: 'First' });
  await drain();
  assert.deepEqual(app.state.notes.map(({ id, title }) => [id, title]), [['tmp_2', 'Second']]);

  pending[1].resolve({ id: 'server-second', title: 'Second' });
  await drain();
  assert.deepEqual(app.state.notes.map(({ id, title }) => [id, title]), [['server-second', 'Second']]);
});

test('editor save invalidates an older list response', async () => {
  const app = owner([{ id: 'note', title: 'Before' }]);
  let resolveList, resolveSave;
  const workflows = createNotesWorkflows({
    app,
    api: {
      listNotes: () => new Promise(resolve => { resolveList = resolve; }),
      saveNote: () => new Promise(resolve => { resolveSave = resolve; }),
    },
    effects: {},
  });
  const submission = createNotesSubmission({
    app,
    persistence: {
      _loadFiredReminders: () => new Set(), _saveFiredReminders() {},
      _loadGlowedReminders: () => new Set(), _saveGlowedReminders() {},
      _loadDraft: () => null, _clearDraft() {},
    },
    clock: { now: () => 0 }, uid: () => 'new',
    api: { saveNote: () => assert.fail('submission must use guarded save') },
    saveNote: workflows._saveNote,
    effects: { render() {}, showError() {}, clearGlow() {} },
    fetchNotes: workflows._fetchNotes,
  });

  const refresh = workflows._fetchNotes();
  submission.submitNote({ id: 'note', title: 'After' }, app.state.notes[0], true);
  assert.equal(app.state.notes[0].title, 'After');
  assert.equal(workflows.getDataRevision(), 1);

  resolveList({ ok: true, json: async () => ({ notes: [{ id: 'note', title: 'Before' }] }) });
  assert.equal(await refresh, false);
  assert.equal(app.state.notes[0].title, 'After');

  resolveSave({ id: 'note', title: 'After' });
  await drain();
  assert.equal(app.state.notes[0].title, 'After');
});

test('editor save failure still reports error and refreshes notes', async () => {
  const app = owner([{ id: 'note', title: 'Before' }]), errors = [];
  let rejectSave, refreshes = 0;
  const workflows = createNotesWorkflows({
    app,
    api: { saveNote: () => new Promise((_resolve, reject) => { rejectSave = reject; }) },
    effects: {},
  });
  const submission = createNotesSubmission({
    app,
    persistence: {
      _loadFiredReminders: () => new Set(), _saveFiredReminders() {},
      _loadGlowedReminders: () => new Set(), _saveGlowedReminders() {},
      _loadDraft: () => null, _clearDraft() {},
    },
    clock: { now: () => 0 }, uid: () => 'new',
    api: { saveNote: () => assert.fail('submission must use guarded save') },
    saveNote: workflows._saveNote,
    effects: { render() {}, showError: error => errors.push(error), clearGlow() {} },
    fetchNotes: async () => { refreshes++; },
  });
  submission.submitNote({ id: 'note', title: 'After' }, app.state.notes[0], true);
  rejectSave(Error('offline'));
  await drain();
  assert.deepEqual(errors, ['Save failed: offline']);
  assert.equal(refreshes, 1);
  assert.equal(workflows.getDataRevision(), 2);
});

test('archive patch invalidates an older list response', async () => {
  const app = owner([{ id: 'note', title: 'Before', archived: false }]);
  let resolveList, resolvePatch;
  const workflows = createNotesWorkflows({
    app,
    api: {
      listNotes: () => new Promise(resolve => { resolveList = resolve; }),
      patchNote: () => new Promise(resolve => { resolvePatch = resolve; }),
    },
    effects: { render() {}, archived() {}, showError() {} },
  });
  const refresh = workflows._fetchNotes();
  workflows._archiveNoteById('note');
  resolveList({ ok: true, json: async () => ({ notes: [{ id: 'note', title: 'Before', archived: false }] }) });
  assert.equal(await refresh, false);
  assert.deepEqual(app.state.notes, []);
  resolvePatch({ id: 'note', archived: true });
  await drain();
});

test('selection can exit only after synchronous acceptance', () => {
  const app = owner([]), order = [];
  app.selectId('a');
  let accepted = false;
  const operations = createSelectionOperations({ app, sendContext: detail => { order.push('dispatch'); detail.accepted = accepted; }, exitSelection: () => order.push('exit'), effects: { showToast: () => order.push('rejected') } });
  operations.attachSelected();
  assert.deepEqual(order, ['dispatch', 'rejected']);
  accepted = true; operations.attachSelected();
  assert.deepEqual(order, ['dispatch', 'rejected', 'dispatch', 'exit']);
});

test('listener owners release on replacement and disposal is idempotent', () => {
  const previous = { document: globalThis.document, MutationObserver: globalThis.MutationObserver };
  let check, disconnected = 0;
  globalThis.document = { body: {} };
  globalThis.MutationObserver = class { constructor(callback) { check = callback; } observe() {} disconnect() { disconnected++; } };
  try {
    const lifecycle = createNotesLifecycle(), target = new EventTarget(), canvas = { isConnected: true };
    let calls = 0;
    lifecycle.listen(canvas, target, 'mouseup', () => calls++);
    let released = 0;
    lifecycle.onDispose(canvas, () => released++);
    target.dispatchEvent(new Event('mouseup'));
    canvas.isConnected = false; check();
    target.dispatchEvent(new Event('mouseup'));
    lifecycle.dispose(); lifecycle.dispose();
    assert.equal(calls, 1); assert.equal(disconnected, 1);
    assert.equal(released, 1);
  } finally {
    for (const [name, value] of Object.entries(previous)) if (value === undefined) delete globalThis[name]; else globalThis[name] = value;
  }
});

test('render helpers reject script-capable media and escape URL attributes', () => {
  const helpers = createText({ uiModule: { esc: value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;') } });
  for (const value of ['javascript:alert(1)', 'data:image/svg+xml;base64,abc', 'data:text/html;base64,abc']) assert.equal(helpers._safeImgSrc(value), '');
  assert.equal(helpers._safeImgSrc('data:image/png;base64,abc'), 'data:image/png;base64,abc');
  assert.equal(helpers._attrEsc('"\'<>`'), '&quot;&#39;&lt;&gt;&#96;');
  assert.match(helpers._linkify('<script> https://example.org/test'), /&lt;script&gt;/);
  assert.doesNotMatch(helpers._linkify('<script> https://example.org/test'), /<script>/i);
});

test('failed and stale note loads preserve the last good list', async () => {
  const app = owner([{ id: 'kept', title: 'Existing' }]);
  const responses = [];
  const workflows = createNotesWorkflows({ app, api: { listNotes: () => new Promise(resolve => responses.push(resolve)) }, effects: {} });
  const failed = workflows._fetchNotes();
  responses.shift()({ ok: false });
  assert.equal(await failed, false);
  assert.deepEqual(app.state.notes.map(note => note.id), ['kept']);
  assert.equal(app.state.notesLoadFailed, true);

  const stale = workflows._fetchNotes();
  const newer = workflows._fetchNotes();
  const [resolveStale, resolveNew] = responses;
  resolveNew({ ok: true, json: async () => ({ notes: [{ id: 'new' }] }) });
  assert.equal(await newer, true);
  resolveStale({ ok: true, json: async () => ({ notes: [{ id: 'stale' }] }) });
  assert.equal(await stale, false);
  assert.deepEqual(app.state.notes.map(note => note.id), ['new']);
  assert.equal(app.state.notesLoadFailed, false);
});

test('archive view reminder checks use the active-note snapshot', () => {
  const app = owner([{ id: 'archived-view', archived: true, due_date: '2026-10-16T11:00:00Z' }]);
  app.setShowingArchived(true);
  app.replaceActiveReminderNotes([{ id: 'active', due_date: '2026-10-16T11:00:00Z' }]);
  const reminders = createNotesReminders({
    app, api: { patchNote: async () => ({}), listNotes: async () => ({ ok: false }) },
    persistence: { _loadFiredReminders: () => new Set(), _saveFiredReminders() {}, setItem() {} },
    notifications: { show() {}, ensurePermission() {} }, clock: { now: () => Date.parse('2026-10-16T12:00:00Z') },
    scheduler: { setInterval() {}, clearInterval() {}, setTimeout() {}, clearTimeout() {} },
    effects: { badge() {}, highlight() {} }, fetchNotes: async () => {}, isNoteFullyDone: () => false, hasItems: () => false, dismissedKey: 'dismissed',
  });
  assert.equal(reminders._countDueReminders(), 1);
  assert.deepEqual(app.state.notes.map(note => note.id), ['archived-view']);
});
