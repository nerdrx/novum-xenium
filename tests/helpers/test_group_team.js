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
globalThis.fetch = async (url, options = {}) => {
  const id = decodeURIComponent(url.split('/').at(-2));
  if (options.method === 'PUT') {
    const board = JSON.parse(options.body).board;
    server.set(id, structuredClone(board));
    return { ok: true, json: async () => ({ board }) };
  }
  return { ok: true, json: async () => ({ board: server.get(id) || null }) };
};
const make = (runAssignment = async (...args) => { calls.push(args); return 'checked output'; }) =>
  createGroupTeam({ apiBase: '', getParentSessionId: () => 'parent-1', getModels: () => models, runAssignment });

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
  const team = make(async (...args) => { calls.push(args); return `Result for ${args[0]}`; });
  await team.mount(null);
  team.setEnabled(true);
  team.getBoard().plan = 'Shared goal';
  team.getBoard().tasks.push({ id: 't1', title: 'Task A', owner_id: 'builder-1',
    reviewer_id: 'reviewer-1', status: 'pending', work_result: '' });
  await team.runPass();
  assert.deepEqual(calls.map(call => [call[0], call[2]]), [['builder-1', false], ['reviewer-1', true]]);
  assert.match(calls[0][1], /Task A/);
  assert.match(calls[1][1], /Result for builder-1/);
  assert.equal(team.getBoard().tasks[0].status, 'awaiting_review');
  assert.equal(team.getBoard().tasks[0].status === 'done', false);
} else if (scenario === 'stop') {
  const team = make(async (...args) => { calls.push(args); return null; });
  await team.mount(null);
  team.setEnabled(true);
  team.getBoard().tasks.push(
    { id: 't1', title: 'Task A', owner_id: 'builder-1', reviewer_id: 'reviewer-1', status: 'pending', work_result: '' },
    { id: 't2', title: 'Task B', owner_id: 'builder-1', reviewer_id: 'reviewer-1', status: 'pending', work_result: '' },
  );
  await team.runPass();
  assert.equal(calls.length, 1, 'failed/stopped builder prevents later jobs and review');
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
  const team = make(async (...args) => { calls.push(args); return 'unexpected'; });
  await team.mount(null);
  team.setEnabled(true);
  team.getBoard().tasks.push({ id: 't1', title: 'Task A', owner_id: 'builder-1',
    reviewer_id: '', status: 'pending', work_result: '' });
  await team.runPass();
  assert.equal(calls.length, 0, 'no side effect begins until working state is durably saved');
  assert.equal(team.getBoard().tasks[0].status, 'working');
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
} else {
  throw new Error(`Unknown scenario: ${scenario}`);
}
