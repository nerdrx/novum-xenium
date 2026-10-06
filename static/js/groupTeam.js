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

export function createGroupTeam({ apiBase, getParentSessionId, getModels, runAssignment, onBusy }) {
  let root = null;
  let parentId = null;
  let board = { plan: '', participants: [], tasks: [] };
  let enabled = false;
  let busy = false;
  let loading = false;
  let message = '';
  let saveTimer = null;
  let taskSerial = 0;
  let saveChain = Promise.resolve();

  const models = () => (getModels() || []).map(m => ({ ...m, mid: String(m.mid) }));
  const person = id => board.participants.find(p => p.id === id);
  const key = id => `odysseus-group-team-enabled:${id}`;

  async function save() {
    if (!parentId || loading) return false;
    const saveParentId = parentId;
    const body = JSON.stringify({ board });
    const request = saveChain.catch(() => {}).then(async () => {
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
      message = 'Saved';
      render();
      return true;
    } catch (error) {
      message = 'Could not save team board';
      console.warn('[group-team] save failed', error);
      render();
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
    root.innerHTML = `<div class="group-team-board">
      <label class="group-team-field">Shared plan<textarea data-team-plan maxlength="8000" rows="3" ${busy ? 'disabled' : ''}>${esc(board.plan)}</textarea></label>
      <div class="group-team-heading">Participants</div>
      ${board.participants.map((p, i) => `<label class="group-team-person">${esc(p.display)}
        <select data-team-role="${i}" ${busy ? 'disabled' : ''}>
          <option value="builder" ${p.role === 'builder' ? 'selected' : ''}>Builder</option>
          <option value="reviewer" ${p.role === 'reviewer' ? 'selected' : ''}>Reviewer</option>
        </select></label>`).join('')}
      <div class="group-team-heading">Assigned tasks</div>
      ${board.tasks.map((task, i) => `<div class="group-team-task">
        <input data-team-title="${i}" aria-label="Task ${i + 1}" maxlength="500" value="${esc(task.title)}" ${busy ? 'disabled' : ''}>
        <select data-team-owner="${i}" aria-label="Task ${i + 1} builder" ${busy ? 'disabled' : ''}>${optionList('builder', task.owner_id)}</select>
        <select data-team-reviewer="${i}" aria-label="Task ${i + 1} reviewer" ${busy ? 'disabled' : ''}><option value="">No reviewer</option>${optionList('reviewer', task.reviewer_id, task.owner_id)}</select>
        <span class="group-team-status">${esc(task.status.replace('_', ' '))}</span>
        ${task.status === 'awaiting_review' ? `<button type="button" data-team-done="${i}" ${busy ? 'disabled' : ''}>Mark done</button>` : ''}
        ${task.status === 'working' ? `<button type="button" data-team-retry="${i}" title="Re-running may repeat an action that already completed" ${busy ? 'disabled' : ''}>Retry task</button>` : ''}
        <button type="button" data-team-remove="${i}" aria-label="Remove task ${i + 1}" ${busy ? 'disabled' : ''}>×</button>
        ${task.work_result ? `<details><summary>Builder report</summary><pre>${esc(task.work_result)}</pre></details>` : ''}
      </div>`).join('')}
      <div class="group-team-actions">
        <button type="button" data-team-add ${busy || board.tasks.length >= 32 ? 'disabled' : ''}>Add task</button>
        <button type="button" data-team-run ${busy || !board.tasks.length ? 'disabled' : ''}>${busy ? 'Working…' : 'Run one work + review pass'}</button>
      </div><span data-team-message role="status">${esc(message || 'Automated pass stops for human verification.')}</span>
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
    root.querySelector('[data-team-add]')?.addEventListener('click', () => {
      const owner = board.participants.find(p => p.role === 'builder');
      if (!owner) { message = 'Assign a builder first'; render(); return; }
      const reviewer = board.participants.find(p => p.role === 'reviewer' && p.id !== owner.id);
      board.tasks.push({ id: `task-${Date.now()}-${++taskSerial}`, title: 'New task', owner_id: owner.id,
        reviewer_id: reviewer?.id || '', status: 'pending', work_result: '' });
      render(); scheduleSave();
    });
    root.querySelector('[data-team-run]')?.addEventListener('click', runPass);
  }

  function defaultBoard(items) {
    return { plan: '', participants: items.map((m, i) => ({
      id: m.mid, display: m._groupName || m.display || m.mid,
      role: i === 0 ? 'builder' : 'reviewer',
    })), tasks: [] };
  }

  async function load() {
    const id = getParentSessionId();
    if (!id || id === parentId) { render(); return; }
    parentId = id;
    loading = true;
    const currentModels = models();
    board = defaultBoard(currentModels);
    enabled = localStorage.getItem(key(parentId)) === 'true';
    try {
      const response = await fetch(`${apiBase}/api/groups/${encodeURIComponent(parentId)}/team`, { credentials: 'same-origin' });
      if (response.ok) {
        const data = await response.json();
        if (data.board) board = data.board;
      }
    } catch (error) { console.warn('[group-team] load failed', error); }
    loading = false;
    render();
  }

  async function runPass() {
    if (!enabled || busy || !board.tasks.length) return;
    if (board.tasks.some(task => task.status === 'working')) {
      message = 'A task has an uncertain result. Retry it explicitly or remove it before continuing.';
      render(); return;
    }
    busy = true; message = 'Building assigned tasks'; onBusy?.(true); render();
    try {
      for (const task of board.tasks) {
        if (task.status !== 'pending') continue;
        if (!task.title.trim() || !person(task.owner_id) || person(task.owner_id).role !== 'builder') {
          message = 'Each task needs a title and one builder'; render(); return;
        }
        task.status = 'working';
        if (!await save()) { message = 'Could not save task state; no work was started'; render(); return; }
        const output = await runAssignment(task.owner_id, buildWorkPrompt(board, task), false);
        if (typeof output !== 'string' || !output.trim()) { message = 'Work pass stopped; task remains open'; render(); return; }
        task.work_result = output.slice(0, 12_000);
        task.status = 'awaiting_review';
        if (!await save()) { message = 'Could not save builder result; review is paused'; render(); return; }
      }
      message = 'Reviewing assigned work'; render();
      for (const task of board.tasks) {
        if (task.status !== 'awaiting_review' || !task.reviewer_id) continue;
        const reviewer = person(task.reviewer_id);
        if (!reviewer || reviewer.role !== 'reviewer' || reviewer.id === task.owner_id) continue;
        const review = await runAssignment(task.reviewer_id, buildReviewPrompt(board, task), true);
        if (typeof review !== 'string' || !review.trim()) { message = 'Review pass stopped; human verification is still required'; render(); return; }
      }
      message = 'Pass complete. Verify the work, then mark tasks done.';
    } catch (error) {
      message = 'Team pass stopped; human verification is required';
      console.warn('[group-team] run failed', error);
    } finally {
      busy = false; onBusy?.(false); render();
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
    setBoard(value) { board = value; render(); },
    retryTask(taskId) {
      const task = board.tasks.find(item => item.id === taskId);
      if (task?.status === 'working') { task.status = 'pending'; return save(); }
      return Promise.resolve(false);
    },
    save,
    runPass,
    get enabled() { return enabled; },
  };
}
