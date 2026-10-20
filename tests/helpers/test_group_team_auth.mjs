import fs from 'node:fs';
import assert from 'node:assert/strict';

const source = fs.readFileSync('static/js/groupTeam.js', 'utf8');
const { createGroupTeam } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const scenario = process.argv[2];
const calls = [];
globalThis.localStorage = { values: new Map(), getItem(key) { return this.values.get(key) ?? null; }, setItem(key, value) { this.values.set(key, value); } };
globalThis.fetch = async (url, options = {}) => {
  calls.push({ url: String(url), method: options.method || 'GET', body: options.body });
  if (String(url).endsWith('/api/groups/parent/team')) return { ok: true, json: async () => ({ board: {
    plan: '', participants: [{ id: 'builder', display: 'Builder', role: 'builder' }], tasks: []
  } }) };
  if (String(url).includes('/api/groups/parent/team/run') && (options.method || 'GET') === 'GET') {
    const run = String(url).includes('job_id=') ? { job_id: 'job-1', status: 'completed', state: { phase: 'completed' } } : null;
    return { ok: true, json: async () => ({ run }) };
  }
  if (String(url).includes('/api/groups/parent/team/run') && options.method === 'POST') return { ok: true, json: async () => ({ run: { job_id: 'job-1' } }) };
  throw new Error(`Unexpected synthetic request: ${url}`);
};
let contextCalls = 0;
const getRequestContext = () => {
  contextCalls++;
  if (scenario === 'unavailable' || (scenario === 'changed-before-post' && contextCalls > 1)) return null;
  if (scenario === 'valid-empty') return {};
  if (scenario === 'valid-captured') return { mode: 'agent', workspace: contextCalls === 1 ? '/captured-workspace' : '/later-workspace' };
  return { mode: 'agent', workspace: '/captured-workspace' };
};
const team = createGroupTeam({ apiBase: '', getParentSessionId: () => 'parent', getModels: () => [], getRequestContext });
await team.mount(null);
team.setEnabled(true);
team.setBoard({ plan: '', participants: [{ id: 'builder', display: 'Builder', role: 'builder' }], tasks: [
  { id: 'task-1', title: 'Synthetic task', owner_id: 'builder', reviewer_id: '', status: 'pending' }
] });
await team.runPass();
const posts = calls.filter(call => call.url.endsWith('/api/groups/parent/team/run') && call.method === 'POST');
if (scenario === 'valid-empty') {
  assert.equal(posts.length, 1, 'A verified empty workspace remains valid');
  assert.deepEqual(JSON.parse(posts[0].body).request_context, {});
} else if (scenario === 'valid-captured') {
  assert.equal(posts.length, 1);
  assert.deepEqual(JSON.parse(posts[0].body).request_context, { mode: 'agent', workspace: '/captured-workspace' });
} else if (scenario === 'changed-before-post') {
  assert.equal(contextCalls, 2);
  assert.equal(posts.length, 0, 'Identity change after save wait blocks the team POST');
} else {
  assert.equal(contextCalls, 1);
  assert.equal(posts.length, 0, 'Unavailable workspace context blocks the team POST');
}
console.log(JSON.stringify({ suite: 'production group team controller', scenario, posts: posts.length, passed: true }));
