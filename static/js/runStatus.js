const states = new Map();
let current = '';
function render() {
  const header = document.querySelector('.chat-top-bar');
  if (!header) return;
  let pill = document.getElementById('nx-run-status');
  if (!pill) {
    pill = document.createElement('span');
    pill.id = 'nx-run-status';
    pill.setAttribute('role', 'status');
    pill.setAttribute('aria-live', 'polite');
    header.append(pill);
  }
  const state = states.get(current);
  pill.hidden = !state;
  if (state) { pill.textContent = state.label; pill.dataset.state = state.kind; }
}
export function resetRunStatus(sessionId) {
  current = String(sessionId || '');
  if (!current) states.clear();
  render();
}
export function updateRunStatus(event, sessionId) {
  if (!sessionId || !event) return;
  current = String(sessionId);
  let state;
  if (event.type === 'agent_terminal' || event.type === 'chat_terminal') {
    const labels = { completed: ['Finished', 'done'], failed: ['Failed', 'failed'],
      stopped: ['Stopped', 'idle'], waiting_user: ['Needs you', 'waiting'],
      incomplete: ['Incomplete', 'waiting'] };
    state = event.status === 'failed' || event.data?.failed === true
      ? labels.failed : labels[event.status] || ['Review needed', 'waiting'];
  } else if (event.type === 'error' || Number(event.status) >= 400) state = ['Failed', 'failed'];
  else if (event.ask_user || ['ask_user', 'tool_approval', 'approval_required'].includes(event.type)) state = ['Needs you', 'waiting'];
  else if (event.type === 'coding_work_packet') state = event.stage === 'verify'
    ? ['Testing', 'testing'] : ['Working', 'working'];
  else if (['delta', 'tool_start', 'agent_prep', 'agent_step', 'tool_approval_resolved'].includes(event.type) || event.delta) state = ['Working', 'working'];
  else if (event.type === 'stream_end' && !['done', 'failed', 'waiting'].includes(states.get(current)?.kind)) state = ['Ready', 'idle'];
  if (state) {
    states.set(current, { label: state[0], kind: state[1] });
    if (states.size > 16) states.delete(states.keys().next().value);
  }
  render();
}
