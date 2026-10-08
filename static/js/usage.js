/* Local, per-account usage. No provider quota or billing estimates. */
let days = 7;
let callbacks = {};
let initialized = false;
let request = null;
let generation = 0;
const cache = new Map();
const number = value => new Intl.NumberFormat().format(Number(value) || 0);
const compact = value => new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(Number(value) || 0);
const dateLabel = value => {
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isNaN(date.getTime()) ? String(value || '') : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
};
function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = String(text);
  return element;
}
function button(text, action, className = 'usage-button') {
  const element = node('button', className, text);
  element.type = 'button';
  element.addEventListener('click', action);
  return element;
}
function card(label, value, detail) {
  const element = node('div', 'usage-stat');
  element.append(node('span', 'usage-label', label), node('strong', 'usage-value', value));
  if (detail) element.append(node('span', 'usage-detail', detail));
  return element;
}
function stats(data, home = false) {
  const totals = data.totals;
  const group = node('div', 'usage-stats');
  const tokenCount = totals.measured_messages + totals.estimated_messages + (totals.unknown_metrics_messages || 0);
  group.append(card('Chats', number(totals.sessions)), card('Messages', number(totals.messages)),
    card('Recorded tokens', tokenCount ? compact(totals.total_tokens) : 'Unavailable', tokenCount ? `${number(totals.input_tokens)} in · ${number(totals.output_tokens)} out` : 'No token metadata saved'),
    card(home ? 'Active days' : 'Replies', number(home ? data.insights.active_days : totals.assistant_messages), home ? `of ${data.days} days` : `${number(totals.failed_messages)} failed`));
  if (totals.missing_metrics_messages) group.children[2].append(node('span', 'usage-detail', `${number(totals.missing_metrics_messages)} replies lack token metadata`));
  if (totals.estimated_messages) group.children[2].append(node('span', 'usage-detail', 'Includes estimated tokens'));
  return group;
}
function chart(data, small = false) {
  const section = node('section', 'usage-chart-card');
  section.append(node('h3', '', small ? 'This week' : 'Daily activity'));
  if (!small) section.append(node('p', 'usage-detail', `${dateLabel(data.start_date)} – ${dateLabel(data.end_date)} · UTC · messages sent and received`));
  const bars = node('div', `usage-chart${small ? ' usage-chart-small' : ''}`);
  bars.dataset.days = data.days;
  bars.setAttribute('role', 'list');
  bars.setAttribute('aria-label', 'Messages per day');
  const max = Math.max(1, ...data.daily.map(day => day.messages));
  data.daily.forEach((day, index) => {
    const item = node('div', 'usage-chart-day');
    item.setAttribute('role', 'listitem');
    item.tabIndex = 0;
    item.setAttribute('aria-label', `${dateLabel(day.date)}: ${number(day.messages)} messages, ${number(day.total_tokens)} recorded tokens`);
    item.title = `${dateLabel(day.date)} · ${number(day.messages)} messages · ${number(day.total_tokens)} recorded tokens`;
    const track = node('div', 'usage-chart-track');
    const bar = node('span', `usage-chart-bar${day.messages ? '' : ' usage-chart-zero'}`);
    bar.style.height = `${day.messages ? Math.max(3, day.messages / max * 100) : 2}%`;
    track.append(bar);
    const label = node('span', 'usage-chart-label', data.days === 7 || index % 5 === 0 || index === data.daily.length - 1 ? dateLabel(day.date) : '');
    label.setAttribute('aria-hidden', 'true');
    const tooltip = node('span', 'usage-chart-tooltip', item.title);
    tooltip.setAttribute('aria-hidden', 'true');
    item.append(track, label, tooltip);
    bars.append(item);
  });
  section.append(bars);
  if (!data.totals.messages) section.append(node('p', 'usage-empty', 'No activity in this period. Start a chat and it will appear here.'));
  return section;
}
function analytics(data) {
  const panel = document.getElementById('usage-panel');
  if (!panel) return;
  const restoreFocus = panel.contains(document.activeElement) && document.activeElement.dataset.usageDays;
  panel.replaceChildren();
  const heading = node('div', 'usage-heading');
  const title = node('div');
  title.append(node('h2', '', 'Usage'), node('p', 'usage-detail', 'Your activity in this workspace.'));
  const range = node('div', 'usage-range');
  range.setAttribute('role', 'group');
  range.setAttribute('aria-label', 'Usage period');
  [7, 30].forEach(value => {
    const control = button(`${value} days`, () => { days = value; refreshUsage(); });
    control.dataset.usageDays = value;
    control.setAttribute('aria-pressed', String(days === value));
    range.append(control);
  });
  heading.append(title, range);
  panel.append(heading, stats(data), chart(data));
  const section = node('section', 'usage-chart-card');
  section.append(node('h3', '', 'By model'));
  if (!data.models.length) section.append(node('p', 'usage-empty', 'No model activity recorded yet.'));
  else {
    const wrap = node('div', 'usage-table-wrap');
    const table = node('table', 'usage-table');
    table.append(node('caption', 'a11y-visually-hidden', 'Usage by model during the selected period'));
    const header = node('tr');
    ['Model', 'Replies', 'Input tokens', 'Output tokens'].forEach(text => { const th = node('th', '', text); th.scope = 'col'; header.append(th); });
    const head = node('thead'); head.append(header); table.append(head);
    const body = node('tbody');
    data.models.forEach(model => {
      const row = node('tr');
      const name = node('th', '', model.model || 'Unknown model'); name.scope = 'row'; row.append(name);
      const hasTokens = model.measured_messages + model.estimated_messages + (model.unknown_metrics_messages || 0) > 0;
      row.append(node('td', '', number(model.assistant_messages)));
      [model.input_tokens, model.output_tokens].forEach(value => row.append(node('td', '', hasTokens ? number(value) : 'Unavailable')));
      body.append(row);
    });
    table.append(body); wrap.append(table); section.append(wrap);
  }
  panel.append(section);
  const coverage = node('section', 'usage-coverage');
  coverage.append(node('h3', '', 'About these numbers'), node('p', 'usage-detail', data.coverage?.note || 'Usage is calculated from saved chats for your account.'));
  coverage.append(node('p', 'usage-detail', `${number(data.totals.measured_messages)} replies with measured tokens · ${number(data.totals.estimated_messages)} estimated · ${number(data.totals.unknown_metrics_messages)} with unspecified token source · ${number(data.totals.missing_metrics_messages)} without token metadata.`));
  coverage.append(node('p', 'usage-detail', 'Provider subscription limits and credits are not included.'));
  panel.append(coverage);
  if (restoreFocus) panel.querySelector(`[data-usage-days="${days}"]`)?.focus();
}
function dashboard(data) {
  const home = document.getElementById('home-dashboard');
  if (!home) return;
  home.replaceChildren();
  const heading = node('div', 'usage-heading');
  heading.append(node('h2', '', 'Your week'));
  if (callbacks.openAnalytics) heading.append(button('View usage', callbacks.openAnalytics));
  home.append(heading, stats(data, true));
  const columns = node('div', 'usage-home-columns');
  columns.append(chart(data, true));
  const insights = node('section', 'usage-chart-card usage-insights');
  insights.append(node('h3', '', 'A few numbers'));
  const list = node('dl', 'usage-facts');
  const facts = [
    ['Chat streak', `${number(data.insights.streak_days)} day${data.insights.streak_days === 1 ? '' : 's'}`],
    ['Most used model', data.insights.favourite_model || 'No favourite yet'],
    ['Busiest day', data.insights.busiest_day ? `${dateLabel(data.insights.busiest_day.date)} · ${number(data.insights.busiest_day.messages)} messages` : 'No activity yet'],
  ];
  if (Number.isFinite(data.insights.words_written)) facts.push(['Words you wrote', number(data.insights.words_written)]);
  facts.forEach(([label, value]) => { list.append(node('dt', '', label), node('dd', '', value)); });
  insights.append(list); columns.append(insights); home.append(columns);
  const recent = node('section', 'usage-recent');
  recent.append(node('h3', '', 'Pick up where you left off'));
  if (!data.recent_sessions.length) recent.append(node('p', 'usage-empty', 'Your recent chats will appear here.'));
  else {
    const chats = node('div', 'usage-recent-list');
    data.recent_sessions.forEach(chat => {
      const link = button('', () => callbacks.openChat?.(chat.id), 'usage-recent-chat');
      if (!callbacks.openChat) link.disabled = true;
      link.append(node('span', 'usage-recent-name', chat.name || 'Untitled chat'), node('span', 'usage-detail', `${number(chat.message_count)} messages`));
      chats.append(link);
    });
    recent.append(chats);
  }
  home.append(recent);
}
function message(target, text, retry = false) {
  if (!target) return;
  target.replaceChildren();
  const status = node('p', 'usage-empty', text);
  status.setAttribute('role', retry ? 'alert' : 'status');
  target.append(status);
  if (retry) target.append(button('Try again', () => refreshUsage({ force: true })));
}
async function load(period, force) {
  const stored = cache.get(period);
  if (!force && stored && Date.now() - stored.time < 30000) return stored.data;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(`/api/usage?days=${period}`, { credentials: 'same-origin', signal: controller.signal });
    if (!response.ok) throw new Error(response.status === 401 ? 'Sign in again to view your usage.' : `Usage could not load (HTTP ${response.status}).`);
    const data = await response.json();
    if (!data.totals || !Array.isArray(data.daily) || !Array.isArray(data.models) || !Array.isArray(data.recent_sessions) || !data.insights) throw new Error('Usage returned an incomplete response.');
    cache.set(period, { data, time: Date.now() });
    return data;
  } finally { clearTimeout(timeout); }
}
export async function refreshUsage({ force = false } = {}) {
  if (!document.getElementById('usage-panel') && !document.getElementById('home-dashboard')) return;
  if (request && !force && request.days === days) return request.promise;
  const current = ++generation;
  const selectedDays = days;
  const panel = document.getElementById('usage-panel');
  const home = document.getElementById('home-dashboard');
  if (!panel?.children.length) message(panel, 'Loading usage…');
  if (!home?.children.length) message(home, 'Loading your workspace…');
  panel?.setAttribute('aria-busy', 'true'); home?.setAttribute('aria-busy', 'true');
  const promise = (async () => {
    try {
      const [detail, weekly] = await Promise.all([load(selectedDays, force), selectedDays === 7 ? null : load(7, force)]);
      if (current !== generation) return;
      analytics(detail); dashboard(weekly || detail);
    } catch (error) {
      if (current !== generation) return;
      const text = error.name === 'AbortError' ? 'Usage took too long to load. Try again in a moment.' : error.message;
      message(panel, text, true); message(home, text, true);
    } finally {
      if (current === generation) { panel?.removeAttribute('aria-busy'); home?.removeAttribute('aria-busy'); request = null; }
    }
  })();
  request = { days: selectedDays, promise };
  return promise;
}
export function initUsage(options = {}) {
  callbacks = options;
  if (initialized) return refreshUsage();
  initialized = true;
  return refreshUsage();
}
