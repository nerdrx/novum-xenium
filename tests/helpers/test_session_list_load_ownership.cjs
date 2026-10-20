// Exercise production sessions.js against a loopback-only synthetic list API.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '../..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'novum-session-list-'));
const classList = () => ({ add() {}, remove() {}, contains() { return false; }, toggle() { return false; } });
const store = () => {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) };
};
const element = id => ({ id, style: {}, classList: classList(), value: '', disabled: false, innerHTML: '', addEventListener() {}, removeEventListener() {}, setAttribute() {}, getAttribute() { return null; }, appendChild() {}, insertBefore() {}, querySelector() { return null; }, querySelectorAll() { return []; }, contains() { return false; }, focus() {} });
const elements = new Map(['message', 'session-list', 'sessions-section', 'current-meta', 'chat-history'].map(id => [id, element(id)]));
const document = { body: element('body'), activeElement: null, getElementById: id => elements.get(id) || null, querySelector() { return null; }, querySelectorAll() { return []; }, createElement: element, createDocumentFragment: () => element('fragment'), addEventListener() {} };
const errors = [];
globalThis.document = document;
globalThis.localStorage = store();
globalThis.sessionStorage = store();
globalThis.sessionStorage.setItem('ody-session-active', '1');
Object.defineProperty(globalThis, 'navigator', { value: { platform: 'Linux' }, configurable: true });
globalThis.CustomEvent = class { constructor(type, options = {}) { this.type = type; this.detail = options.detail; } };
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};
globalThis.history = { replaceState() {}, pushState() {} };
globalThis.window = { document, innerWidth: 1024, innerHeight: 768, location: { hash: '', pathname: '/' }, addEventListener() {}, removeEventListener() {}, dispatchEvent() {}, chatModule: { detachCurrentStream() {}, showWelcomeScreen() {} } };
globalThis.location = window.location;
globalThis.__sessionErrors = errors;

const stubs = {
  'storage.mjs': `const Storage={KEYS:{},get:(k,f=null)=>localStorage.getItem(k)??f,set:(k,v)=>localStorage.setItem(k,v),remove:k=>localStorage.removeItem(k),getJSON:(k,f)=>{try{return JSON.parse(localStorage.getItem(k)??JSON.stringify(f))}catch{return f}},setJSON:(k,v)=>localStorage.setItem(k,JSON.stringify(v))};export default Storage;`,
  'ui.mjs': `export const autoResize=()=>{};export const styledPrompt=async()=>null;const ui={el:id=>document.getElementById(id),showError:m=>globalThis.__sessionErrors.push(String(m)),showToast(){},styledConfirm:async()=>true,scrollHistoryInstant(){}};export default ui;`,
  'chatRenderer.mjs': `export default {addMessage(){},hideWelcomeScreen(){}};`,
  'providers.mjs': `export const providerLogo=()=>'';`,
  'modelPicker.mjs': `export const initModelPicker=()=>{};export const updateModelPicker=()=>{};`,
  'theme.mjs': `export default {};`,
  'spinner.mjs': `export default {};`,
  'sessionHistory.mjs': `export const installSessionHistory=()=>()=>{};export const pendingChatRouteId=()=>'';export const setPendingChatHistory=()=>{};export const setSessionHistory=()=>{};`,
  'subagentInspector.mjs': `export const applySubagentInspector=()=>{};export const clearSubagentInspector=()=>{};`,
  'browserPreview.mjs': `export const resetBrowserPreview=()=>{};`,
  'composerDrafts.mjs': `export const deleteComposerDraft=()=>{};export const getComposerDraft=()=>'';export const getPendingChatMetadata=()=>null;export const saveComposerDraft=()=>({persisted:true});export const transferComposerDraft=()=>({persisted:true});`,
  'actionMenuOrder.mjs': `export const SELECT_MENU_ICON='';export const actionMenuRank=()=>0;export const orderActionMenuItems=items=>items;`,
  'escMenuStack.mjs': `export const registerEscapeLayer=()=>()=>{};export const bindMenuDismiss=()=>{};`,
  'authState.mjs': `const state={verified:true,switched:false,storageAvailable:true};export const getAuthState=async()=>state;export const getKnownAuthState=()=>state;`,
};

const plans = [];
const requests = [];
const server = http.createServer(async (_req, res) => {
  const plan = plans.shift();
  assert.ok(plan, 'fixture received an unplanned request');
  requests.push(plan.name);
  plan.seenResolve();
  if (plan.hold === 'fetch') await plan.released;
  res.writeHead(plan.status || 200, { 'content-type': 'application/json' });
  if (plan.hold === 'body') res.flushHeaders();
  if (plan.hold === 'body') await plan.released;
  res.end(JSON.stringify(plan.body));
  plan.finishedResolve();
});
const gate = (name, body, { status = 200, hold = '' } = {}) => {
  let seenResolve, releaseResolve, finishedResolve;
  const seen = new Promise(resolve => { seenResolve = resolve; });
  const released = new Promise(resolve => { releaseResolve = resolve; });
  const finished = new Promise(resolve => { finishedResolve = resolve; });
  const plan = { name, body, status, hold, seen, released, finished, seenResolve, release: releaseResolve, finishedResolve };
  plans.push(plan);
  return plan;
};
const sessionsList = sessions => sessions.map(id => ({ id, name: id, folder: 'Chat', archived: false }));

async function run() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  window.location.origin = origin;
  const source = fs.readFileSync(path.join(root, 'static/js/sessions.js'), 'utf8')
    .replace(/from (["'])(\.\/[^"']+)\.js(?:[?#][^"']*)?\1/g, (_m, quote, specifier) => `from ${quote}${specifier}.mjs${quote}`);
  fs.writeFileSync(path.join(temp, 'sessions.mjs'), source);
  for (const [name, body] of Object.entries(stubs)) fs.writeFileSync(path.join(temp, name), body);
  const sessions = await import(`${pathToFileURL(path.join(temp, 'sessions.mjs')).href}?ownership`);
  sessions.setCurrentSessionId('current');

  const heldFetch = gate('old-fetch', sessionsList(['current']), { hold: 'fetch' });
  const oldFetchLoad = sessions.loadSessions();
  await heldFetch.seen;
  const newFetch = gate('new-fetch', sessionsList(['current', 'fresh-fetch']));
  assert.equal(await sessions.loadSessions(), true);
  await newFetch.seen;
  heldFetch.release();
  assert.equal(await oldFetchLoad, true, 'superseded caller resolves with latest load result');
  assert.deepEqual(sessions.getSessions().map(item => item.id), ['current', 'fresh-fetch'], 'late old fetch cannot replace newer list');

  const heldBody = gate('old-body', sessionsList(['current']), { hold: 'body' });
  const oldBodyLoad = sessions.loadSessions();
  await heldBody.seen;
  const newBody = gate('new-body', sessionsList(['current', 'fresh-body']));
  assert.equal(await sessions.loadSessions(), true);
  await newBody.seen;
  heldBody.release();
  assert.equal(await oldBodyLoad, true, 'superseded body caller resolves with latest load result');
  assert.deepEqual(sessions.getSessions().map(item => item.id), ['current', 'fresh-body'], 'late old JSON body cannot replace newer list');

  const staleFailure = gate('old-error-body', { detail: 'obsolete fixture failure' }, { status: 503, hold: 'body' });
  const staleFailureLoad = sessions.loadSessions();
  await staleFailure.seen;
  const latestSuccess = gate('latest-success', sessionsList(['current', 'fresh-success']));
  assert.equal(await sessions.loadSessions(), true);
  await latestSuccess.seen;
  staleFailure.release();
  assert.equal(await staleFailureLoad, true, 'stale failure resolves with current successful load');
  assert.deepEqual(sessions.getSessions().map(item => item.id), ['current', 'fresh-success']);
  assert.deepEqual(errors, [], 'stale HTTP failure must not surface over newer success');

  const positive = gate('normal-success', sessionsList(['current', 'fresh-positive']));
  assert.equal(await sessions.loadSessions(), true);
  await positive.seen;
  assert.deepEqual(sessions.getSessions().map(item => item.id), ['current', 'fresh-positive']);

  const heldOld = gate('old-success-after-new-failure', sessionsList(['current', 'stale-after-failure']), { hold: 'body' });
  const oldBeforeFailure = sessions.loadSessions();
  await heldOld.seen;
  const newFailure = gate('new-failure', { detail: 'latest fixture failure' }, { status: 503 });
  const errorsBeforeNewFailure = errors.length;
  assert.equal(await sessions.loadSessions(), false, 'current newer failure retains the false result contract');
  await newFailure.seen;
  heldOld.release();
  assert.equal(await oldBeforeFailure, false, 'superseded caller adopts latest failure result');
  assert.deepEqual(sessions.getSessions().map(item => item.id), ['current', 'fresh-positive'], 'stale success cannot overwrite list after latest failure');
  assert.deepEqual(errors.slice(errorsBeforeNewFailure), ['Failed to load sessions: latest fixture failure'], 'stale completion must not add an obsolete error');

  const currentFailure = gate('current-failure', { detail: 'current fixture failure' }, { status: 503 });
  assert.equal(await sessions.loadSessions(), false, 'current HTTP failure keeps boolean failure contract');
  await currentFailure.seen;
  assert.match(errors.at(-1), /current fixture failure/);
  const retry = gate('retry-success', sessionsList(['current', 'after-retry']));
  assert.equal(await sessions.loadSessions(), true);
  await retry.seen;
  assert.deepEqual(sessions.getSessions().map(item => item.id), ['current', 'after-retry']);

  return { pass: true, requests, afterHeldFetch: ['current', 'fresh-fetch'], afterHeldBody: ['current', 'fresh-body'], afterStaleFailure: ['current', 'fresh-success'], positiveControl: ['current', 'fresh-positive'], supersededCallerAdoptsLatestFailure: true, staleSuccessAfterLatestFailureIgnored: true, currentFailureReturnedFalse: true, retry: ['current', 'after-retry'], errors };
}

run().then(result => process.stdout.write(`${JSON.stringify(result)}\n`)).catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  server.closeAllConnections?.();
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(temp, { recursive: true, force: true });
});
