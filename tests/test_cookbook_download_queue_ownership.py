"""Synthetic browser harness for Cookbook download queue ownership."""
import re
import shutil
import subprocess
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]


def _function(source, name, *, exported=False, async_=False):
    prefix = r"export\s+" if exported else ""
    prefix += r"async\s+" if async_ else ""
    match = re.search(
        rf"^{prefix}function\s+{re.escape(name)}\s*\(.*?^\}}",
        source, re.M | re.S,
    )
    assert match, f"could not extract {name}"
    return match.group(0).replace("export ", "", 1)


@pytest.fixture
def queue_harness_source():
    node = shutil.which("node")
    if not node:
        pytest.skip("Node.js is unavailable")
    download = (ROOT / "static/js/cookbookDownload.js").read_text(encoding="utf-8")
    running = (ROOT / "static/js/cookbookRunning.js").read_text(encoding="utf-8")
    recipe_const = re.search(r"const FLUX2_KLEIN_SHARED_COMPONENTS = \[.*?^\];", download, re.M | re.S)
    assert recipe_const
    functions = [
        recipe_const.group(0),
        _function(download, "flux2KleinDownloadRecipe", exported=True),
        _function(download, "downloadFlux2KleinBundle", exported=True, async_=True),
        _function(download, "_newDownloadQueueId"),
        _function(download, "_queuedDownloadTask"),
        _function(download, "_runModelDownload", exported=True, async_=True),
        _function(running, "_processQueue"),
        _function(running, "_startQueuedDownload", async_=True),
        _function(running, "_downloadRepoKey"),
        _function(running, "_downloadHostKey"),
        _function(running, "_downloadDedupeKey"),
        _function(running, "_pruneQueuedDownloadDuplicates"),
        _function(running, "_loadPrunedTasks"),
    ]
    return node, "\n".join(functions)


def _run_harness(queue_harness_source, assertions):
    node, functions = queue_harness_source
    setup = r"""
let state = [];
const tombstones = new Set();
const requests = [];
const shellCommands = [];
const toasts = [];
let now = 1000;
Date.now = () => now;
const localStorage = { getItem: () => null, setItem() {} };
const _envState = { hfToken: 'hf_SYNTHETIC_ONLY', servers: [], env: 'none', envPath: '', platform: '' };
const uiModule = { showToast: m => toasts.push(m), showError() {} };
const window = { cookbookModule: { _serverKey: srv => srv.name } };
const document = { getElementById: () => null, querySelector: () => null };
const _loadTasks = () => JSON.parse(JSON.stringify(state));
const _saveTasks = tasks => {
  state = JSON.parse(JSON.stringify(tasks)).map(t => {
    if (t.payload) delete t.payload.hf_token;
    return t;
  });
};
const _updateTask = (id, updates) => {
  const task = state.find(t => t.sessionId === id);
  if (task) Object.assign(task, updates);
};
const _renderRunningTab = () => {};
const _startBackgroundMonitor = () => {};
const _isTombstoned = id => tombstones.has(id);
const _tombstoneTask = id => tombstones.add(id);
let _startQueuedDownload;
let _processQueue;
let _downloadQueueSequence = 0;
const _tmuxCmd = (task, args) => {
  if (!/^cookbook-[a-f0-9]{8}$/.test(task.sessionId)) throw new Error('unsafe session ID reached shell builder');
  return `tmux ${args} --host=${task.remoteHost || 'local'} --port=${task.sshPort || '22'} --platform=${task.platform || 'linux'}`;
};
const _fetchWithTimeout = (url, init) => {
  if (url === '/api/shell/exec') {
    shellCommands.push(JSON.parse(init.body).command);
    return Promise.resolve({ok:true, json:async()=>({exit_code:0})});
  }
  if (url !== '/api/model/download') throw new Error(`unexpected request ${url}`);
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  requests.push({ payload: JSON.parse(init.body), resolve });
  return promise;
};
const _fetchDownloadControlWithTimeout = async () => ({json:async()=>({exit_code:1})});
const _fetch = _fetchWithTimeout;
const _loadTasksNoPrune = _loadTasks;
const _serverByVal = key => key === 'x' ? {host:'host-x',name:'X',port:'2201',platform:'linux'}
  : key === 'y' ? {host:'host-y',name:'Y',port:'2202',platform:'linux'} : null;
const _getPort = () => '22';
const _getPlatform = () => 'linux';
const _isWindows = () => false;
const _psQuote = s => s;
const _downloadTaskName = name => name;
const _ggufDownloadSource = () => null;
const _ggufIncludePattern = () => '';
const _missingGgufMessage = () => '';
const _syncEnvFromPanel = () => {};
const _addTask = () => { throw new Error('legacy _addTask path must not run'); };
const _redactTaskForStorage = t => t;
"""
    functions = functions.replace(
        "async function _startQueuedDownload(", "async function _startQueuedDownload_impl(", 1,
    ).replace("function _processQueue(", "function _processQueue_impl(", 1)
    script = setup + "\n" + functions + "\n" + r"""
_startQueuedDownload = _startQueuedDownload_impl;
_processQueue = _processQueue_impl;
""" + assertions
    result = subprocess.run([node, "--input-type=module", "-e", script],
                            capture_output=True, text=True, timeout=25)
    assert result.returncode == 0, result.stderr


def test_downloads_reserve_host_synchronously_and_parallelize_other_hosts(queue_harness_source):
    _run_harness(queue_harness_source, r"""
const panel = {querySelectorAll:()=>[]};
const first = _runModelDownload(panel, {name:'org/A'}, 'huggingface', 'x');
await new Promise(r=>setTimeout(r,0));
if (requests.length !== 1) throw new Error(`first same-host request did not start: ${JSON.stringify({state,toasts})}`);
if (state[0].status !== 'running' || !state[0]._startLaunched) throw new Error('host was not reserved before POST resolved');
if (requests[0].payload.hf_token !== 'hf_SYNTHETIC_ONLY') throw new Error('current token missing from request');
if (JSON.stringify(state).includes('hf_SYNTHETIC_ONLY')) throw new Error('token was persisted');
await _runModelDownload(panel, {name:'org/B'}, 'huggingface', 'x');
await _runModelDownload(panel, {name:'org/A'}, 'huggingface', 'x');
if (requests.length !== 1) throw new Error('same host or duplicate model bypassed queue');
const queued = state.filter(t=>t.status==='queued');
if (queued.length !== 1 || queued[0].payload.repo_id !== 'org/B') throw new Error('second model was not queued once');
const parallel = _runModelDownload(panel, {name:'org/C'}, 'huggingface', 'y');
await Promise.resolve();
if (requests.length !== 2 || requests[1]?.payload.remote_host !== 'host-y') throw new Error(`different host did not start in parallel: ${JSON.stringify(requests.map(r=>r.payload))}`);
requests[0].resolve({ok:true,json:async()=>({ok:true,session_id:'cookbook-aaaa0001'})});
requests[1].resolve({ok:true,json:async()=>({ok:true,session_id:'cookbook-bbbb0002'})});
await Promise.all([first, parallel]);
state.find(t=>t.sessionId==='cookbook-aaaa0001').status = 'done';
_processQueue_impl();
await Promise.resolve();
if (requests.length !== 3 || requests[2].payload.repo_id !== 'org/B') throw new Error('queued same-host task did not start after release');
requests[2].resolve({ok:true,json:async()=>({ok:true,session_id:'cookbook-cccc0003'})});
await new Promise(r=>setTimeout(r,0));
""")


def test_queue_ids_and_includes_are_collision_safe_and_distinct(queue_harness_source):
    _run_harness(queue_harness_source, r"""
const one = _queuedDownloadTask([], 'first', {repo_id:'org/A'}, 'host-x');
const two = _queuedDownloadTask([one], 'second', {repo_id:'org/B'}, 'host-x');
if (one.sessionId === two.sessionId) throw new Error('same-millisecond queue IDs collided');
const componentA = {type:'download',status:'queued',remoteHost:'host-x',payload:{repo_id:'org/shared',include:'encoder.safetensors'}};
const componentB = {type:'download',status:'queued',remoteHost:'host-x',payload:{repo_id:'org/shared',include:'vae.safetensors'}};
const duplicateA = {...componentA,sessionId:'duplicate'};
const pruned = _pruneQueuedDownloadDuplicates([componentA, componentB, duplicateA]);
if (pruned.length !== 2 || !pruned.some(t=>t.payload.include==='encoder.safetensors') || !pruned.some(t=>t.payload.include==='vae.safetensors')) {
  throw new Error('explicit same-repo files were pruned or exact duplicate retained');
}
""")


def test_klein_bundle_same_repo_components_run_sequentially(queue_harness_source):
    _run_harness(queue_harness_source, r"""
const panel = {querySelectorAll:()=>[]};
const bundle = downloadFlux2KleinBundle(panel, 'klein4b', 'x');
await Promise.resolve();
if (requests.length !== 1) throw new Error('bundle first component did not start');
requests[0].resolve({ok:true,json:async()=>({ok:true,session_id:'cookbook-aaaa0001'})});
await new Promise(r=>setTimeout(r,0));
await bundle;
const pending = state.filter(t=>t.status==='queued');
if (pending.length !== 2 || pending[0].payload.repo_id !== pending[1].payload.repo_id
    || pending[0].payload.include === pending[1].payload.include) throw new Error('Klein same-repo components were not retained separately');
state.find(t=>t.sessionId==='cookbook-aaaa0001').status='done';
_processQueue_impl();
await Promise.resolve();
if (requests.length !== 2) throw new Error('first shared component did not start');
const firstInclude=requests[1].payload.include;
requests[1].resolve({ok:true,json:async()=>({ok:true,session_id:'cookbook-bbbb0002'})});
await new Promise(r=>setTimeout(r,0));
state.find(t=>t.sessionId==='cookbook-bbbb0002').status='done';
_processQueue_impl();
await Promise.resolve();
if (requests.length !== 3 || requests[2].payload.include === firstInclude) throw new Error('second distinct shared component was lost');
requests[2].resolve({ok:true,json:async()=>({ok:true,session_id:'cookbook-cccc0003'})});
await new Promise(r=>setTimeout(r,0));
""")


def test_pending_removed_download_cleans_only_returned_session_and_rejects_unsafe_id(queue_harness_source):
    _run_harness(queue_harness_source, r"""
const panel = {querySelectorAll:()=>[]};
const start = _runModelDownload(panel, {name:'org/A'}, 'huggingface', 'x');
await Promise.resolve();
const placeholder = state[0].sessionId;
tombstones.add(placeholder); // same synchronous intent marker used by the Remove action
state.push({sessionId:'unrelated',id:'unrelated',type:'download',status:'running',payload:{repo_id:'org/other'},remoteHost:'host-x'});
state = state.filter(t=>t.sessionId!==placeholder);
Object.assign(_envState, {remoteHost:'host-y', port:'9900', platform:'windows'});
requests[0].resolve({ok:true,json:async()=>({ok:true,session_id:'cookbook-dddd0004'})});
await start;
if (state.some(t=>t.sessionId==='cookbook-dddd0004' || t.sessionId===placeholder)) throw new Error('user-removed start was resurrected');
if (!state.some(t=>t.sessionId==='unrelated')) throw new Error('cleanup changed an unrelated task');
if (!tombstones.has('cookbook-dddd0004')) throw new Error('returned server session lacks tombstone');
if (shellCommands.length!==1 || !shellCommands[0].includes('cookbook-dddd0004') || shellCommands[0].includes('unrelated')) throw new Error('cleanup did not target only returned session');
if (!shellCommands[0].includes('--host=host-x --port=2201 --platform=linux')) throw new Error(`cleanup lost captured target host metadata: ${shellCommands[0]}`);
state=[]; requests.length=0; shellCommands.length=0;
const unsafe = _runModelDownload(panel, {name:'org/B'}, 'huggingface', 'x');
await Promise.resolve();
requests[0].resolve({ok:true,json:async()=>({ok:true,session_id:'bad; tmux kill-session'})});
await unsafe;
if (shellCommands.length) throw new Error('unsafe server session ID reached shell execution');
if (state[0]?.status !== 'error') throw new Error('unsafe response was not surfaced as a failed start');
state=[]; requests.length=0; shellCommands.length=0;
const adopted = _runModelDownload(panel, {name:'org/C'}, 'huggingface', 'x');
await Promise.resolve();
const missingId = state[0].sessionId;
state = state.filter(t=>t.sessionId!==missingId); // no explicit user tombstone
requests[0].resolve({ok:true,json:async()=>({ok:true,session_id:'cookbook-ffff0006'})});
await adopted;
if (!state.some(t=>t.sessionId==='cookbook-ffff0006')) throw new Error('ordinary missing placeholder no longer adopts returned session');
""")


def test_pending_queue_remove_tombstones_before_async_kill():
    source = (ROOT / "static/js/cookbookRunning.js").read_text(encoding="utf-8")
    handler = source.split("el.querySelector('.cookbook-task-action-kill').addEventListener('click', async () => {", 1)[1]
    marker = handler.index("_tombstoneTask(task.sessionId);")
    first_await = handler.index("await ")
    assert marker < first_await
    assert "String(task.sessionId || '').startsWith('queue-')" in handler[:marker]
    remover = source.split("function _animateOutThenRemove(el, sessionId) {", 1)[1].split("\n}", 1)[0]
    assert remover.index("_tombstoneTask(sessionId);") < remover.index("setTimeout(")


def test_failed_start_releases_host_for_next_queued_download(queue_harness_source):
    _run_harness(queue_harness_source, r"""
const panel = {querySelectorAll:()=>[]};
const first = _runModelDownload(panel, {name:'org/A'}, 'huggingface', 'x');
await Promise.resolve();
await _runModelDownload(panel, {name:'org/B'}, 'huggingface', 'x');
requests[0].resolve({ok:true,json:async()=>({ok:false,error:'synthetic failure'})});
await first;
await Promise.resolve();
if (requests.length !== 2 || requests[1].payload.repo_id !== 'org/B') throw new Error('failed start did not release host to queued task');
requests[1].resolve({ok:true,json:async()=>({ok:true,session_id:'cookbook-eeee0005'})});
await new Promise(r=>setTimeout(r,0));
""")
