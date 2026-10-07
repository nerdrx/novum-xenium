import assert from 'node:assert/strict';
import { newTeamBoard, buildWorkPrompt, buildReviewPrompt, createGroupTeam } from '../../static/js/groupTeam.js';

const scenario = process.argv[2];
const storage = new Map();
globalThis.localStorage = {
  getItem: key => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, String(value)),
};
const models = [
  { mid: 'builder-1', display: 'Builder One' },
  { mid: 'reviewer-1', display: 'Reviewer One' },
];
const server = new Map();
const calls = [];
const jobs = new Map();
let runCount = 0;
let parentId = 'parent-1';
const pendingLoads = new Map();
globalThis.fetch = async (url, options = {}) => {
  const parts = new URL(url, 'http://local').pathname.split('/').filter(Boolean);
  const id = decodeURIComponent(parts.at(-1) === 'run' || parts.at(-1) === 'stop' ? parts.at(-3) : parts.at(-2));
  if (parts.at(-2) === 'team' && parts.at(-1) === 'run' && options.method === 'POST') {
    const body = JSON.parse(options.body);
    calls.push(body);
    const job_id = `job-${++runCount}`;
    if (scenario === 'stop' && runCount === 1) {
      body.board.tasks[0].status = 'working';
      server.set(id, structuredClone(body.board));
      jobs.set(job_id, { status: 'running', state: {} });
    } else {
      body.board.tasks = body.board.tasks.map(task => task.status === 'pending' ? {
        ...task, status: 'awaiting_review', work_result: 'checked output', review_result: 'reviewed output',
      } : task);
      server.set(id, structuredClone(body.board));
      jobs.set(job_id, { status: 'completed', state: { message: 'done' } });
    }
    return { ok: true, json: async () => ({ run: { job_id, status: jobs.get(job_id).status } }) };
  }
  if (parts.at(-1) === 'stop' && options.method === 'POST') {
    const { job_id } = JSON.parse(options.body);
    jobs.set(job_id, { status: 'stopped', state: { message: 'stopped' } });
    return { ok: true, json: async () => ({ stopped: true }) };
  }
  if (parts.at(-1) === 'run') {
    const job = jobs.get(new URL(url, 'http://local').searchParams.get('job_id'));
    return { ok: true, json: async () => ({ run: job ? { job_id: 'job', ...job } : null }) };
  }
  if (options.method === 'PUT') {
    const board = JSON.parse(options.body).board;
    server.set(id, structuredClone(board));
    return { ok: true, json: async () => ({ board }) };
  }
  if (scenario === 'load-race') return new Promise(resolve => pendingLoads.set(id, resolve));
  return { ok: true, json: async () => ({ board: server.get(id) || null }) };
};
const make = (runAssignment = async (...args) => { calls.push(args); return 'checked output'; }) =>
  createGroupTeam({ apiBase: '', getParentSessionId: () => parentId, getModels: () => models,
    getParticipantSessions: () => ({ 'builder-1': 'session-b', 'reviewer-1': 'session-r' }), runAssignment });

if (scenario === 'prompts') {
  const board = newTeamBoard(models);
  const task = { title: 'Implement item A', work_result: 'Changed file A' };
  const work = buildWorkPrompt(board, task);
  const review = buildReviewPrompt(board, task);
  assert.match(work, /Implement item A/);
  assert.doesNotMatch(work, /item B/);
  assert.match(work, /only builder assigned/);
  assert.match(review, /Changed file A/);
  assert.match(review, /Do not edit files/);
  assert.match(review, /Do not edit files, run mutating tools, or mark this task done/);
} else if (scenario === 'persistence') {
  const first = make();
  await first.mount(null);
  first.setEnabled(true);
  const board = first.getBoard();
  board.plan = 'Ship the requested feature';
  board.tasks.push({ id: 't1', title: 'Implement item A', owner_id: 'builder-1',
    reviewer_id: 'reviewer-1', status: 'pending', work_result: '' });
  await first.save();
  const restored = make();
  await restored.mount(null);
  assert.equal(restored.getBoard().plan, board.plan);
  assert.equal(restored.getBoard().tasks[0].owner_id, 'builder-1');
  assert.equal(restored.getBoard().tasks[0].reviewer_id, 'reviewer-1');
  assert.equal(restored.enabled, true);
} else if (scenario === 'ownership') {
  const team = make();
  await team.mount(null);
  team.setEnabled(true);
  team.getBoard().plan = 'Shared goal';
  team.getBoard().tasks.push({ id: 't1', title: 'Task A', owner_id: 'builder-1',
    reviewer_id: 'reviewer-1', status: 'pending', work_result: '' });
  await team.runPass();
  assert.deepEqual(calls[0].participant_sessions, { 'builder-1': 'session-b', 'reviewer-1': 'session-r' });
  assert.equal(calls[0].board.tasks[0].title, 'Task A');
  assert.equal(team.getBoard().tasks[0].status, 'awaiting_review');
  assert.equal(team.getBoard().tasks[0].review_result, 'reviewed output');
  assert.equal(team.getBoard().tasks[0].status === 'done', false);
} else if (scenario === 'stop') {
  const team = make();
  await team.mount(null);
  team.setEnabled(true);
  team.getBoard().tasks.push(
    { id: 't1', title: 'Task A', owner_id: 'builder-1', reviewer_id: 'reviewer-1', status: 'pending', work_result: '' },
    { id: 't2', title: 'Task B', owner_id: 'builder-1', reviewer_id: 'reviewer-1', status: 'pending', work_result: '' },
  );
  const run = team.runPass();
  await new Promise(resolve => setTimeout(resolve, 0));
  await team.stopRun();
  await run;
  assert.equal(calls.length, 1, 'one server job owns the pass');
  assert.equal(team.getBoard().tasks[0].status, 'working');
  assert.equal(team.getBoard().tasks[1].status, 'pending');
  await team.runPass();
  assert.equal(calls.length, 1, 'refresh/re-entry never automatically retries a working task');
  assert.equal(await team.retryTask('t1'), true);
  assert.equal(team.getBoard().tasks[0].status, 'pending');
  await team.runPass();
  assert.equal(calls.length, 2, 'work repeats only after explicit human retry');
} else if (scenario === 'save-fail') {
  globalThis.fetch = async () => ({ ok: false, status: 500 });
  const team = make();
  await team.mount(null);
  team.setEnabled(true);
  team.getBoard().tasks.push({ id: 't1', title: 'Task A', owner_id: 'builder-1',
    reviewer_id: '', status: 'pending', work_result: '' });
  await team.runPass();
  assert.equal(calls.length, 0, 'failed start does not create a client-side assignment');
  assert.equal(team.getBoard().tasks[0].status, 'pending');
} else if (scenario === 'save-order') {
  const team = make();
  await team.mount(null);
  const originalFetch = globalThis.fetch;
  const requests = [];
  let release;
  globalThis.fetch = async (url, options = {}) => {
    if (options.method !== 'PUT') return originalFetch(url, options);
    requests.push(JSON.parse(options.body).board.plan);
    if (requests.length === 1) await new Promise(resolve => { release = resolve; });
    const board = JSON.parse(options.body).board;
    server.set('parent-1', structuredClone(board));
    return { ok: true, json: async () => ({ board }) };
  };
  team.getBoard().plan = 'first';
  const first = team.save();
  team.getBoard().plan = 'second';
  const second = team.save();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(requests, ['first'], 'concurrent PUTs are serialized');
  release();
  await Promise.all([first, second]);
  assert.deepEqual(requests, ['first', 'second']);
  assert.equal(server.get('parent-1').plan, 'second');
} else if (scenario === 'load-race') {
  const team = make();
  parentId = 'parent-A';
  const loadingA = team.mount(null);
  parentId = 'parent-B';
  const loadingB = team.mount(null);
  pendingLoads.get('parent-B')({ ok: true, json: async () => ({ board: { plan: 'Board B', participants: [], tasks: [] } }) });
  await loadingB;
  pendingLoads.get('parent-A')({ ok: true, json: async () => ({ board: { plan: 'Board A', participants: [], tasks: [] } }) });
  await loadingA;
  assert.equal(team.getBoard().plan, 'Board B', 'late board A response must not replace selected board B');
} else {
  throw new Error(`Unknown scenario: ${scenario}`);
}
