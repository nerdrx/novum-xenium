/** Selected-note attachment retains synchronous acceptance; bulk requests retain partial-failure behavior. */
export function createSelectionOperations({
  app,
  api,
  effects,
  sendContext,
  exitSelection,
  fetchNotes
}) {
    const state = app.state;
    function attachSelected() {
      const ids = [...state.selectedIds];
      if (!ids.length) return;
      const detail = { noteIds: ids, accepted: false };
      sendContext(detail);
      if (!detail.accepted) {
        effects.showToast('Choose a chat or model before attaching notes');
        return;
      }
      exitSelection();
    }
    async function mutateSelected(ids, mutate, verb, failureAction) {
      let firstHttpStatus = null;
      const results = await Promise.all(ids.map(async id => {
        try { await mutate(id); return { id, ok: true }; }
        catch (error) {
          const status = Number.isInteger(error?.status) && error.status >= 100 && error.status <= 599 ? error.status : null;
          if (firstHttpStatus === null && status !== null) firstHttpStatus = status;
          return { id, ok: false };
        }
      }));
      const succeeded = results.filter(result => result.ok);
      const failed = results.filter(result => !result.ok);
      for (const { id } of succeeded) app.deselectId(id);
      const refreshed = await fetchNotes();
      if (state.selectMode && !state.selectedIds.size) exitSelection();
      else effects.render();
      const status = firstHttpStatus === null ? '' : ` First HTTP error: HTTP ${firstHttpStatus}.`;
      if (failed.length) {
        const completed = succeeded.length ? `${verb} ${succeeded.length}; ` : '';
        const refresh = refreshed ? '' : ' The Notes list also could not refresh.';
        effects.showError(`${completed}Could not confirm ${failed.length} note ${failureAction} operation${failed.length === 1 ? '' : 's'}. Check Notes before retrying.${status}${refresh}`);
      } else if (!refreshed) {
        effects.showError(`${verb} ${succeeded.length}, but the Notes list could not refresh. Check Notes before retrying.`);
      } else if (succeeded.length) {
        effects.showToast(`${verb} ${succeeded.length}`);
      }
    }
    async function archiveSelected() {
      const ids = [...state.selectedIds];
      if (!ids.length) return;
      await mutateSelected(ids, id => api.patchNote(id, { archived: true }), 'Archived', 'archive');
    }
    async function deleteSelected() {
      const ids = [...state.selectedIds];
      if (!ids.length) return;
      if (effects.styledConfirm) {
        const ok = await effects.styledConfirm(`Delete ${ids.length} note${ids.length === 1 ? '' : 's'}?`, { confirmText: 'Delete', danger: true });
        if (!ok) return;
      }
      await mutateSelected(ids, id => api.deleteNote(id), 'Deleted', 'delete');
    }
    return { attachSelected, archiveSelected, deleteSelected };
}
