const STAGES = Object.freeze({
  reproduce: 'Reproducing', edit: 'Ready to edit', verify: 'Verifying', done: 'Slice checked',
});
const REVIEWS = Object.freeze({ passed: 'Passed', failed: 'Failed', unverified: 'Unverified' });
const REVIEW_LABELS = Object.freeze({ ...REVIEWS, not_reviewed: 'Not reviewed' });

function _status(value, labels, fallback) {
  return Object.prototype.hasOwnProperty.call(labels, value) ? labels[value] : fallback;
}

function _el(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text != null) el.textContent = String(text);
  return el;
}

function _clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function _packetText(value, fallback = '', limit = 500) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, limit) : fallback;
}

function _currentStep(event, packet) {
  if (typeof event.current_step === 'string' && event.current_step.trim()) return event.current_step.trim();
  const stage = event.stage;
  if (stage === 'reproduce') return `Reproducing · ${_packetText(packet.reproduce_command, 'checking the reported behavior')}`;
  if (stage === 'edit') return `Editing · ${(Array.isArray(packet.files) ? packet.files.filter(file => typeof file === 'string') : []).join(', ') || 'planned files'}`;
  if (stage === 'verify') return `Verifying · ${_packetText(packet.acceptance_command, 'running the acceptance check')}`;
  if (stage === 'done') return `Slice checked · ${_packetText(packet.acceptance_condition, 'acceptance check passed')}`;
  return 'Work in progress';
}

function _planDetails(card, packet) {
  let details = card._codingPlanDetails;
  if (!details) {
    details = _el('details', 'coding-work-packet-plan');
    details.appendChild(_el('summary', '', 'Plan and files'));
    details.appendChild(_el('div', 'coding-work-packet-plan-content'));
    card._codingPlanDetails = details;
  }
  const content = details.querySelector('.coding-work-packet-plan-content');
  _clear(content);
  for (const [label, value] of [
    ['Files', Array.isArray(packet.files) ? packet.files.filter(file => typeof file === 'string').join(', ') : ''],
    ['Reproduction check', packet.reproduce_command],
    ['Acceptance check', packet.acceptance_command],
    ['Acceptance means', packet.acceptance_condition],
  ]) {
    if (typeof value !== 'string' || !value.trim()) continue;
    const row = _el('div', 'coding-work-packet-plan-row');
    row.append(_el('span', '', label), _el('code', '', value));
    content.appendChild(row);
  }
  return details;
}

/** Render the current run's compact work card after its chat bubble. */
export function renderCodingWorkPacketStatus(event, anchor) {
  if (!event || event.type !== 'coding_work_packet' || !anchor || !anchor.parentNode) return null;
  const packet = event.packet && typeof event.packet === 'object' ? event.packet : {};
  const objective = _packetText(packet.objective, 'Coding work', 1000);
  const stage = _status(event.stage, STAGES, 'In progress');
  let card = anchor._codingWorkPacketStatus;
  const observedTestStatus = card?._codingAcceptanceCheck?.command === packet.acceptance_command
    && event.stage === 'verify' ? card._codingAcceptanceCheck.status : null;
  const effectiveTestStatus = ['passed', 'failed'].includes(event.test_status)
    ? event.test_status : (observedTestStatus || 'not_verified');
  const test = _status(effectiveTestStatus, { passed: 'Passed', failed: 'Failed', not_verified: 'Not verified' }, 'Not verified');
  const review = _status(event.review_status, REVIEW_LABELS, 'Not reviewed');

  if (!card) {
    card = _el('section', 'coding-work-packet-status');
    card.dataset.stage = 'active';
    const title = _el('strong', 'coding-work-packet-title');
    const current = _el('p', 'coding-work-packet-current');
    current.setAttribute('aria-live', 'polite');
    current.setAttribute('aria-atomic', 'true');
    const state = _el('div', 'coding-work-packet-state');
    const details = _el('div', 'coding-work-packet-details');
    card.append(title, current, state, details);
    anchor._codingWorkPacketStatus = card;
  }
  card.dataset.stage = Object.prototype.hasOwnProperty.call(STAGES, event.stage) ? event.stage : 'active';
  card._codingPacket = packet;
  card.children[0].textContent = objective;
  card.children[1].textContent = _currentStep(event, packet).slice(0, 500);

  const state = card.children[2];
  _clear(state);
  for (const [label, value, dataKey] of [
    ['Stage', stage, 'stage'], ['Tests', test, 'testStatus'], ['Review', review, 'reviewStatus'],
  ]) {
    const chip = _el('span', 'coding-work-packet-chip');
    chip.dataset[dataKey] = dataKey === 'stage' ? card.dataset.stage
      : (dataKey === 'testStatus' ? effectiveTestStatus
        : (Object.prototype.hasOwnProperty.call(REVIEWS, event.review_status) ? event.review_status : 'not_reviewed'));
    chip.append(_el('span', 'coding-work-packet-chip-label', label), _el('strong', '', value));
    if (dataKey === 'testStatus') card._codingTestValue = chip.lastChild;
    state.appendChild(chip);
  }

  const details = card.children[3];
  _clear(details);
  details.appendChild(_planDetails(card, packet));
  if (card._codingToolActivity) details.appendChild(card._codingToolActivity);
  if (card.parentNode !== anchor.parentNode || card.previousSibling !== anchor) anchor.parentNode.insertBefore(card, anchor.nextSibling);
  return card;
}

function _toolGroup(tool) {
  const name = String(tool || 'tool').replace(/[_-]+/g, ' ').trim();
  if (/search|browse|web fetch/i.test(name)) return 'Searches';
  if (/read|inspect|list|open|fetch/i.test(name)) return 'Reads';
  if (/write|edit|patch|replace|create file/i.test(name)) return 'Edits';
  return name ? name.replace(/\b\w/g, c => c.toUpperCase()) : 'Other tools';
}

function _refreshGroup(group) {
  const failed = group.items.filter(item => item.dataset.outcome === 'failed').length;
  const blocked = group.items.filter(item => item.dataset.outcome === 'blocked').length;
  const running = group.items.filter(item => item.dataset.outcome === 'running').length;
  const count = group.items.length;
  group.summary.textContent = `${group.label} · ${count} ${count === 1 ? 'action' : 'actions'}${running ? ` · ${running} running` : ''}${failed ? ` · ${failed} failed` : ''}${blocked ? ` · ${blocked} blocked` : ''}`;
  group.details.dataset.failed = String(failed);
}

function _setToolNodeGrouped(node, hidden) {
  if (!node) return;
  node.dataset.codingWorkOutcome = hidden ? 'completed' : (node.dataset.codingWorkOutcome || 'visible');
  const classes = String(node.className || '').split(/\s+/).filter(Boolean).filter(c => c !== 'coding-work-group-hidden');
  if (hidden) classes.push('coding-work-group-hidden');
  node.className = classes.join(' ');
}

function _saveToolDetails(item, event) {
  const body = item._detailsBody;
  if (event.command && !item._savedCommand) {
    body.appendChild(_el('code', 'coding-work-packet-tool-command', String(event.command)));
    item._savedCommand = true;
  }
  if (typeof event.output === 'string' && event.output) {
    let output = body.querySelector('.coding-work-packet-tool-output');
    if (!output) { output = _el('pre', 'coding-work-packet-tool-output'); body.appendChild(output); }
    output.textContent = event.output;
  }
  const diff = event.diff && (event.diff.text || JSON.stringify(event.diff));
  if (typeof diff === 'string' && diff) {
    let output = body.querySelector('.coding-work-packet-tool-diff');
    if (!output) { output = _el('pre', 'coding-work-packet-tool-diff'); body.appendChild(output); }
    output.textContent = diff;
  }
  if (typeof event.error === 'string' && event.error) {
    let error = body.querySelector('.coding-work-packet-tool-error');
    if (!error) { error = _el('pre', 'coding-work-packet-tool-error'); body.appendChild(error); }
    error.textContent = event.error;
  }
}

/** Add live tool events to the card, folding repeated searches/reads together. */
export function recordCodingWorkToolActivity(event, anchor, toolNode = null) {
  const card = anchor?._codingWorkPacketStatus;
  if (!card || !event || !['tool_start', 'tool_progress', 'tool_output'].includes(event.type)) return null;
  if (!card._codingToolActivity) {
    const activity = _el('details', 'coding-work-packet-activity');
    const summary = _el('summary', '', 'Tool activity');
    const groups = _el('div', 'coding-work-packet-tool-groups');
    activity.append(summary, groups);
    card._codingToolActivity = activity;
    card.children[3].appendChild(activity);
  }
  const tool = String(event.tool || 'tool');
  const label = _toolGroup(tool);
  let group = card._codingToolGroups?.get(label);
  if (!group) {
    card._codingToolGroups ||= new Map();
    const details = _el('details', 'coding-work-packet-tool-group');
    const summary = _el('summary', '', label);
    const list = _el('ul', 'coding-work-packet-tool-list');
    details.append(summary, list);
    card._codingToolGroups.set(label, group = { label, details, summary, list, items: [] });
    card._codingToolActivity.querySelector('.coding-work-packet-tool-groups').appendChild(details);
  }
  let item = card._codingActiveTools?.get(tool);
  if (event.type === 'tool_start' || !item) {
    card._codingActiveTools ||= new Map();
    item = _el('li', 'coding-work-packet-tool-item');
    item.dataset.outcome = event.type === 'tool_output' ? 'completed' : 'running';
    const disclosure = _el('details', 'coding-work-packet-tool-disclosure');
    const heading = _el('summary', 'coding-work-packet-tool-name', String(event.command || tool).slice(0, 240));
    disclosure.appendChild(heading);
    const body = _el('div', 'coding-work-packet-tool-full-detail');
    disclosure.appendChild(body);
    item._detailsBody = body;
    item._disclosureHeading = heading;
    item._toolNode = toolNode;
    _saveToolDetails(item, event);
    item.appendChild(disclosure);
    item.appendChild(_el('span', 'coding-work-packet-tool-status', item.dataset.outcome === 'running' ? 'Running' : 'Completed'));
    const note = _el('span', 'coding-work-packet-tool-note');
    item.appendChild(note);
    group.items.push(item);
    group.list.appendChild(item);
    card._codingActiveTools.set(tool, item);
  }
  if (toolNode) item._toolNode = toolNode;
  _saveToolDetails(item, event);
  const note = item.querySelector('.coding-work-packet-tool-note');
  const detail = event.type === 'tool_progress' ? (event.message || event.tail)
    : (event.type === 'tool_output' ? (event.error || event.message || '') : '');
  if (typeof detail === 'string' && detail.trim()) note.textContent = detail.trim().slice(-500);
  if (event.type === 'tool_output') {
    const blocked = event.blocked === true;
    const failed = !blocked && (event.success === false || event.error
      || (event.exit_code != null && Number(event.exit_code) !== 0));
    item.dataset.outcome = blocked ? 'blocked' : (failed ? 'failed' : 'completed');
    item.querySelector('.coding-work-packet-tool-status').textContent = blocked ? 'Blocked' : (failed ? 'Failed' : 'Completed');
    item._disclosureHeading.textContent = String(event.command || item._disclosureHeading.textContent).slice(0, 240);
    item._hasVisualArtifact = Boolean(event.screenshot || event.image_url || event.subagent);
    card._codingActiveTools.delete(tool);
    const acceptanceCommand = card._codingPacket?.acceptance_command;
    if (card.dataset.stage === 'verify' && tool === 'bash'
        && typeof acceptanceCommand === 'string' && event.command === acceptanceCommand
        && event.exit_code != null) {
      const acceptanceStatus = Number(event.exit_code) === 0 ? 'passed' : 'failed';
      card._codingAcceptanceCheck = { command: acceptanceCommand, status: acceptanceStatus };
      if (card._codingTestValue) {
        card._codingTestValue.textContent = acceptanceStatus === 'passed' ? 'Passed' : 'Failed';
        card._codingTestValue.parentNode.dataset.testStatus = acceptanceStatus;
      }
    }
    if (group.items.length > 1) {
      for (const entry of group.items) {
        const canFold = entry.dataset.outcome === 'completed' && !entry._hasVisualArtifact;
        _setToolNodeGrouped(entry._toolNode, canFold);
      }
    }
  }
  _refreshGroup(group);
  const all = [...card._codingToolGroups.values()];
  const total = all.reduce((n, entry) => n + entry.items.length, 0);
  const summary = card._codingToolActivity.querySelector(':scope > summary');
  summary.textContent = `Tool activity · ${total} ${total === 1 ? 'action' : 'actions'}`;
  return item;
}
