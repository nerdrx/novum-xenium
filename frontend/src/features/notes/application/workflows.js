/** Notes CRUD, optimistic archive and in-memory undo workflows. */
export function createNotesWorkflows({
  app,
  api,
  effects
}) {
  const state = app.state;
  const _undoStack = [];
  const _renderNotes = effects.render;
  const patchNote = _patchNote;
  const uiModule = effects;
  const withStatus = (message, error) => Number.isInteger(error?.status) && error.status >= 100 && error.status <= 599
    ? `${message} (HTTP ${error.status})` : message;
  let fetchSequence = 0;
  let dataRevision = 0;
  let activeReminderNotes = null;
  function syncActiveReminderNote(note) {
    if (!activeReminderNotes || !note?.id) return;
    const index = activeReminderNotes.findIndex(item => item.id === note.id);
    if (note.archived === true) {
      if (index >= 0) activeReminderNotes.splice(index, 1);
    } else if (index >= 0) Object.assign(activeReminderNotes[index], note);
    else activeReminderNotes.push(note);
  }
  function removeActiveReminderNote(id) {
    if (!activeReminderNotes || !id) return;
    const index = activeReminderNotes.findIndex(note => note.id === id);
    if (index >= 0) activeReminderNotes.splice(index, 1);
  }
  function _pushUndo(entry) {
    _undoStack.push(entry);
    if (_undoStack.length > 20) _undoStack.shift();
  }

  function _popAndRunUndo() {
    const entry = _undoStack.pop();
    if (entry) entry.run();
    return !!entry;
  }

  function _undoArchive(note, prevIdx) {
    // Re-insert at original position and clear archived flag on the server.
    const safeIdx = Math.min(Math.max(prevIdx, 0), state.notes.length);
    app.insertNoteAt(safeIdx, { ...note, archived: false });
    _renderNotes();
    patchNote(note.id, { archived: false }).catch(error => {
      // Roll back local insertion if the server refuses
      const i = state.notes.findIndex(n => n.id === note.id);
      if (i >= 0) app.removeNoteAt(i);
      _renderNotes();
      uiModule.showError(withStatus('Undo failed', error));
    });
  }

  function _archiveNoteById(id, { card = null, celebrate = false } = {}) {
    if (!id) return false;
    const idx = state.notes.findIndex(n => n.id === id);
    if (idx < 0) return false;
    const note = state.notes[idx];
    if (celebrate && card && note) effects.celebrateArchive(note, card);
    const removed = app.removeNoteAt(idx);
    app.setEditingId(null);
    _renderNotes();
    const undo = () => _undoArchive(removed, idx);
    _pushUndo({ label: 'archive', run: undo });
    patchNote(id, { archived: true }).then(() => {
      effects.archived(undo);
    }).catch(error => {
      app.insertNoteAt(idx, removed);
      _renderNotes();
      uiModule.showError(withStatus('Failed to archive', error));
    });
    return true;
  }

  async function _fetchNotes() {
    const sequence = ++fetchSequence;
    const revision = dataRevision;
    app.setLoading(true);
    try {
      const res = await api.listNotes(state.showingArchived);
      if (!res.ok) {
        if (sequence === fetchSequence && revision === dataRevision) app.setNotesLoadFailed(true);
        return false;
      }
      const data = await res.json();
      const notes = data?.notes ?? data;
      if (sequence !== fetchSequence || revision !== dataRevision || !Array.isArray(notes)) return false;
      app.replaceNotes(notes);
      if (!state.showingArchived) {
        activeReminderNotes = notes;
        app.replaceActiveReminderNotes(notes);
      }
      app.setNotesLoadFailed(false);
      return true;
    } catch (e) {
      console.error('Failed to fetch notes:', e);
      if (sequence === fetchSequence && revision === dataRevision) app.setNotesLoadFailed(true);
      return false;
    } finally {
      if (sequence === fetchSequence) app.setLoading(false);
    }
  }

  async function _saveNote(note) {
    dataRevision++;
    try {
      const saved = await api.saveNote(note);
      syncActiveReminderNote(saved);
      return saved;
    } finally { dataRevision++; }
  }

  async function _deleteNoteApi(id) {
    dataRevision++;
    try { await api.deleteNote(id); removeActiveReminderNote(id); }
    finally { dataRevision++; }
  }

  async function _patchNote(id, patch) {
    dataRevision++;
    try {
      const updated = await api.patchNote(id, patch);
      syncActiveReminderNote(updated);
      return updated;
    } finally { dataRevision++; }
  }

  return { _pushUndo, _popAndRunUndo, _undoArchive, _archiveNoteById, _fetchNotes, _saveNote, _deleteNoteApi, _patchNote, getDataRevision: () => dataRevision, undoCount: () => _undoStack.length };
}
