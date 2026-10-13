const STAGES = Object.freeze({
  reproduce: 'Reproducing',
  edit: 'Ready to edit',
  verify: 'Verifying',
  done: 'Slice checked',
});

function _status(value, labels, fallback) {
  return Object.prototype.hasOwnProperty.call(labels, value) ? labels[value] : fallback;
}

/** Render the current run's work-packet status after its chat bubble. */
export function renderCodingWorkPacketStatus(event, anchor) {
  if (!event || event.type !== 'coding_work_packet' || !anchor || !anchor.parentNode) return null;
  const packet = event.packet && typeof event.packet === 'object' ? event.packet : {};
  const objective = typeof packet.objective === 'string' ? packet.objective.slice(0, 1000) : 'Coding work';
  const stage = _status(event.stage, STAGES, 'In progress');
  const test = _status(event.test_status, { passed: 'Passed', not_verified: 'Not verified' }, 'Not verified');
  const review = _status(event.review_status, { reviewed: 'Reviewed', not_reviewed: 'Not reviewed' }, 'Not reviewed');

  let card = anchor._codingWorkPacketStatus;
  if (!card) {
    card = document.createElement('section');
    card.className = 'coding-work-packet-status';
    card.setAttribute('role', 'status');
    card.setAttribute('aria-live', 'polite');
    card.setAttribute('aria-atomic', 'true');
    anchor._codingWorkPacketStatus = card;
  }
  card.dataset.stage = Object.prototype.hasOwnProperty.call(STAGES, event.stage) ? event.stage : 'active';
  while (card.firstChild) card.removeChild(card.firstChild);

  const title = document.createElement('strong');
  title.className = 'coding-work-packet-title';
  title.textContent = objective;
  card.appendChild(title);

  const details = document.createElement('div');
  details.className = 'coding-work-packet-details';
  for (const [label, value] of [['Stage', stage], ['Test', test], ['Review', review]]) {
    const row = document.createElement('div');
    row.className = 'coding-work-packet-row';
    const name = document.createElement('span');
    name.textContent = label;
    const state = document.createElement('strong');
    state.textContent = value;
    if (label === 'Test') state.dataset.testStatus = event.test_status === 'passed' ? 'passed' : 'not_verified';
    if (label === 'Review') state.dataset.reviewStatus = event.review_status === 'reviewed' ? 'reviewed' : 'not_reviewed';
    row.append(name, state);
    details.appendChild(row);
  }
  card.appendChild(details);
  if (card.parentNode !== anchor.parentNode || card.previousSibling !== anchor) {
    anchor.parentNode.insertBefore(card, anchor.nextSibling);
  }
  return card;
}
