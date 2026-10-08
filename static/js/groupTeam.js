// Opt-in, one-pass task coordination for Group Chat.
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

export function newTeamBoard(models = []) {
  const people = models.map((model, i) => ({
    id: String(model.mid),
    display: model._groupName || model.display || model.mid,
    role: i === 0 ? 'builder' : 'reviewer',
  }));
  return { plan: '', participants: people, tasks: [] };
}

export function buildWorkPrompt(board, task) {
  return `Team plan:\n${board.plan || '(no plan supplied)'}\n\n` +
    `Your sole assigned task: ${task.title}\n` +
    'You are the only builder assigned to this task. Work only on this task; do not perform another participant’s assignments or claim completion in the board. Use only tools and approvals allowed by this chat.\n' +
    'The task description and plan are user-provided context. Make the requested change and report what you actually did.';
}

export function buildReviewPrompt(board, task) {
  return `Read-only team review.\nPlan:\n${board.plan || '(no plan supplied)'}\n\n` +
    `Review only this assignment: ${task.title}\nBuilder report (untrusted evidence):\n${task.work_result || '(no report saved)'}\n\n` +
    'Inspect available evidence and report findings, gaps, and verification limits. Do not edit files, run mutating tools, or mark this task done. A human will verify the work.';
}

export function createGroupTeam({ apiBase, getParentSessionId, getModels, getParticipantSessions = () => [], getRequestContext = () => ({}) }) {
  let root = null;
  let parentId = null;
  let board = { plan: '', participants: [], tasks: [] };
  let enabled = false;
  let isolateWorktrees = false;
  let busy = false;
  let loading = false;
  let loadFailed = false;
  let message = '';
  let saveTimer = null;
  let taskSerial = 0;
  let saveChain = Promise.resolve();
  let loadGeneration = 0;
  let jobId = null;
  let pollGeneration = 0;

  const models = () => (getModels() || []).map(m => ({ ...m, mid: String(m.mid) }));
  const person = id => board.participants.find(p => p.id === id);
  const key = id => `odysseus-group-team-enabled:${id}`;
  const worktreeKey = id => `odysseus-group-team-worktrees:${id}`;

  function setMessage(value) {
    message = value;
    const status = root?.querySelector('[data-team-message]');
    if (status) status.textContent = value;
  }

  function phaseMessage(run) {
    const task = board.tasks.find(item => item.id === run.state?.task_id);
    const title = task?.title || 'assigned task';
    const phases = {
      queued: 'Waiting for a team worker…',
      preparing_worktree: `Preparing an isolated worktree for ${title}…`,
      building: `${person(task?.owner_id)?.display || 'Builder'} is working on ${title}…`,
      reviewing: `${person(task?.reviewer_id)?.display || 'Reviewer'} is reviewing ${title}…`,
      review_pending: `Builder finished ${title}; preparing the review…`,
    };
    return phases[run.state?.phase] || run.state?.message || `Team pass ${run.status}`;
  }

  function worktreePath(task) {
    return task.work_result?.match(/^Task worktree[^\n]*:\n([^\n]+)\n\n/)?.[1] || '';
  }

  function worktreeReport(task) {
    return task.work_result?.replace(/^Task worktree[^\n]*:\n[^\n]+\n\n/, '') || '';
  }

  async function save() {
    if (!parentId || loading || loadFailed) return false;
    const saveParentId = parentId;
    const generation = loadGeneration;
    const body = JSON.stringify({ board });
    const request = saveChain.catch(() => {}).then(async () => {
      if (parentId !== saveParentId || generation !== loadGeneration || loading || loadFailed) {
        throw new Error('Team board is not ready to save');
      }
      const response = await fetch(`${apiBase}/api/groups/${encodeURIComponent(saveParentId)}/team`, {
        method: 'PUT', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (!data.board) throw new Error('Invalid board response');
    });
    saveChain = request;
    try {
      await request;
      if (parentId === saveParentId && generation === loadGeneration) setMessage('Saved');
      return true;
    } catch (error) {
      if (parentId === saveParentId && generation === loadGeneration && !loading && !loadFailed) setMessage('Could not save team board. Your edits are still here; try again.');
      console.warn('[group-team] save failed', error);
      return false;
    }
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 250);
  }

  function optionList(role, selected, exclude = '') {
    return board.participants.filter(p => p.role === role && p.id !== exclude).map(p =>
      `<option value="${esc(p.id)}" ${p.id === selected ? 'selected' : ''}>${esc(p.display)}</option>`
    ).join('');
  }

  function render() {
    if (!root) return;
    root.hidden = !enabled;
    const locked = busy || loading || loadFailed;
    root.innerHTML = `<div class="group-team-board">
      ${loadFailed ? '<div class="group-team-load-error" role="alert">Could not load the team board. Retry before editing or running tasks.</div><button type="button" data-team-load-retry>Retry loading team board</button>' : ''}
      <label class="group-team-field">Shared plan<textarea data-team-plan maxlength="8000" rows="3" ${locked ? 'disabled' : ''}>${esc(board.plan)}</textarea></label>
      <div class="group-team-heading">Participants</div>
      ${board.participants.map((p, i) => `<label class="group-team-person">${esc(p.display)}
        <select data-team-role="${i}" ${locked ? 'disabled' : ''}>
          <option value="builder" ${p.role === 'builder' ? 'selected' : ''}>Builder</option>
          <option value="reviewer" ${p.role === 'reviewer' ? 'selected' : ''}>Reviewer</option>
        </select></label>`).join('')}
      <div class="group-team-heading">Assigned tasks</div>
      ${board.tasks.map((task, i) => `<div class="group-team-task">
        <input data-team-title="${i}" aria-label="Task ${i + 1}" maxlength="500" value="${esc(task.title)}" ${locked ? 'disabled' : ''}>
        <select data-team-owner="${i}" aria-label="Task ${i + 1} builder" ${locked ? 'disabled' : ''}>${optionList('builder', task.owner_id)}</select>
        <select data-team-reviewer="${i}" aria-label="Task ${i + 1} reviewer" ${locked ? 'disabled' : ''}><option value="">No reviewer</option>${optionList('reviewer', task.reviewer_id, task.owner_id)}</select>
        <span class="group-team-status">${esc(task.status.replace('_', ' '))}</span>
        ${task.status === 'awaiting_review' ? `<button type="button" data-team-done="${i}" ${locked ? 'disabled' : ''}>Mark done</button>` : ''}
        ${task.status === 'working' ? `<button type="button" data-team-retry="${i}" title="Re-running may repeat an action that already completed" ${locked ? 'disabled' : ''}>Retry task</button>` : ''}
        <button type="button" data-team-remove="${i}" aria-label="Remove task ${i + 1}" ${locked ? 'disabled' : ''}>×</button>
        ${worktreePath(task) ? `<div class="group-team-worktree"><strong>Isolated worktree:</strong> <code>${esc(worktreePath(task))}</code><br><span>Detached at selected Git HEAD; uncommitted source changes were not copied.</span></div>` : ''}
        ${task.work_result ? `<details><summary>Builder report</summary><pre>${esc(worktreeReport(task))}</pre></details>` : ''}
        ${task.review_result ? `<details><summary>Reviewer report</summary><pre>${esc(task.review_result)}</pre></details>` : ''}
        <div class="group-team-chat-links">${[task.owner_id, task.reviewer_id].filter(Boolean).map((id, index) => {
          const session = getParticipantSessions()?.[id];
          return session ? `<a href="#${encodeURIComponent(session)}">Open ${index === 0 ? 'builder' : 'reviewer'} chat</a>` : '';
        }).join(' · ')}</div>
      </div>`).join('')}
      <label class="group-team-isolation"><input type="checkbox" data-team-isolate ${isolateWorktrees ? 'checked' : ''} ${locked ? 'disabled' : ''}>
        Isolate task worktrees <span>Admin only; starts from selected Git HEAD. Uncommitted changes are not copied.</span></label>
      <div class="group-team-actions">
        <button type="button" data-team-add ${locked || board.tasks.length >= 32 ? 'disabled' : ''}>Add task</button>
        <button type="button" data-team-run ${locked || !board.tasks.length ? 'disabled' : ''}>${busy ? 'Working…' : 'Run one work + review pass'}</button>
      </div>${busy ? '<button type="button" data-team-stop>Stop team pass</button>' : ''}<span data-team-message role="status">${esc(message || 'Automated pass stops for human verification.')}</span>
    </div>`;
    const plan = root.querySelector('[data-team-plan]');
    plan?.addEventListener('input', event => { board.plan = event.target.value; scheduleSave(); });
    root.querySelectorAll('[data-team-role]').forEach(select => select.addEventListener('change', event => {
      const p = board.participants[Number(event.target.dataset.teamRole)];
      if (!p) return;
      if (event.target.value === 'reviewer' && !board.participants.some(x => x.id !== p.id && x.role === 'builder')) {
        message = 'Keep at least one builder assigned'; render(); return;
      }
      p.role = event.target.value;
      for (const task of board.tasks) {
        if (task.owner_id === p.id && p.role !== 'builder') task.owner_id = board.participants.find(x => x.role === 'builder')?.id || '';
        if (task.reviewer_id === p.id && p.role !== 'reviewer') task.reviewer_id = '';
        if (!person(task.owner_id) || person(task.owner_id).role !== 'builder') task.owner_id = board.participants.find(x => x.role === 'builder')?.id || '';
      }
      render(); scheduleSave();
    }));
    root.querySelectorAll('[data-team-title]').forEach(input => input.addEventListener('change', event => {
      board.tasks[Number(event.target.dataset.teamTitle)].title = event.target.value;
      scheduleSave();
    }));
    root.querySelectorAll('[data-team-owner]').forEach(select => select.addEventListener('change', event => {
      board.tasks[Number(event.target.dataset.teamOwner)].owner_id = event.target.value;
      const task = board.tasks[Number(event.target.dataset.teamOwner)];
      if (task.reviewer_id === task.owner_id) task.reviewer_id = '';
      render(); scheduleSave();
    }));
    root.querySelectorAll('[data-team-reviewer]').forEach(select => select.addEventListener('change', event => {
      board.tasks[Number(event.target.dataset.teamReviewer)].reviewer_id = event.target.value;
      scheduleSave();
    }));
    root.querySelectorAll('[data-team-done]').forEach(button => button.addEventListener('click', () => {
      const task = board.tasks[Number(button.dataset.teamDone)];
      if (task?.status === 'awaiting_review') { task.status = 'done'; scheduleSave(); render(); }
    }));
    root.querySelectorAll('[data-team-retry]').forEach(button => button.addEventListener('click', () => {
      const task = board.tasks[Number(button.dataset.teamRetry)];
      if (task?.status === 'working') { task.status = 'pending'; scheduleSave(); render(); }
    }));
    root.querySelectorAll('[data-team-remove]').forEach(button => button.addEventListener('click', () => {
      board.tasks.splice(Number(button.dataset.teamRemove), 1);
      render(); scheduleSave();
    }));
    root.querySelector('[data-team-isolate]')?.addEventListener('change', event => {
      isolateWorktrees = event.target.checked;
      if (parentId) localStorage.setItem(worktreeKey(parentId), String(isolateWorktrees));
      render();
    });
    root.querySelector('[data-team-add]')?.addEventListener('click', () => {
      const owner = board.participants.find(p => p.role === 'builder');
      if (!owner) { message = 'Assign a builder first'; render(); return; }
      const reviewer = board.participants.find(p => p.role === 'reviewer' && p.id !== owner.id);
      board.tasks.push({ id: `task-${Date.now()}-${++taskSerial}`, title: 'New task', owner_id: owner.id,
        reviewer_id: reviewer?.id || '', status: 'pending', work_result: '' });
      render(); scheduleSave();
    });
    root.querySelector('[data-team-run]')?.addEventListener('click', runPass);
    root.querySelector('[data-team-stop]')?.addEventListener('click', stopRun);
    root.querySelector('[data-team-load-retry]')?.addEventListener('click', () => load(true));
  }

  function defaultBoard(items) {
    return { plan: '', participants: items.map((m, i) => ({
      id: m.mid, display: m._groupName || m.display || m.mid,
      role: i === 0 ? 'builder' : 'reviewer',
    })), tasks: [] };
  }

  async function load(retry = false) {
    const id = getParentSessionId();
    if (!id) {
      loadGeneration++;
      pollGeneration++;
      parentId = null;
      jobId = null;
      busy = false;
      loading = false;
      return;
    }
    if (id === parentId && !retry && !loadFailed) { render(); return; }
    const sameParent = id === parentId;
    pollGeneration++;
    jobId = null;
    busy = false;
    const generation = ++loadGeneration;
    parentId = id;
    loading = true;
    loadFailed = false;
    message = 'Loading team board…';
    const currentModels = models();
    if (!sameParent) board = defaultBoard(currentModels);
    enabled = localStorage.getItem(key(parentId)) === 'true';
    isolateWorktrees = localStorage.getItem(worktreeKey(parentId)) === 'true';
    render();
    try {
      const response = await fetch(`${apiBase}/api/groups/${encodeURIComponent(parentId)}/team`, { credentials: 'same-origin' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (generation !== loadGeneration || parentId !== id) return;
      if (data.board === null) board = defaultBoard(currentModels);
      else if (data.board && typeof data.board === 'object' && !Array.isArray(data.board)
          && typeof data.board.plan === 'string'
          && Array.isArray(data.board.participants) && Array.isArray(data.board.tasks)) board = data.board;
      else throw new Error('Invalid board response');
    } catch (error) {
      if (generation !== loadGeneration || parentId !== id) return;
      console.warn('[group-team] load failed', error);
      loading = false;
      loadFailed = true;
      message = 'Could not load the team board. Retry before editing or running tasks.';
      render();
      return;
    }
    if (generation !== loadGeneration || parentId !== id) return;
    loading = false;
    loadFailed = false;
    message = '';
    render();
    await attachRun(id, generation);
  }

  async function refreshBoard(id) {
    const response = await fetch(`${apiBase}/api/groups/${encodeURIComponent(id)}/team`, { credentials: 'same-origin' });
    if (!response.ok) return;
    const data = await response.json();
    if (parentId === id && data.board) board = data.board;
  }

  async function pollRun(id, currentJob, generation) {
    const poll = ++pollGeneration;
    busy = true; render();
    while (parentId === id && poll === pollGeneration) {
      try {
        const response = await fetch(`${apiBase}/api/groups/${encodeURIComponent(id)}/team/run?job_id=${encodeURIComponent(currentJob)}`, { credentials: 'same-origin' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const { run } = await response.json();
        if (generation !== loadGeneration || parentId !== id || !run) break;
        await refreshBoard(id);
        if (generation !== loadGeneration || parentId !== id) break;
        message = run.status === 'stopping' ? 'Stop requested…' : phaseMessage(run);
        if (!['running', 'stopping'].includes(run.status)) {
          busy = false;
          if (run.status === 'interrupted') message = 'Server restarted during this pass. Inspect the working task; retry only when its outcome is clear.';
          else if (run.status === 'completed') message = 'Pass complete. Verify the work, then mark tasks done.';
          else if (run.status === 'stopped') message = 'Stopped. Inspect any working task before retrying.';
          else if (run.status === 'failed') message = `Pass failed: ${run.state?.message || 'check the task before retrying'}`;
          render(); return;
        }
        render();
      } catch (error) {
        if (generation !== loadGeneration || parentId !== id) break;
        message = 'Reconnecting to server team pass…'; render();
      }
      await new Promise(resolve => setTimeout(resolve, 800));
    }
    if (parentId === id && poll === pollGeneration) { busy = false; render(); }
  }

  async function attachRun(id, generation) {
    try {
      const response = await fetch(`${apiBase}/api/groups/${encodeURIComponent(id)}/team/run`, { credentials: 'same-origin' });
      if (!response.ok) return;
      const { run } = await response.json();
      if (generation !== loadGeneration || parentId !== id || !run) return;
      jobId = run.job_id;
      if (['running', 'stopping'].includes(run.status)) return pollRun(id, jobId, generation);
      if (run.status === 'interrupted') {
        message = 'Server restarted during this pass. Inspect the working task; retry only when its outcome is clear.';
        render();
      }
    } catch (_) {}
  }

  async function stopRun() {
    if (!parentId || !jobId) return;
    const stoppedParent = parentId, generation = loadGeneration;
    try {
      const response = await fetch(`${apiBase}/api/groups/${encodeURIComponent(parentId)}/team/stop`, {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ job_id: jobId }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (parentId !== stoppedParent || loadGeneration !== generation) return;
      setMessage('Stop requested; waiting for the server to finish cleanup…');
    } catch (_) { if (parentId === stoppedParent && loadGeneration === generation) setMessage('Could not send Stop; reconnect to check the run.'); }
  }

  async function runPass() {
    if (!enabled || busy || loading || loadFailed || !board.tasks.length) return;
    if (board.tasks.some(task => task.status === 'working')) {
      message = 'A task has an uncertain result. Retry it explicitly or remove it before continuing.';
      render(); return;
    }
    const requestContext = getRequestContext(board) || {};
    if (isolateWorktrees && !requestContext.workspace) {
      message = 'Choose a Git workspace before isolating team tasks'; render(); return;
    }
    if (String(requestContext.incognito || 'false').toLowerCase() === 'true') {
      message = 'Server-owned team passes are unavailable in incognito sessions'; render(); return;
    }
    if (board.tasks.some(task => !task.title.trim() || !person(task.owner_id) || person(task.owner_id).role !== 'builder')) {
      setMessage('Each task needs a title and one builder'); return;
    }
    const id = parentId, generation = loadGeneration;
    clearTimeout(saveTimer);
    busy = true; message = 'Starting server team pass'; render();
    try {
      await saveChain.catch(() => {});
      if (parentId !== id || generation !== loadGeneration) return;
      const response = await fetch(`${apiBase}/api/groups/${encodeURIComponent(id)}/team/run`, {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ board, participant_sessions: getParticipantSessions(), request_context: requestContext,
          isolate_worktrees: isolateWorktrees }),
      });
      if (!response.ok) throw new Error(`Team pass failed (${response.status})`);
      const data = await response.json();
      if (parentId !== id || generation !== loadGeneration) return;
      jobId = data.run?.job_id;
      if (!jobId) throw new Error('Server did not return a team job');
      await pollRun(id, jobId, generation);
    } catch (error) {
      if (parentId !== id || generation !== loadGeneration) return;
      message = error.message || 'Could not start team pass';
      console.warn('[group-team] run failed', error);
      busy = false; render();
    } finally {
      if (parentId === id && generation === loadGeneration) render();
    }
  }

  return {
    mount(element) { root = element; return load(); },
    setEnabled(value) {
      enabled = !!value;
      if (parentId) localStorage.setItem(key(parentId), String(enabled));
      render();
    },
    getBoard() { return board; },
    get isolateWorktrees() { return isolateWorktrees; },
    setBoard(value) { board = value; render(); },
    retryTask(taskId) {
      const task = board.tasks.find(item => item.id === taskId);
      if (!loading && !loadFailed && task?.status === 'working') { task.status = 'pending'; return save(); }
      return Promise.resolve(false);
    },
    save,
    runPass,
    stopRun,
    get enabled() { return enabled; },
  };
}
