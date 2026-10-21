import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
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
import { createNotesDrafts } from '../frontend/src/features/notes/application/drafts.js';
import { createNotesApi } from '../frontend/src/features/notes/infrastructure/http.js';

const drain = () => new Promise(setImmediate);
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
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

test('save and card update show safe HTTP status for synthetic failures', async t => {
  const requests = [];
  let nextStatus = 200;
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      requests.push({ method: req.method, path: req.url, status: nextStatus });
      res.writeHead(nextStatus, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(nextStatus === 200 ? { id: 'saved-note' } : { detail: 'PRIVATE SYNTHETIC RESPONSE BODY' }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  assert.match(origin, /^http:\/\/127\.0\.0\.1:/);
  const api = createNotesApi({ origin, request: (...args) => fetch(...args) });

  async function submitAt(status) {
    nextStatus = status;
    const errors = [];
    const app = {
      state: { notes: [] },
      setEditingId() {},
      prependNote(note) { this.state.notes.unshift(note); },
      mergeNote(note, saved) { Object.assign(note, saved); },
    };
    const submission = createNotesSubmission({
      app, api, clock: { now: () => 0 }, uid: () => 'synthetic',
      persistence: { _loadDraft: () => null, _clearDraft() {} },
      effects: { render() {}, showError: message => errors.push(message), clearGlow() {} },
      fetchNotes: async () => true,
    });
    submission.submitNote({ title: 'Synthetic note' }, null, false);
    const deadline = Date.now() + 2000;
    while ((status === 200 ? app.state.notes[0]?.id !== 'saved-note' : !errors.length) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    if (status === 200) assert.equal(app.state.notes[0]?.id, 'saved-note');
    return errors;
  }
  async function updateColorAt(status) {
    nextStatus = status;
    const errors = [];
    const note = { id: 'patch-note', color: null };
    const app = { state: { notes: [note] }, mergeNote(target, patch) { Object.assign(target, patch); } };
    const operations = createCardOperations({ app, api, effects: { showError: message => errors.push(message) }, pushUndo() {}, undoArchive() {} });
    await operations.updateColor(note.id, '#abc');
    if (status === 200) assert.equal(note.color, '#abc');
    return errors;
  }

  assert.deepEqual(await submitAt(403), ['Save failed: Failed to save note (HTTP 403)']);
  assert.deepEqual(await submitAt(503), ['Save failed: Failed to save note (HTTP 503)']);
  assert.deepEqual(await submitAt(200), []);
  assert.deepEqual(await updateColorAt(403), ['Failed to update color (HTTP 403)']);
  assert.deepEqual(await updateColorAt(503), ['Failed to update color (HTTP 503)']);
  assert.deepEqual(await updateColorAt(200), []);
  nextStatus = 403;
  await assert.rejects(api.deleteNote('delete-note'), error => error.message === 'HTTP 403' && error.status === 403);
  assert.equal(requests.length, 7);
  assert.deepEqual(requests.map(({ method, status }) => [method, status]), [
    ['POST', 403], ['POST', 503], ['POST', 200], ['PUT', 403], ['PUT', 503], ['PUT', 200], ['DELETE', 403],
  ]);
  assert.equal(JSON.stringify(requests).includes('PRIVATE SYNTHETIC RESPONSE BODY'), false);
});

test('missing or invalid HTTP status leaves existing Notes messages unchanged', async () => {
  const api = createNotesApi({ origin: '', request: async () => ({ ok: false, status: '403' }) });
  await assert.rejects(api.saveNote({}), error => error.message === 'Failed to save note' && error.status === undefined);
  await assert.rejects(api.patchNote('n', {}), error => error.message === 'Failed to update note' && error.status === undefined);

  const withStatus = (message, status) => {
    const error = new Error(message);
    if (status !== undefined) error.status = status;
    return error;
  };
  const submissionErrors = [];
  const submitApp = { state: { notes: [] }, setEditingId() {}, prependNote(note) { this.state.notes.unshift(note); } };
  const submission = createNotesSubmission({ app: submitApp, api: {},
    saveNote: () => Promise.reject(withStatus('Failed to save note', '403')),
    clock: { now: () => 0 }, uid: () => 'tmp', persistence: { _loadDraft: () => null, _clearDraft() {} },
    effects: { render() {}, showError: error => submissionErrors.push(error), clearGlow() {} }, fetchNotes: async () => true });
  submission.submitNote({ title: 'Synthetic' }, null, false);
  await drain();
  assert.deepEqual(submissionErrors, ['Save failed: Failed to save note']);

  const cardErrors = [];
  const note = { id: 'n', color: null };
  const card = createCardOperations({ app: { state: { notes: [note] }, mergeNote(target, patch) { Object.assign(target, patch); } },
    api: { patchNote: () => Promise.reject(withStatus('Failed to update note', 600)) },
    effects: { showError: error => cardErrors.push(error) }, pushUndo() {}, undoArchive() {} });
  await card.updateColor('n', '#abc');
  assert.deepEqual(cardErrors, ['Failed to update color']);

  const checklistErrors = [];
  const checklist = owner([{ id: 'n', items: [{ text: 'item', done: false }] }]);
  createChecklistOperations({ app: checklist, api: { patchNote: () => Promise.reject(withStatus('Failed to update note', '403')) },
    effects: { render() {}, showError: error => checklistErrors.push(error) }, uid: () => 'item' }).removeItem('n', 0);
  await drain();
  assert.deepEqual(checklistErrors, ['Failed to remove item']);

  const workflowErrors = [];
  const workflowApp = owner([{ id: 'n' }]);
  const workflows = createNotesWorkflows({ app: workflowApp,
    api: { patchNote: () => Promise.reject(withStatus('Failed to update note', undefined)) },
    effects: { render() {}, showError: error => workflowErrors.push(error), archived() {} } });
  workflows._archiveNoteById('n');
  await drain();
  assert.deepEqual(workflowErrors, ['Failed to archive']);

  const draftErrors = [];
  const callbacks = [];
  const draft = createNotesDrafts({ app: owner([{ id: 'n' }]),
    api: { patchNote: () => Promise.reject(withStatus('Failed to update note', '503')) },
    persistence: { _draftKey: id => id, _clearDraft() {}, setItem() {}, getItem: () => null },
    scheduler: { setTimeout(callback) { callbacks.push(callback); return 1; }, clearTimeout() {} },
    effects: { showError: error => draftErrors.push(error) } });
  draft.bindDraft({ collect: () => ({ title: 'Synthetic', label: 'Synthetic', note_type: 'text' }), id: 'n', view: {} }).schedule();
  await callbacks[0]();
  assert.deepEqual(draftErrors, ['Note not synced. Your edits are kept on this device; retry Save.']);

  const deletionErrors = [];
  const deleteApp = owner([{ id: 'n' }]);
  const deletion = createDeletion({ app: deleteApp, state: deleteApp.state,
    _deleteNoteApi: () => Promise.reject(withStatus('HTTP 403', 99)), _fetchNotes: async () => true,
    _isPastReminder: () => false, _renderNotes() {}, effects: { styledConfirm: async () => true, showToast() {}, showError: error => deletionErrors.push(error) } });
  await deletion.deleteFromEditor('n');
  await drain();
  assert.deepEqual(deletionErrors, ['Failed to delete']);

  const batchErrors = [];
  const batchApp = owner([{ id: 'n' }]);
  batchApp.setSelectMode(true); batchApp.selectId('n');
  const selection = createSelectionOperations({ app: batchApp, api: { deleteNote: () => Promise.reject(withStatus('HTTP 403', '403')) },
    effects: { render() {}, showError: error => batchErrors.push(error) }, sendContext() {},
    exitSelection: () => { batchApp.setSelectMode(false); batchApp.clearSelection(); }, fetchNotes: async () => true });
  await selection.deleteSelected();
  assert.deepEqual(batchErrors, ['Could not confirm 1 note delete operation. Check Notes before retrying.']);
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
    api: { patchNote: async id => { if (id === 'a') { const error = Error('Failed to update note'); error.status = 403; throw error; } } },
    effects: { render: () => events.push('render'), showToast: text => events.push(`toast:${text}`), showError: text => events.push(`error:${text}`) },
    sendContext() {},
    exitSelection: () => { app.setSelectMode(false); app.clearSelection(); events.push('exit'); },
    fetchNotes: async () => { app.replaceNotes([{ id: 'a' }]); return true; },
  });
  await operations.archiveSelected();
  assert.deepEqual([...app.state.selectedIds], ['a']);
  assert.equal(app.state.selectMode, true);
  assert.equal(events.some(event => event.startsWith('error:') && /archived 1; could not confirm 1 note archive operation/i.test(event)), true);
  assert.equal(events.some(event => event.includes('First HTTP error: HTTP 403.')), true);
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
    _deleteNoteApi: async id => { if (id === 'failed') { const error = Error('HTTP 503'); error.status = 503; throw error; } },
    _fetchNotes: async () => false,
    _isPastReminder: () => true,
    _renderNotes: () => events.push('render'),
    effects: { styledConfirm: async () => true, showToast: text => events.push(`toast:${text}`), showError: text => events.push(`error:${text}`) },
  });
  await deletion._clearPastReminders();
  assert.equal(events.includes('render'), true);
  assert.equal(events.some(event => event.startsWith('error:') && /Cleared 1 past reminder; Could not confirm deletion of 1 past reminder\. Check Notes before retrying\. First HTTP error: HTTP 503\. The Notes list also could not refresh\./i.test(event)), true);
  assert.equal(events.some(event => event.includes('First HTTP error: HTTP 503.')), true);
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

function pinHarness(notes = [{ id: 'a', title: 'Original', content: 'Keep me', pinned: false, sort_order: 4 }], getNote = async id => ({ id, pinned: false, sort_order: 4 })) {
  const app = owner(notes), patches = [], reads = [], errors = [];
  const api = {
    patchNote(id, patch) { const request = deferred(); patches.push({ id, patch, ...request }); return request.promise; },
    getNote(id, options) { const request = getNote(id, options); reads.push({ id, options, request }); return request; },
  };
  const operations = createCardOperations({ app, api, effects: { render() {}, showError: message => errors.push(message) } });
  return { app, patches, reads, errors, operations };
}

test('overlapping pin failures reconcile the note in either settlement order', async t => {
  for (const order of [[0, 1], [1, 0]]) await t.test(`settlement ${order.join('-')}`, async () => {
    const h = pinHarness(undefined, async id => ({ id, pinned: false, sort_order: 7, title: 'Ignored server title', content: 'Ignored server content' }));
    h.operations.togglePin('a'); h.operations.togglePin('a');
    assert.deepEqual(h.patches.map(call => call.patch.pinned), [true, false]);
    for (const index of order) h.patches[index].reject(Object.assign(new Error('private body'), { status: 503 }));
    await drain(); await drain();
    assert.equal(h.reads.length, 1);
    assert.equal(h.app.state.notes[0].pinned, false);
    assert.equal(h.app.state.notes[0].sort_order, 7);
    assert.equal(h.app.state.notes[0].title, 'Original');
    assert.equal(h.app.state.notes[0].content, 'Keep me');
    assert.deepEqual(h.errors, ['Failed to pin (HTTP 503)']);
    assert.equal(h.errors.join(' ').includes('private body'), false);
  });
});

test('older pin failure after a newer success reconciles only pin fields', async () => {
  const h = pinHarness(undefined, async id => ({ id, pinned: true, sort_order: -12, title: 'Ignored' }));
  h.operations.togglePin('a'); h.operations.togglePin('a'); h.operations.togglePin('a');
  h.patches[1].resolve(); h.patches[2].resolve(); h.patches[0].reject(new Error('offline'));
  await drain(); await drain();
  assert.equal(h.reads.length, 1);
  assert.equal(h.app.state.notes[0].pinned, true);
  assert.equal(h.app.state.notes[0].sort_order, -12);
  assert.equal(h.app.state.notes[0].title, 'Original');
  assert.deepEqual(h.errors, ['Failed to pin']);
});

test('latest overlapping pin failure reconciles after an older success', async () => {
  const h = pinHarness(undefined, async id => ({ id, pinned: true, sort_order: 2 }));
  h.operations.togglePin('a'); h.operations.togglePin('a');
  h.patches[0].resolve(); h.patches[1].reject(new Error('offline'));
  await drain(); await drain();
  assert.equal(h.app.state.notes[0].pinned, true);
  assert.equal(h.app.state.notes[0].sort_order, 2);
  assert.equal(h.reads.length, 1);
});

test('pin requests on another note do not overlap or roll back each other', async () => {
  const h = pinHarness([{ id: 'a', pinned: false, sort_order: 1 }, { id: 'b', pinned: false, sort_order: 2 }]);
  h.operations.togglePin('a'); h.operations.togglePin('b');
  h.patches[0].reject(new Error('offline')); h.patches[1].resolve();
  await drain();
  assert.equal(h.app.state.notes[0].pinned, false);
  assert.equal(h.app.state.notes[1].pinned, true);
  assert.equal(h.reads.length, 0);
  assert.deepEqual(h.errors, ['Failed to pin']);
});

test('pin reconciliation ignores replaced note identity and a newer toggle', async t => {
  await t.test('replaced same-id note', async () => {
    const held = deferred(), h = pinHarness(undefined, () => held.promise);
    h.operations.togglePin('a'); h.operations.togglePin('a');
    h.patches[0].reject(new Error('offline')); h.patches[1].reject(new Error('offline'));
    await drain();
    h.app.replaceNotes([{ id: 'a', title: 'Replacement', pinned: true, sort_order: 99 }]);
    held.resolve({ id: 'a', pinned: false, sort_order: 0 });
    await drain(); await drain();
    assert.equal(h.app.state.notes[0].title, 'Replacement');
    assert.equal(h.app.state.notes[0].pinned, true);
    assert.deepEqual(h.errors, []);
  });
  await t.test('removed note identity', async () => {
    const held = deferred(), h = pinHarness(undefined, () => held.promise);
    h.operations.togglePin('a'); h.operations.togglePin('a');
    h.patches[0].reject(new Error('offline')); h.patches[1].reject(new Error('offline'));
    await drain();
    h.app.replaceNotes([]);
    held.resolve({ id: 'a', pinned: false, sort_order: 4 });
    await drain(); await drain();
    assert.equal(h.app.state.notes.length, 0);
    assert.deepEqual(h.errors, []);
  });
  await t.test('newer toggle supersedes held read', async () => {
    const held = deferred(), h = pinHarness(undefined, () => held.promise);
    h.operations.togglePin('a'); h.operations.togglePin('a');
    h.patches[0].reject(new Error('offline')); h.patches[1].reject(new Error('offline'));
    await drain();
    h.operations.togglePin('a');
    h.patches[2].resolve();
    held.resolve({ id: 'a', pinned: false, sort_order: 4 });
    await drain(); await drain();
    assert.equal(h.app.state.notes[0].pinned, true);
    assert.equal(h.app.state.notes[0].sort_order, -1);
    assert.deepEqual(h.errors, []);
  });
});

test('invalid or unavailable pin reconciliation keeps current UI and gives safe refresh guidance', async t => {
  for (const [label, response] of [
    ['wrong id', id => ({ id: `${id}-other`, pinned: false, sort_order: 4 })],
    ['nonboolean pin', id => ({ id, pinned: 'false', sort_order: 4 })],
    ['invalid sort order', id => ({ id, pinned: false, sort_order: '4' })],
  ]) await t.test(`malformed response: ${label}`, async () => {
    const h = pinHarness(undefined, async id => response(id));
    h.operations.togglePin('a'); h.operations.togglePin('a');
    h.patches[0].reject(Object.assign(new Error('secret'), { status: 503 })); h.patches[1].reject(Object.assign(new Error('secret'), { status: 503 }));
    await drain(); await drain();
    assert.equal(h.app.state.notes[0].pinned, false);
    assert.equal(h.app.state.notes[0].sort_order, -1);
    assert.deepEqual(h.errors, ['Could not confirm pin state. Refresh Notes before retrying. (HTTP 503)']);
  });
  await t.test('request failure', async () => {
    const h = pinHarness(undefined, async () => { throw Object.assign(new Error('PRIVATE GET BODY'), { status: 503 }); });
    h.operations.togglePin('a'); h.operations.togglePin('a');
    h.patches[0].reject(new Error('offline')); h.patches[1].reject(new Error('offline'));
    await drain(); await drain();
    assert.equal(h.app.state.notes[0].pinned, false);
    assert.deepEqual(h.errors, ['Could not confirm pin state. Refresh Notes before retrying. (HTTP 503)']);
    assert.equal(h.errors.join(' ').includes('PRIVATE GET BODY'), false);
  });
  await t.test('timeout aborts GET', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let aborted = false;
    const h = pinHarness(undefined, (_id, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }, { once: true })));
    h.operations.togglePin('a'); h.operations.togglePin('a');
    h.patches[0].reject(new Error('offline')); h.patches[1].reject(new Error('offline'));
    await drain();
    t.mock.timers.tick(15000);
    await drain(); await drain();
    assert.equal(aborted, true);
    assert.deepEqual(h.errors, ['Could not confirm pin state. Refresh Notes before retrying.']);
  });
  await t.test('successful reconciliation clears its deadline', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const h = pinHarness(undefined, async id => ({ id, pinned: false, sort_order: 4 }));
    h.operations.togglePin('a'); h.operations.togglePin('a');
    h.patches[0].reject(new Error('offline')); h.patches[1].reject(new Error('offline'));
    await drain(); await drain();
    assert.equal(h.reads[0].options.signal.aborted, true);
    t.mock.timers.tick(15000);
    assert.equal(h.reads.length, 1);
    assert.deepEqual(h.errors, ['Failed to pin']);
  });
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
