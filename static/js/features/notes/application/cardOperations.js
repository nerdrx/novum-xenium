/** Optimistic card mutations and rollback. Animation completion is a UI-supplied boundary. */
export function createCardOperations({
  app,
  api,
  effects,
  pushUndo,
  undoArchive
}) {
    const state = app.state;
    const pinStates = new WeakMap();
    const pinRefreshTimeout = 15000;
    const withStatus = (message, error) => Number.isInteger(error?.status) && error.status >= 100 && error.status <= 599
      ? `${message} (HTTP ${error.status})` : message;
    const isCurrentNote = (note, id) => state.notes.find(current => current.id === id) === note;
    async function reconcilePin(note, id, pinState, owner, error) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), pinRefreshTimeout);
      try {
        const latest = await api.getNote(id, { signal: controller.signal });
        if (pinState.latestOwner !== owner || !isCurrentNote(note, id)) return;
        if (!latest || latest.id !== id || typeof latest.pinned !== 'boolean' || !Number.isInteger(latest.sort_order)) throw new Error('Invalid note response');
        // The GET includes unrelated fields; only reconcile pin state after failures.
        app.mergeNote(note, { pinned: latest.pinned, sort_order: latest.sort_order });
        effects.render();
        effects.showError(withStatus('Failed to pin', error));
      } catch (refreshError) {
        if (pinState.latestOwner === owner && isCurrentNote(note, id)) {
          const statusError = Number.isInteger(refreshError?.status) && refreshError.status >= 100 && refreshError.status <= 599 ? refreshError : error;
          effects.showError(withStatus('Could not confirm pin state. Refresh Notes before retrying.', statusError));
        }
      } finally {
        controller.abort();
        clearTimeout(timer);
      }
    }
    function togglePin(id) {
      const note = state.notes.find(n => n.id === id);
      if (!note) return;
      let pinState = pinStates.get(note);
      if (!pinState) {
        pinState = { latestOwner: null, pending: 0, reconciling: 0, overlapped: false, failed: null };
        pinStates.set(note, pinState);
      }
      if (pinState.pending || pinState.reconciling) pinState.overlapped = true;
      const owner = {};
      pinState.latestOwner = owner;
      pinState.pending++;
      const prevPinned = note.pinned, prevSortOrder = note.sort_order;
      app.mergeNote(note, { pinned: !prevPinned });
      const patch = { pinned: note.pinned };
      if (note.pinned) {
        const minPinned = state.notes.filter(n => n.pinned && n.id !== id).reduce((m, n) => Math.min(m, n.sort_order || 0), 0);
        app.mergeNote(note, { sort_order: minPinned - 1 });
        patch.sort_order = note.sort_order;
      }
      effects.render();
      api.patchNote(id, patch).then(() => {
        completePin(note, id, pinState, owner);
      }, error => {
        completePin(note, id, pinState, owner, error, { prevPinned, prevSortOrder });
      });
    }
    function completePin(note, id, pinState, owner, error, previous) {
      if (error) pinState.failed = { error, previous };
      pinState.pending--;
      if (pinState.pending) return;
      if (!isCurrentNote(note, id)) {
        pinState.failed = null;
        pinState.overlapped = false;
        return;
      }
      if (pinState.failed && pinState.overlapped) {
        const failed = pinState.failed.error;
        const latestOwner = pinState.latestOwner;
        pinState.failed = null;
        pinState.overlapped = false;
        pinState.reconciling++;
        void reconcilePin(note, id, pinState, latestOwner, failed).finally(() => {
          pinState.reconciling--;
          if (!pinState.pending && !pinState.reconciling) pinState.overlapped = false;
        });
        return;
      }
      pinState.overlapped = false;
      if (pinState.failed) {
        const { error: failed, previous } = pinState.failed;
        pinState.failed = null;
        if (pinState.latestOwner === owner) {
          app.mergeNote(note, { pinned: previous.prevPinned, sort_order: previous.prevSortOrder });
          effects.render(); effects.showError(withStatus('Failed to pin', failed));
        }
      }
    }
    async function updateColor(id, color) {
      try {
        await api.patchNote(id, { color: color || null });
        const note = state.notes.find(n => n.id === id);
        if (note) app.mergeNote(note, { color });
      } catch (error) { effects.showError(withStatus('Failed to update color', error)); }
    }
    function stageArchive(id) {
      const index = state.notes.findIndex(n => n.id === id);
      if (index < 0) return null;
      const removed = app.removeNoteAt(index);
      const undo = () => undoArchive(removed, index);
      pushUndo({ label: 'archive', run: undo });
      return () => {
        effects.render();
        api.patchNote(id, { archived: true }).then(() => effects.archived(undo)).catch(error => {
          app.insertNoteAt(index, removed); effects.render(); effects.showError(withStatus('Failed to archive', error));
        });
      };
    }
    function unarchive(id) {
      const index = state.notes.findIndex(n => n.id === id);
      if (index < 0) return;
      const removed = app.removeNoteAt(index);
      effects.render();
      api.patchNote(id, { archived: false }).then(() => effects.showToast('Unarchived')).catch(error => {
        app.insertNoteAt(index, removed); effects.render(); effects.showError(withStatus('Failed to unarchive', error));
      });
    }
    function deleteOptimistically(id, toast = false) {
      const index = state.notes.findIndex(n => n.id === id);
      if (index < 0) return;
      const removed = app.removeNoteAt(index);
      effects.render();
      const deletion = api.deleteNote(id);
      const completion = toast ? deletion.then(() => effects.showToast('Deleted')) : deletion;
      completion.catch(error => {
        app.insertNoteAt(index, removed); effects.render(); effects.showError(withStatus('Failed to delete', error));
      });
    }
    // Desktop deliberately persists without updating local sort_order, as before.
    function persistOrder(ids) { return api.reorder(ids); }
    async function commitMobileOrder(ids) {
      try {
        await api.reorder(ids);
        ids.forEach((id, index) => {
          const note = state.notes.find(note => note.id === id);
          if (note) app.mergeNote(note, { sort_order: index });
        });
      } catch (error) { console.warn('reorder failed', error); }
    }
    return { togglePin, updateColor, stageArchive, unarchive, deleteOptimistically, persistOrder, commitMobileOrder };
}
