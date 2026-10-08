const cardsBySession = new Map();
const POLL_MS = 1500;

function sessionId(value) {
  const id = value && value.session_id;
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id) ? id : '';
}

function setStatus(card, label) {
  const status = card.querySelector('.subagent-card-status');
  if (status) status.textContent = label;
}

async function poll(watch) {
  watch.timer = null;
  const cards = [...watch.cards].filter(card => card.isConnected);
  watch.cards = new Set(cards);
  if (!cards.length) { cardsBySession.delete(watch.id); return; }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(`/api/chat/stream_status/${encodeURIComponent(watch.id)}`, { credentials: 'same-origin', signal: controller.signal });
    if (response.status === 404) {
      cards.forEach(card => setStatus(card, 'Ready to inspect'));
      cardsBySession.delete(watch.id);
      return;
    }
    if (!response.ok) throw new Error('status unavailable');
    cards.forEach(card => setStatus(card, 'Running'));
    watch.timer = setTimeout(() => poll(watch), POLL_MS);
  } catch (_) {
    cards.forEach(card => setStatus(card, 'Status unavailable'));
    watch.timer = setTimeout(() => poll(watch), POLL_MS * 3);
  } finally { clearTimeout(timeout); }
}

export function appendSubagentCard(host, child) {
  const id = sessionId(child);
  if (!host || !id) return null;
  const existing = [...host.querySelectorAll('.subagent-card')].find(card => card.dataset.sessionId === id);
  if (existing) return existing;

  const card = document.createElement('div');
  card.className = 'subagent-card';
  card.dataset.sessionId = id;
  const link = document.createElement('a');
  link.className = 'subagent-card-link';
  link.href = `#session-${id}`;
  link.setAttribute('aria-label', `Open subagent chat: ${String(child.title || 'Subagent').slice(0, 160)}`);
  const icon = document.createElement('span');
  icon.className = 'subagent-card-icon';
  icon.textContent = '🤖';
  const title = document.createElement('span');
  title.className = 'subagent-card-title';
  title.textContent = String(child.title || 'Subagent').slice(0, 160);
  const status = document.createElement('span');
  status.className = 'subagent-card-status';
  status.setAttribute('aria-live', 'polite');
  status.textContent = 'Running';
  link.append(icon, title, status);
  card.append(link);
  host.append(card);

  let watch = cardsBySession.get(id);
  if (!watch) {
    watch = { id, cards: new Set(), timer: null };
    cardsBySession.set(id, watch);
  }
  watch.cards.add(card);
  if (!watch.timer) void poll(watch);
  return card;
}
