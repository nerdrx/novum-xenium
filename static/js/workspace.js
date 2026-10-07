// static/js/workspace.js
//
// Workspace picker: browse server directories in a draggable modal, choose a
// folder, and show it as a removable pill in the chat input bar. While set, the
// chat request sends `workspace` so the agent's file/shell tools are confined
// to that folder (see routes/chat_routes.py + src/tool_execution.py).

import Storage, { KEYS } from './storage.js';
import uiModule from './ui.js';
import { makeWindowDraggable } from './windowDrag.js';

const API_BASE = window.location.origin;
// Same folder glyph as the overflow menu item + pill (not an emoji).
const _FOLDER_SVG = '<svg class="workspace-row-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
let _modal = null;
let _curPath = '';
let _snapshotPreview = null;
let _browseController = null;
let _snapshotListVersion = 0;
let _snapshotLoading = false;
let _snapshotBusy = '';
let _snapshotViewVersion = 0;
let _opener = null;

export function getWorkspace() {
  // This local Docker installation mounts the persistent files folder here.
  return Storage.get(KEYS.WORKSPACE, '/workspace') || '';
}

function _basename(p) {
  if (!p) return '';
  // Handle both POSIX (/) and Windows (\) separators.
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

// Workspace only applies to agent mode (it scopes the file/shell tools), so the
// pill + overflow entry are hidden in chat mode, like the bash toggle.
function _isChatMode() {
  const b = document.getElementById('mode-chat-btn');
  return !!(b && b.classList.contains('active'));
}

export function syncWorkspaceIndicator(path) {
  const chat = _isChatMode();
  const pill = document.getElementById('workspace-indicator-btn');
  const name = document.getElementById('workspace-indicator-name');
  const overflow = document.getElementById('overflow-workspace-btn');
  if (pill) {
    pill.style.display = (path && !chat) ? '' : 'none';
    pill.classList.toggle('active', !!path);
    if (path) pill.title = `Workspace: ${path}\nFile tools are confined here; shell commands start here but are not sandboxed and can reach outside it.\nClick to clear.`;
  }
  if (name) name.textContent = path ? _basename(path) : '';
  if (overflow) {
    overflow.style.display = chat ? 'none' : '';
    overflow.classList.toggle('active', !!path);
  }
  // Recompute the "+" overflow dot (app.js owns updatePlusDot via this event).
  try { document.dispatchEvent(new CustomEvent('overflow-state-change')); } catch (_) {}
}

// Called by the agent/chat mode toggle so the pill + overflow entry follow mode.
export function applyMode(_mode) {
  syncWorkspaceIndicator(getWorkspace());
}

export function setWorkspace(path) {
  // Save an explicit empty choice so clearing does not restore the default.
  Storage.set(KEYS.WORKSPACE, path || '');
  syncWorkspaceIndicator(path || '');
}

/**
 * Validate a manually entered path server-side, then persist the canonical
 * form. Returns {ok, path|null}. Without this, a typo / file path / deleted
 * folder / filesystem root would be stored and shown as active while the
 * backend silently refuses to bind it on every send.
 */
export async function vetAndSetWorkspace(path) {
  try {
    const res = await fetch(`${API_BASE}/api/workspace/vet?path=${encodeURIComponent(path)}`, { credentials: 'same-origin' });
    if (!res.ok) return { ok: false, path: null };
    const data = await res.json();
    if (data.ok && data.path) {
      setWorkspace(data.path);
      return { ok: true, path: data.path };
    }
    return { ok: false, path: null };
  } catch (e) {
    return { ok: false, path: null };
  }
}

export function clearWorkspace() {
  setWorkspace('');
  if (uiModule && uiModule.showToast) uiModule.showToast('Workspace cleared');
}

async function _load(path, signal) {
  const url = `${API_BASE}/api/workspace/browse${path ? `?path=${encodeURIComponent(path)}` : ''}`;
  const res = await fetch(url, { credentials: 'same-origin', signal });
  if (!res.ok) throw new Error('Could not open this folder. Check the path and access, then retry.');
  return res.json();
}

function _render(data) {
  _curPath = data.path;
  const body = _modal.querySelector('#workspace-body');
  const pathEl = _modal.querySelector('#workspace-cur-path');
  if (pathEl) {
    // Reflect the resolved (realpath) location back into the editable field.
    pathEl.value = data.path;
    pathEl.title = data.path;
  }
  let rows = '';
  if (data.parent) {
    rows += `<button type="button" class="workspace-row workspace-up" data-path="${encodeURIComponent(data.parent)}" aria-label="Open parent folder">↑ ..</button>`;
  }
  for (const d of data.dirs) {
    // Backend supplies the full child path (os.path.join → cross-platform).
    rows += `<button type="button" class="workspace-row" data-path="${encodeURIComponent(d.path)}">${_FOLDER_SVG}<span>${uiModule.esc(d.name)}</span></button>`;
  }
  if (data.truncated) {
    rows += '<div class="workspace-empty">Too many folders to list. Type or paste a path above to jump in.</div>';
  }
  if (!data.dirs.length && !data.parent) rows = '<div class="workspace-empty">No subfolders</div>';
  body.innerHTML = rows || '<div class="workspace-empty">No subfolders</div>';
  body.querySelectorAll('.workspace-row').forEach((row) => {
    row.addEventListener('click', () => _navigate(decodeURIComponent(row.dataset.path)));
  });
  // Filesystem roots (and sensitive dirs) can be browsed through but never
  // bound as the workspace; the backend rejects them too.
  const useBtn = _modal.querySelector('#workspace-use');
  if (useBtn) {
    useBtn.disabled = data.selectable === false;
    useBtn.title = data.selectable === false ? 'This folder cannot be used as a workspace' : '';
  }
}

async function _navigate(path) {
  _browseController?.abort();
  const controller = new AbortController();
  _browseController = controller;
  const body = _modal.querySelector('#workspace-body');
  _modal.querySelector('#workspace-use').disabled = true;
  body.setAttribute('aria-busy', 'true');
  body.textContent = 'Opening folder…';
  try {
    const data = await _load(path, controller.signal);
    if (_browseController !== controller || controller.signal.aborted) return;
    _render(data);
  } catch (e) {
    if (_browseController !== controller || controller.signal.aborted) return;
    body.textContent = 'Could not open this folder. Check the path and access, then retry.';
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'confirm-btn confirm-btn-secondary';
    retry.textContent = 'Retry opening folder';
    retry.addEventListener('click', () => _navigate(path));
    body.appendChild(retry);
  } finally {
    if (_browseController === controller) {
      _browseController = null;
      body.setAttribute('aria-busy', 'false');
    }
  }
}

function _snapshotContext() {
  return { workspace: getWorkspace(), session_id: window.sessionModule?.getCurrentSessionId?.() || '' };
}

function _snapshotViewCurrent(ctx, version) {
  const active = _snapshotContext();
  return version === _snapshotViewVersion && ctx.workspace === active.workspace &&
    ctx.session_id === active.session_id && _modal?.style.display !== 'none';
}

async function _snapshotRequest(url, method = 'GET', body = null) {
  const options = { method, credentials: 'same-origin', headers: {} };
  if (body) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  const res = await fetch(`${API_BASE}${url}`, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || `Snapshot request failed: ${res.status}`);
  return data;
}

function _syncSnapshotControls() {
  if (!_modal) return;
  const ctx = _snapshotContext();
  const select = _modal.querySelector('#workspace-snapshot-select');
  const unavailable = !!(_snapshotBusy || _snapshotLoading || !ctx.workspace || !ctx.session_id);
  select.disabled = unavailable;
  _modal.querySelector('#workspace-snapshot-create').disabled = unavailable;
  _modal.querySelector('#workspace-snapshot-review').disabled = unavailable || !select.value;
  _modal.querySelector('#workspace-snapshot-restore').disabled = unavailable ||
    !_snapshotPreview || !_snapshotPreview.changes.length ||
    _snapshotPreview.snapshot.id !== select.value ||
    _snapshotPreview.workspace !== ctx.workspace || _snapshotPreview.session_id !== ctx.session_id;
  _modal.querySelector('.workspace-snapshots').setAttribute('aria-busy', String(!!(_snapshotBusy || _snapshotLoading)));
  for (const [id, label, pending] of [
    ['create', 'Create snapshot', 'Saving…'], ['review', 'Review changes', 'Reviewing…'], ['restore', 'Restore files', 'Restoring…'],
  ]) _modal.querySelector(`#workspace-snapshot-${id}`).textContent = _snapshotBusy === id ? pending : label;
}

function _clearSnapshotPreview() {
  _snapshotPreview = null;
  _modal?.querySelector('#workspace-snapshot-preview')?.replaceChildren();
  _syncSnapshotControls();
}

async function _refreshSnapshots(preferredId = '') {
  const version = ++_snapshotListVersion;
  const ctx = _snapshotContext();
  const select = _modal?.querySelector('#workspace-snapshot-select');
  const note = _modal?.querySelector('#workspace-snapshot-note');
  if (!select || !ctx.workspace || !ctx.session_id) {
    if (select) select.innerHTML = '<option value="">Select a chat and workspace first</option>';
    if (note) note.textContent = 'Open a chat and choose a workspace to save or restore snapshots.';
    _snapshotLoading = false;
    _syncSnapshotControls();
    return;
  }
  const selected = preferredId || select.value;
  _snapshotLoading = true;
  note.textContent = `Loading snapshots for ${ctx.workspace}…`;
  _syncSnapshotControls();
  const current = () => version === _snapshotListVersion && ctx.workspace === getWorkspace() &&
    ctx.session_id === _snapshotContext().session_id;
  try {
    const data = await _snapshotRequest(`/api/workspace/snapshots?workspace=${encodeURIComponent(ctx.workspace)}&session_id=${encodeURIComponent(ctx.session_id)}`);
    if (!current()) return;
    select.innerHTML = '<option value="">Choose snapshot…</option>' + data.snapshots.map(s =>
      `<option value="${uiModule.esc(s.id)}">${uiModule.esc(new Date(s.created_at).toLocaleString())}${s.label ? ` · ${uiModule.esc(s.label)}` : ''}</option>`
    ).join('');
    if (Array.from(select.options).some(option => option.value === selected)) select.value = selected;
    if (note) note.textContent = `${ctx.workspace} · ${data.snapshots.length ? `${data.snapshots.length} snapshots for this chat` : 'No snapshots yet. Create one before making changes.'}`;
  } catch (e) {
    if (!current()) return;
    select.innerHTML = '<option value="">Snapshots unavailable</option>';
    note.textContent = 'Could not load snapshots. ';
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'confirm-btn confirm-btn-secondary';
    retry.textContent = 'Retry loading snapshots';
    retry.addEventListener('click', () => _refreshSnapshots());
    note.appendChild(retry);
  } finally {
    if (version === _snapshotListVersion) {
      _snapshotLoading = false;
      _syncSnapshotControls();
    }
  }
}

async function _createSnapshot() {
  const ctx = _snapshotContext();
  const version = _snapshotViewVersion;
  if (_snapshotBusy || !ctx.workspace || !ctx.session_id) return;
  _snapshotBusy = 'create';
  _syncSnapshotControls();
  try {
    const saved = await _snapshotRequest('/api/workspace/snapshots', 'POST', { ...ctx, label: 'Manual snapshot' });
    if (!_snapshotViewCurrent(ctx, version)) return;
    _clearSnapshotPreview();
    await _refreshSnapshots(saved.id);
    if (uiModule?.showToast) uiModule.showToast('Workspace snapshot saved');
  } catch (e) { if (uiModule?.showError) uiModule.showError(e.message); }
  finally { _snapshotBusy = ''; _syncSnapshotControls(); }
}

async function _reviewSnapshot() {
  const ctx = _snapshotContext();
  const version = _snapshotViewVersion;
  const id = _modal?.querySelector('#workspace-snapshot-select')?.value;
  if (_snapshotBusy || !ctx.workspace || !ctx.session_id || !id) return;
  _clearSnapshotPreview();
  _snapshotBusy = 'review';
  _syncSnapshotControls();
  try {
    const preview = await _snapshotRequest(`/api/workspace/snapshots/${encodeURIComponent(id)}/preview`, 'POST', ctx);
    if (!_snapshotViewCurrent(ctx, version)) return;
    _snapshotPreview = { ...preview, workspace: ctx.workspace, session_id: ctx.session_id };
    const host = _modal.querySelector('#workspace-snapshot-preview');
    host.replaceChildren();
    if (!preview.changes.length) host.textContent = 'Workspace already matches this snapshot.';
    for (const change of preview.changes) {
      const row = document.createElement('details');
      const summary = document.createElement('summary');
      summary.textContent = `${change.status}: ${change.path}`;
      const pre = document.createElement('pre');
      pre.textContent = change.diff || '[Binary or non-text file]';
      row.append(summary, pre); host.append(row);
    }
  } catch (e) {
    _snapshotPreview = null;
    if (uiModule?.showError) uiModule.showError(e.message);
  }
  finally { _snapshotBusy = ''; _syncSnapshotControls(); }
}

async function _restoreSnapshot() {
  const preview = _snapshotPreview;
  const ctx = _snapshotContext();
  const version = _snapshotViewVersion;
  if (_snapshotBusy) return;
  if (!preview || preview.workspace !== ctx.workspace || preview.session_id !== ctx.session_id ||
      preview.snapshot.id !== _modal.querySelector('#workspace-snapshot-select').value) {
    if (uiModule?.showError) uiModule.showError('Chat or workspace changed; review the snapshot again');
    return;
  }
  if (!window.confirm('Restore the files shown in this review? A recovery snapshot will be saved first.')) return;
  _snapshotBusy = 'restore';
  _syncSnapshotControls();
  try {
    const result = await _snapshotRequest(`/api/workspace/snapshots/${encodeURIComponent(preview.snapshot.id)}/restore`, 'POST', { ...ctx, expected_revision: preview.revision });
    if (!_snapshotViewCurrent(ctx, version)) return;
    _snapshotPreview = null;
    _modal.querySelector('#workspace-snapshot-preview').textContent = `Restored. Rollback snapshot: ${result.rollback_snapshot_id}`;
    _modal.querySelector('#workspace-snapshot-restore').disabled = true;
    await _refreshSnapshots();
    if (uiModule?.showToast) uiModule.showToast('Workspace restored');
  } catch (e) {
    _snapshotPreview = null;
    if (uiModule?.showError) uiModule.showError(e.message);
  }
  finally { _snapshotBusy = ''; _syncSnapshotControls(); }
}

function _getModal() {
  if (_modal) return _modal;
  _modal = document.createElement('div');
  _modal.id = 'workspace-modal';
  _modal.className = 'modal';
  _modal.style.display = 'none';
  _modal.innerHTML = `
    <div class="modal-content" role="dialog" aria-label="Select workspace">
      <div class="modal-header">
        <h4><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:6px"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>Select workspace</h4>
        <button class="close-btn" id="workspace-close" aria-label="Close">✖</button>
      </div>
      <input type="text" class="styled-prompt-input workspace-cur" id="workspace-cur-path"
             spellcheck="false" autocomplete="off" autocapitalize="off" autocorrect="off"
             aria-label="Workspace folder path" placeholder="Type or paste a folder path, then press Enter" />
      <p class="muted workspace-note">File tools are <strong>confined</strong> to this folder. Shell commands start here but are <strong>not sandboxed</strong> and can reach outside it. A workspace scopes the tools; it is not a security boundary.</p>
      <div class="modal-body workspace-body" id="workspace-body" aria-live="polite"></div>
      <section class="workspace-snapshots" aria-label="Workspace snapshots">
        <div class="workspace-snapshot-actions">
          <button type="button" class="confirm-btn confirm-btn-secondary" id="workspace-snapshot-create">Snapshot</button>
          <select id="workspace-snapshot-select" aria-label="Workspace snapshot"><option value="">Select a chat and workspace first</option></select>
          <button type="button" class="confirm-btn confirm-btn-secondary" id="workspace-snapshot-review">Review</button>
          <button type="button" class="confirm-btn confirm-btn-primary" id="workspace-snapshot-restore" disabled>Restore</button>
        </div>
        <div class="muted" id="workspace-snapshot-note" role="status"></div>
        <div id="workspace-snapshot-preview" class="workspace-snapshot-preview"></div>
      </section>
      <div class="modal-footer workspace-footer">
        <button type="button" class="confirm-btn confirm-btn-secondary" id="workspace-cancel">Cancel</button>
        <button type="button" class="confirm-btn confirm-btn-primary" id="workspace-use">Use this folder</button>
      </div>
    </div>`;
  document.body.appendChild(_modal);
  _modal.querySelector('#workspace-close').addEventListener('click', closeWorkspaceBrowser);
  _modal.querySelector('#workspace-cancel').addEventListener('click', closeWorkspaceBrowser);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && _modal.style.display !== 'none') {
      event.preventDefault();
      closeWorkspaceBrowser();
    }
  });
  _modal.querySelector('#workspace-snapshot-create').addEventListener('click', _createSnapshot);
  _modal.querySelector('#workspace-snapshot-review').addEventListener('click', _reviewSnapshot);
  _modal.querySelector('#workspace-snapshot-restore').addEventListener('click', _restoreSnapshot);
  _modal.querySelector('#workspace-snapshot-select').addEventListener('change', _clearSnapshotPreview);
  // Editable path bar: Enter navigates to a typed/pasted folder.
  _modal.querySelector('#workspace-cur-path').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const v = e.target.value.trim();
      if (v) _navigate(v);
    }
  });
  _modal.querySelector('#workspace-use').addEventListener('click', () => {
    if (_modal.querySelector('#workspace-use').disabled || !_curPath) return;
    setWorkspace(_curPath);
    if (uiModule && uiModule.showToast) uiModule.showToast(`Workspace set: ${_basename(_curPath)}`);
    closeWorkspaceBrowser();
  });
  const content = _modal.querySelector('.modal-content');
  const header = _modal.querySelector('.modal-header');
  if (content && header) makeWindowDraggable(_modal, { content, header });
  return _modal;
}

export async function openWorkspaceBrowser() {
  ++_snapshotViewVersion;
  _opener = document.activeElement;
  const modal = _getModal();
  modal.style.display = 'flex';
  modal.querySelector('#workspace-cur-path').focus();
  _clearSnapshotPreview();
  await Promise.all([_navigate(getWorkspace() || ''), _refreshSnapshots()]);
}

export function closeWorkspaceBrowser() {
  ++_snapshotViewVersion;
  _browseController?.abort();
  _browseController = null;
  ++_snapshotListVersion;
  _snapshotLoading = false;
  if (_modal) _modal.style.display = 'none';
  if (_opener?.isConnected && _opener.getClientRects().length) _opener.focus();
}

export function initWorkspace() {
  // Restore persisted workspace into the pill on load.
  syncWorkspaceIndicator(getWorkspace());
  const overflow = document.getElementById('overflow-workspace-btn');
  if (overflow) overflow.addEventListener('click', openWorkspaceBrowser);
  const pill = document.getElementById('workspace-indicator-btn');
  if (pill) pill.addEventListener('click', clearWorkspace);
}

export default { initWorkspace, openWorkspaceBrowser, getWorkspace, setWorkspace, vetAndSetWorkspace, clearWorkspace, syncWorkspaceIndicator, applyMode };
