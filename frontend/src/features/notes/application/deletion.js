/** Confirmed deletion and past-reminder clearing workflows. */
const httpStatus = error => Number.isInteger(error?.status) && error.status >= 100 && error.status <= 599 ? error.status : null;

export function createDeletion({
  app,
  _deleteNoteApi,
  _fetchNotes,
  _isPastReminder,
  _renderNotes,
  effects,
  state
}) {
  async function _deleteNote(id) {
    const ok = effects.styledConfirm
      ? await effects.styledConfirm('Delete this note?', { confirmText: 'Delete', danger: true })
      : effects.confirm('Delete this note?');
    if (!ok) return;
    try { await _deleteNoteApi(id); await _fetchNotes(); _renderNotes(); effects.showToast('Deleted'); }
    catch (err) { effects.showError(err.message); }
  }

  async function _clearPastReminders() {
    const targets = state.notes.filter(n => !n.archived && _isPastReminder(n));
    if (!targets.length) {
      effects.showToast?.('No past reminders to clear');
      return;
    }
    const ok = effects.styledConfirm
      ? await effects.styledConfirm(`Delete ${targets.length} past reminder${targets.length === 1 ? '' : 's'}?`, { confirmText: 'Delete', danger: true })
      : effects.confirm(`Delete ${targets.length} past reminder${targets.length === 1 ? '' : 's'}?`);
    if (!ok) return;
    let firstHttpStatus = null;
    const results = await Promise.all(targets.map(async note => {
      try { await _deleteNoteApi(note.id); return { id: note.id, ok: true }; }
      catch (error) {
        const status = httpStatus(error);
        if (firstHttpStatus === null && status !== null) firstHttpStatus = status;
        return { id: note.id, ok: false };
      }
    }));
    const deleted = results.filter(result => result.ok);
    const failed = results.filter(result => !result.ok);
    const refreshed = await _fetchNotes();
    _renderNotes();
    const cleared = `Cleared ${deleted.length} past reminder${deleted.length === 1 ? '' : 's'}`;
    const status = firstHttpStatus === null ? '' : ` First HTTP error: HTTP ${firstHttpStatus}.`;
    if (failed.length) {
      const completed = deleted.length ? `${cleared}; ` : '';
      const refresh = refreshed ? '' : ' The Notes list also could not refresh.';
      effects.showError(`${completed}Could not confirm deletion of ${failed.length} past reminder${failed.length === 1 ? '' : 's'}. Check Notes before retrying.${status}${refresh}`);
    } else if (!refreshed) {
      effects.showError(`${cleared}, but the Notes list could not refresh. Check Notes before retrying.`);
    } else if (deleted.length) {
      effects.showToast?.(cleared);
    }
  }

  async function deleteFromEditor(id) {
    const ok = effects.styledConfirm
      ? await effects.styledConfirm('Delete this note?', { confirmText: 'Delete', danger: true })
      : effects.confirm('Delete this note?');
    if (!ok) return;
    const index = state.notes.findIndex(note => note.id === id);
    if (index >= 0) app.removeNoteAt(index);
    app.setEditingId(null);
    _renderNotes();
    _deleteNoteApi(id).then(() => effects.showToast('Deleted')).catch(error => {
      const status = httpStatus(error);
      effects.showError(`Failed to delete${status === null ? '' : ` (HTTP ${status})`}`);
      _fetchNotes().then(() => _renderNotes());
    });
  }
  return { _deleteNote, _clearPastReminders, deleteFromEditor };
}
