"""Exercise sessions.js and startupShell.js together at the bootstrap seam.

The dependency-heavy session module is copied unchanged except for redirecting
its static imports to tiny browser stubs. The real loadSessions implementation
and the real startup-shell coordinator then run together under Node.
"""

import json
import re
import shutil
import subprocess
from pathlib import Path

import pytest


_REPO = Path(__file__).resolve().parent.parent
_SESSIONS = _REPO / "static" / "js" / "sessions.js"
_SHELL_URL = (_REPO / "static" / "js" / "startupShell.js").as_uri()
_HAS_NODE = shutil.which("node") is not None

_IMPORT_REWRITES = {
    "import { installSessionHistory, pendingChatRouteId, setPendingChatHistory, setSessionHistory } from './sessionHistory.js';": (
        "import { installSessionHistory, pendingChatRouteId, setPendingChatHistory, setSessionHistory } from './sessionHistory.mjs';"
    ),
    "import { applySubagentInspector, clearSubagentInspector } from './subagentInspector.js';": (
        "import { applySubagentInspector, clearSubagentInspector } from './subagentInspector.mjs';"
    ),
    "import { resetBrowserPreview } from './browserPreview.js';": (
        "import { resetBrowserPreview } from './browserPreview.mjs';"
    ),
    "import { deleteComposerDraft, getComposerDraft, getPendingChatMetadata, saveComposerDraft, transferComposerDraft } from './composerDrafts.js';": (
        "import { deleteComposerDraft, getComposerDraft, getPendingChatMetadata, saveComposerDraft, transferComposerDraft } from './composerDrafts.mjs';"
    ),
}

_STUBS = {
    "storage.mjs": r"""
const Storage = {
  get: (key, fallback = null) => localStorage.getItem(key) ?? fallback,
  set: (key, value) => localStorage.setItem(key, value),
  remove: (key) => localStorage.removeItem(key),
  getJSON: (key, fallback) => {
    try { return JSON.parse(localStorage.getItem(key) ?? JSON.stringify(fallback)); }
    catch (_) { return fallback; }
  },
  setJSON: (key, value) => localStorage.setItem(key, JSON.stringify(value)),
};
export default Storage;
""",
    "ui.mjs": r"""
export const autoResize = () => {};
export const styledPrompt = async () => null;
const ui = {
  el: (id) => document.getElementById(id),
  showError: (message) => globalThis.__sessionErrors.push(String(message)),
  showToast: () => {},
  styledConfirm: async () => true,
  scrollHistoryInstant: () => {},
};
export default ui;
""",
    "chatRenderer.mjs": (
        "export default { addMessage: () => null, hideWelcomeScreen: () => {} };\n"
    ),
    "providers.mjs": "export const providerLogo = () => '';\n",
    "modelPicker.mjs": (
        "export const initModelPicker = () => {};\n"
        "export const updateModelPicker = () => {};\n"
    ),
    "sessionHistory.mjs": (
        "export const installSessionHistory = () => () => {};\n"
        "export const pendingChatRouteId = () => '';\n"
        "export const setPendingChatHistory = () => {};\n"
        "export const setSessionHistory = () => {};\n"
    ),
    "composerDrafts.mjs": (
        "export const deleteComposerDraft = () => {};\n"
        "export const getComposerDraft = () => '';\n"
        "export const getPendingChatMetadata = () => null;\n"
        "export const saveComposerDraft = () => ({ persisted: true });\n"
        "export const transferComposerDraft = () => ({ persisted: true });\n"
    ),
    "theme.mjs": "export default {};\n",
    "spinner.mjs": "export default {};\n",
    "subagentInspector.mjs": (
        "export const applySubagentInspector = () => {};\n"
        "export const clearSubagentInspector = () => {};\n"
    ),
    "browserPreview.mjs": "export const resetBrowserPreview = () => {};\n",
    "actionMenuOrder.mjs": (
        "export const SELECT_MENU_ICON = '';\n"
        "export const actionMenuRank = () => 0;\n"
        "export const orderActionMenuItems = (items) => items;\n"
    ),
    "escMenuStack.mjs": (
        "export const registerEscapeLayer = () => () => {};\n"
        "export const bindMenuDismiss = () => {};\n"
    ),
}

_HARNESS = r"""
const SESSIONS_URL = 'SESSIONS_PATH';
const SHELL_URL = 'SHELL_PATH';

function makeStore() {
  const values = new Map();
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
}

function makeClassList() {
  const values = new Set();
  return {
    add(...names) { names.forEach(name => values.add(name)); },
    remove(...names) { names.forEach(name => values.delete(name)); },
    contains(name) { return values.has(name); },
    toggle(name, force) {
      const enabled = force === undefined ? !values.has(name) : !!force;
      if (enabled) values.add(name); else values.delete(name);
      return enabled;
    },
  };
}

function makeWorld() {
  const byId = new Map();
  const frames = [];
  const cancelledFrames = new Set();
  const timers = [];
  let nextFrame = 1;
  let historyWrites = 0;

  function makeElement(id = '') {
    let html = '';
    const element = {
      id,
      dataset: {},
      style: {},
      classList: makeClassList(),
      children: [],
      status: null,
      value: '',
      disabled: false,
      removed: false,
      addEventListener() {},
      removeEventListener() {},
      setAttribute(name, value) { this[name] = value; },
      getAttribute(name) { return this[name] ?? null; },
      appendChild(child) { this.children.push(child); return child; },
      insertBefore(child) { this.children.unshift(child); return child; },
      contains() { return false; },
      closest() { return null; },
      querySelector(selector) {
        if (selector === '[data-session-list-status]') return this.status;
        return null;
      },
      querySelectorAll() { return []; },
      focus() { document.activeElement = this; },
      remove() { this.removed = true; if (this.id) byId.delete(this.id); },
    };
    Object.defineProperty(element, 'innerHTML', {
      get() { return html; },
      set(value) {
        html = String(value);
        if (id === 'session-list' && html === '') {
          const row = byId.get('session-list-loading');
          if (row) row.remove();
        }
      },
    });
    return element;
  }

  const document = {
    activeElement: null,
    getElementById: (id) => byId.get(id) || null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: (tag) => makeElement(tag),
    createDocumentFragment: () => makeElement('fragment'),
    addEventListener() {},
  };
  globalThis.document = document;
  globalThis.localStorage = makeStore();
  globalThis.sessionStorage = makeStore();
  Object.defineProperty(globalThis, 'navigator', {
    value: { platform: 'Linux' },
    configurable: true,
  });
  globalThis.history = { replaceState() { historyWrites += 1; }, pushState() { historyWrites += 1; } };
  globalThis.CustomEvent = class { constructor(type, options = {}) { this.type = type; this.detail = options.detail; } };
  globalThis.window = {
    document,
    history: globalThis.history,
    innerWidth: 1024,
    innerHeight: 768,
    location: { origin: 'http://odysseus.test', hash: '', pathname: '/', href: '/' },
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {},
    chatModule: {
      detachCurrentStream() {},
      showWelcomeScreen() { globalThis.__welcomeScreenCount += 1; },
    },
    __odysseusDefaultChat: {
      endpoint_url: 'http://model.test',
      model: 'test/model',
      endpoint_id: 'endpoint-1',
    },
  };
  globalThis.location = window.location;
  globalThis.requestAnimationFrame = (fn) => {
    const id = nextFrame++;
    frames.push({ id, fn });
    return id;
  };
  globalThis.cancelAnimationFrame = (id) => cancelledFrames.add(id);
  globalThis.setTimeout = (fn, ms) => { timers.push({ fn, ms, cancelled: false }); return timers.length; };
  globalThis.clearTimeout = (id) => { if (timers[id - 1]) timers[id - 1].cancelled = true; };
  globalThis.__sessionErrors = [];
  globalThis.__welcomeScreenCount = 0;

  return {
    add(id, options = {}) {
      const element = makeElement(id);
      if (options.statusText !== undefined) {
        element.status = { textContent: options.statusText };
      }
      if (options.value !== undefined) element.value = options.value;
      byId.set(id, element);
      return element;
    },
    paint(rounds = 1) {
      for (let i = 0; i < rounds; i += 1) {
        const due = frames.splice(0, frames.length);
        for (const frame of due) {
          if (!cancelledFrames.has(frame.id)) frame.fn();
        }
      }
    },
    runTimers() {
      const due = timers.splice(0, timers.length);
      for (const timer of due) if (!timer.cancelled) timer.fn();
    },
    runTimer(ms) {
      const timer = [...timers].reverse().find(item => item.ms === ms && !item.cancelled);
      if (!timer) return false;
      timer.cancelled = true;
      timer.fn();
      return true;
    },
    activeTimerCount(ms) { return timers.filter(timer => timer.ms === ms && !timer.cancelled).length; },
    byId,
    historyWrites: () => historyWrites,
    resetHistoryWrites: () => { historyWrites = 0; },
  };
}

const world = makeWorld();
world.add('session-list');
world.add('sessions-section');
const message = world.add('message', { value: 'draft before seed' });

const responses = [
  ...Array.from({ length: 5 }, () => ({
    ok: true,
    status: 200,
    json: async () => [{ id: 'existing', name: 'Existing', folder: 'Assistant', archived: false }],
  })),
  {
    ok: true,
    status: 200,
    json: async () => ({ invalid: true }),
  },
  {
    ok: false,
    status: 503,
    json: async () => ({ detail: 'temporarily unavailable' }),
  },
];
let fetchCount = 0;
globalThis.fetch = async (url) => {
  if (!String(url).includes('/api/sessions')) {
    return { ok: true, status: 200, json: async () => [] };
  }
  fetchCount += 1;
  const response = responses.shift();
  if (!response) throw new Error('unexpected fetch');
  return response;
};

const sessions = await import(SESSIONS_URL + '?bootstrap');
const shell = await import(SHELL_URL + '?bootstrap');

sessionStorage.setItem('ody-prefetch-sessions', '{');
const malformedPrefetch = await sessions.loadSessions();
const malformedPrefetchFetches = fetchCount;
sessionStorage.setItem('ody-prefetch-sessions', JSON.stringify({ invalid: true }));
const invalidShapePrefetch = await sessions.loadSessions();
const invalidShapePrefetchFetches = fetchCount;
const originalGetItem = sessionStorage.getItem.bind(sessionStorage);
sessionStorage.getItem = (key) => {
  if (key === 'ody-prefetch-sessions') throw Object.assign(new Error('denied'), { name: 'SecurityError' });
  return originalGetItem(key);
};
const storageGetDenied = await sessions.loadSessions();
const storageGetDeniedFetches = fetchCount;
sessionStorage.getItem = originalGetItem;
sessionStorage.setItem('ody-prefetch-sessions', JSON.stringify([{ id: 'stale-cache', archived: false }]));
const originalRemoveItem = sessionStorage.removeItem.bind(sessionStorage);
sessionStorage.removeItem = (key) => {
  if (key === 'ody-prefetch-sessions') throw Object.assign(new Error('denied'), { name: 'SecurityError' });
  return originalRemoveItem(key);
};
const storageRemoveDenied = await sessions.loadSessions();
const storageRemoveDeniedFetches = fetchCount;
sessionStorage.removeItem = originalRemoveItem;
sessionStorage.setItem('ody-prefetch-sessions', JSON.stringify([
  { id: 'cached', name: 'Cached', folder: 'Assistant', archived: false },
]));
const validPrefetchFetchesBefore = fetchCount;
const validPrefetchTimeoutsBefore = world.activeTimerCount(15000);
const validPrefetch = await sessions.loadSessions();
const validPrefetchFetchesAfter = fetchCount;
const validPrefetchTimeoutsAfter = world.activeTimerCount(15000);
sessionStorage.removeItem('ody-prefetch-sessions');
const seeded = await sessions.loadSessions();
sessionStorage.removeItem('ody-prefetch-sessions');
world.paint(1);
localStorage.setItem('lastSessionId', 'existing');
message.value = 'draft must survive';
document.activeElement = null;
world.resetHistoryWrites();
const loader = world.add('app-loader');
const row = world.add('session-list-loading', { statusText: 'Loading chats…' });
let opened = 0;
shell.deferRouteOpener('/email', () => { opened += 1; });

const invalidServerResponse = await sessions.loadSessions();
const hydrated = await shell.settleSessionHydration(() => sessions.loadSessions());
const beforePaint = row.status.textContent;
world.paint(2);
world.runTimers();
const staleRouteRan = shell.runDeferredRouteOpener({ sessionsSettled: true });

const errorsBeforeAuth = __sessionErrors.length;
globalThis.fetch = async () => {
  fetchCount += 1;
  const response = { ok: false, status: 401, json: async () => ({ detail: 'expired' }) };
  window.location.href = '/login'; // app.js global fetch-wrapper behaviour
  return response;
};
const authResult = await sessions.loadSessions();
const bootstrapErrors = __sessionErrors.slice();
const authAddedError = __sessionErrors.length !== errorsBeforeAuth;
const bootstrapLastSessionId = localStorage.getItem('lastSessionId');
const bootstrapHistoryWrites = world.historyWrites();

const timedOutPhases = [];
for (const phase of ['fetch', 'body', 'error-body']) {
  let requestSignal;
  globalThis.fetch = (_url, options = {}) => {
    requestSignal = options.signal;
    const aborted = () => Object.assign(new Error('aborted'), { name: 'AbortError' });
    if (phase === 'fetch') {
      return new Promise((_resolve, reject) => requestSignal.addEventListener('abort', () => reject(aborted()), { once: true }));
    }
    return Promise.resolve({
      ok: phase !== 'error-body',
      status: 503,
      json: () => new Promise((_resolve, reject) => requestSignal.addEventListener('abort', () => reject(aborted()), { once: true })),
    });
  };
  const pending = sessions.loadSessions();
  await new Promise(resolve => setImmediate(resolve));
  const hasSignal = requestSignal instanceof AbortSignal;
  const timerRan = world.runTimer(15000);
  const result = await pending;
  timedOutPhases.push({ phase, hasSignal, timerRan, aborted: requestSignal?.aborted, result });
}
globalThis.fetch = async () => ({
  ok: true,
  status: 200,
  json: async () => [{ id: 'existing', name: 'Existing', folder: 'Assistant', archived: false }],
});
const manualRetry = await sessions.loadSessions();
const startupDraftPreserved = message.value;

const currentIncognito = 'current-incognito';
sessions.setCurrentSessionId(currentIncognito);
sessionStorage.setItem('ody-incognito-sessions', JSON.stringify(['stale-incognito', currentIncognito]));
const cleanupDeleteCalls = [];
let cleanupDeleteSignal;
globalThis.fetch = async (url, options = {}) => {
  if (options.method === 'DELETE') {
    cleanupDeleteCalls.push(String(url));
    cleanupDeleteSignal = options.signal;
    return new Promise((_resolve, reject) => cleanupDeleteSignal.addEventListener(
      'abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true },
    ));
  }
  if (String(url).includes('/api/sessions')) {
    return { ok: true, status: 200, json: async () => [{ id: 'existing', name: 'Existing', folder: 'Assistant', archived: false }] };
  }
  return { ok: true, status: 200, json: async () => [] };
};
const cleanupPending = sessions.loadSessions();
await new Promise(resolve => setImmediate(resolve));
const cleanupTimeoutRan = world.runTimer(15000);
const cleanupTimedOutLoad = await cleanupPending;
const cleanupAborted = cleanupDeleteSignal?.aborted === true;
const cleanupKeptCurrent = JSON.parse(sessionStorage.getItem('ody-incognito-sessions'));
await sessions.loadSessions();
const cleanupWasNotReplayed = cleanupDeleteCalls.length === 1;

sessionStorage.setItem('ody-incognito-sessions', JSON.stringify(['stale-success', currentIncognito]));
globalThis.fetch = async (url, options = {}) => {
  if (options.method === 'DELETE') {
    cleanupDeleteCalls.push(String(url));
    return { ok: true, status: 204, json: async () => null };
  }
  if (String(url).includes('/api/sessions')) {
    return { ok: true, status: 200, json: async () => [{ id: 'existing', name: 'Existing', folder: 'Assistant', archived: false }] };
  }
  return { ok: true, status: 200, json: async () => [] };
};
const cleanupTimersBeforeSuccess = world.activeTimerCount(15000);
const cleanupSucceeded = await sessions.loadSessions();
const cleanupTimersAfterSuccess = world.activeTimerCount(15000);
const successfulCleanupKeptCurrent = JSON.parse(sessionStorage.getItem('ody-incognito-sessions'));

sessionStorage.setItem('ody-incognito-sessions', '[]');
let defaultChatLookups = 0;
globalThis.fetch = async (url) => {
  if (String(url).includes('/api/default-chat')) {
    defaultChatLookups += 1;
    return { ok: true, status: 200, json: async () => ({}) };
  }
  if (String(url).includes('/api/sessions')) {
    return { ok: true, status: 200, json: async () => [] };
  }
  return { ok: true, status: 200, json: async () => [] };
};
window.__odysseusDefaultChat = { endpoint_url: 'http://model.test', model: 'test/model', endpoint_id: 'endpoint-1' };
localStorage.setItem('odysseus-default-chat-cache', JSON.stringify(window.__odysseusDefaultChat));
const emptyWithBootstrap = await import(SESSIONS_URL + '?empty-bootstrap');
const welcomeBeforeBootstrapEmpty = __welcomeScreenCount;
const emptyWithBootstrapResult = await emptyWithBootstrap.loadSessions();
const emptyWithBootstrapState = {
  result: emptyWithBootstrapResult,
  pending: emptyWithBootstrap.hasPendingChat(),
  disabled: message.disabled,
  welcomeShown: __welcomeScreenCount > welcomeBeforeBootstrapEmpty,
  defaultLookups: defaultChatLookups,
};

window.__odysseusDefaultChat = null;
localStorage.removeItem('odysseus-default-chat-cache');
const emptyWithoutDefault = await import(SESSIONS_URL + '?empty-no-default');
const welcomeBeforeNoDefaultEmpty = __welcomeScreenCount;
const emptyWithoutDefaultResult = await emptyWithoutDefault.loadSessions();
const emptyWithoutDefaultState = {
  result: emptyWithoutDefaultResult,
  pending: emptyWithoutDefault.hasPendingChat(),
  disabled: message.disabled,
  welcomeShown: __welcomeScreenCount > welcomeBeforeNoDefaultEmpty,
  defaultLookups: defaultChatLookups,
};

const pendingManual = await import(SESSIONS_URL + '?empty-manual-pending');
message.value = '';
pendingManual.createDirectChat('http://manual.test', 'manual/model', 'manual-endpoint', { source: 'manual' });
message.value = 'manual pending draft';
const pendingManualResult = await pendingManual.loadSessions();
const pendingManualState = {
  result: pendingManualResult,
  pending: pendingManual.hasPendingChat(),
  draft: message.value,
  defaultLookups: defaultChatLookups,
};

console.log(JSON.stringify({
  malformedPrefetch,
  malformedPrefetchFetches,
  invalidShapePrefetch,
  invalidShapePrefetchFetches,
  storageGetDenied,
  storageGetDeniedFetches,
  storageRemoveDenied,
  storageRemoveDeniedFetches,
  validPrefetch,
  validPrefetchFetchesBefore,
  validPrefetchFetchesAfter,
  validPrefetchTimeoutsBefore,
  validPrefetchTimeoutsAfter,
  seeded,
  invalidServerResponse,
  hydrated,
  beforePaint,
  afterPaint: row.status.textContent,
  rowStillPresent: world.byId.has('session-list-loading'),
  loaderRemoved: loader.removed,
  opened,
  staleRouteRan,
  fetchCount,
  sessionIds: sessions.getSessions().map(session => session.id),
  pendingChat: sessions.hasPendingChat(),
  draft: startupDraftPreserved,
  lastSessionId: bootstrapLastSessionId,
  historyWrites: bootstrapHistoryWrites,
  errors: bootstrapErrors,
  authResult,
  authRedirect: window.location.href,
  authAddedError,
  timedOutPhases,
  manualRetry,
  timeoutErrors: __sessionErrors.slice(bootstrapErrors.length),
  draftAfterTimeout: startupDraftPreserved,
  cleanupTimeoutRan,
  cleanupTimedOutLoad,
  cleanupAborted,
  cleanupKeptCurrent,
  cleanupWasNotReplayed,
  cleanupSucceeded,
  cleanupTimersBeforeSuccess,
  cleanupTimersAfterSuccess,
  successfulCleanupKeptCurrent,
  emptyWithBootstrapState,
  emptyWithoutDefaultState,
  pendingManualState,
}));
"""


@pytest.fixture(scope="module")
def results(tmp_path_factory):
    if not _HAS_NODE:
        pytest.skip("node is not installed")

    module_dir = tmp_path_factory.mktemp("session-bootstrap-js")
    source = _SESSIONS.read_text(encoding="utf-8")
    versioned_rewrites = (
        (
            r"import Storage from './storage\.js(?:[?#][^']*)?';",
            "import Storage from './storage.mjs';",
        ),
        (
            r"import uiModule, \{ autoResize, styledPrompt \} from './ui\.js(?:[?#][^']*)?';",
            "import uiModule, { autoResize, styledPrompt } from './ui.mjs';",
        ),
        (
            r"import chatRenderer from './chatRenderer\.js(?:[?#][^']*)?';",
            "import chatRenderer from './chatRenderer.mjs';",
        ),
        (
            r"import \{ providerLogo \} from './providers\.js(?:[?#][^']*)?';",
            "import { providerLogo } from './providers.mjs';",
        ),
        (
            r"import \{ initModelPicker, updateModelPicker \} from './modelPicker\.js(?:[?#][^']*)?';",
            "import { initModelPicker, updateModelPicker } from './modelPicker.mjs';",
        ),
        (
            r"import themeModule from './theme\.js(?:[?#][^']*)?';",
            "import themeModule from './theme.mjs';",
        ),
        (
            r"import spinnerModule from './spinner\.js(?:[?#][^']*)?';",
            "import spinnerModule from './spinner.mjs';",
        ),
        (
            r"import \{ actionMenuRank, orderActionMenuItems, SELECT_MENU_ICON \} from './actionMenuOrder\.js(?:[?#][^']*)?';",
            "import { actionMenuRank, orderActionMenuItems, SELECT_MENU_ICON } from './actionMenuOrder.mjs';",
        ),
        (
            r"import \{ registerEscapeLayer, bindMenuDismiss \} from './escMenuStack\.js(?:[?#][^']*)?';",
            "import { registerEscapeLayer, bindMenuDismiss } from './escMenuStack.mjs';",
        ),
    )
    for pattern, replacement in versioned_rewrites:
        source, count = re.subn(pattern, replacement, source, count=1)
        assert count == 1, f"sessions import changed: {pattern}"
    for original, replacement in _IMPORT_REWRITES.items():
        assert original in source, f"sessions import changed: {original}"
        source = source.replace(original, replacement, 1)
    sessions_module = module_dir / "sessions.mjs"
    sessions_module.write_text(source, encoding="utf-8")
    for name, stub in _STUBS.items():
        (module_dir / name).write_text(stub, encoding="utf-8")
    (module_dir / "sessionHistory.mjs").write_text(
        (_REPO / "static" / "js" / "sessionHistory.js").read_text(encoding="utf-8"),
        encoding="utf-8",
    )
    (module_dir / "composerDrafts.mjs").write_text(
        (_REPO / "static" / "js" / "composerDrafts.js").read_text(encoding="utf-8"),
        encoding="utf-8",
    )

    harness = _HARNESS.replace("SESSIONS_PATH", sessions_module.as_uri()).replace(
        "SHELL_PATH", _SHELL_URL
    )
    proc = subprocess.run(
        ["node", "--input-type=module", "-e", harness],
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert proc.returncode == 0, f"node harness failed:\n{proc.stderr}"
    return json.loads(proc.stdout.strip().splitlines()[-1])


def test_prefetch_cache_misses_fall_back_and_valid_cache_is_reused(results):
    assert results["malformedPrefetch"] is True
    assert results["malformedPrefetchFetches"] == 1
    assert results["invalidShapePrefetch"] is True
    assert results["invalidShapePrefetchFetches"] == 2
    assert results["storageGetDenied"] is True
    assert results["storageGetDeniedFetches"] == 3
    assert results["storageRemoveDenied"] is True
    assert results["storageRemoveDeniedFetches"] == 4
    assert results["validPrefetch"] is True
    assert results["validPrefetchFetchesBefore"] == results["validPrefetchFetchesAfter"] == 4
    assert results["validPrefetchTimeoutsBefore"] == results["validPrefetchTimeoutsAfter"]
    assert results["seeded"] is True


def test_fulfilled_503_and_invalid_server_payload_remain_failures(results):
    assert results["invalidServerResponse"] is False
    assert results["hydrated"] is False
    assert results["sessionIds"] == ["existing"]
    assert results["pendingChat"] is False, "failure created a default direct chat"
    assert results["draft"] == "draft must survive"
    assert results["lastSessionId"] == "existing"
    assert results["historyWrites"] == 0


def test_fulfilled_503_keeps_failure_state_and_route_deferred(results):
    assert results["beforePaint"] == "Loading chats…"
    assert results["afterPaint"] == "Chats unavailable"
    assert results["rowStillPresent"] is True
    assert results["loaderRemoved"] is True
    assert results["opened"] == 0
    assert results["staleRouteRan"] is False
    assert results["errors"] == [
        "Failed to load sessions: Session request returned an invalid response",
        "Failed to load sessions: temporarily unavailable",
    ]


def test_401_keeps_global_auth_redirect_contract(results):
    assert results["authResult"] is False
    assert results["authRedirect"] == "/login"
    assert results["authAddedError"] is False
    assert results["sessionIds"] == ["existing"]


def test_session_fetch_timeout_covers_response_body_and_allows_retry(results):
    assert results["timedOutPhases"] == [
        {"phase": phase, "hasSignal": True, "timerRan": True, "aborted": True, "result": False}
        for phase in ("fetch", "body", "error-body")
    ]
    assert results["manualRetry"] is True
    assert results["timeoutErrors"] == [
        "Failed to load sessions: Session request timed out",
    ] * 3
    assert results["draftAfterTimeout"] == "draft must survive"
    assert results["sessionIds"] == ["existing"]


def test_stale_incognito_cleanup_is_bounded_and_keeps_current_session(results):
    assert results["cleanupTimeoutRan"] is True
    assert results["cleanupTimedOutLoad"] is True
    assert results["cleanupAborted"] is True
    assert results["cleanupKeptCurrent"] == ["current-incognito"]
    assert results["cleanupWasNotReplayed"] is True
    assert results["cleanupSucceeded"] is True
    assert results["cleanupTimersBeforeSuccess"] == results["cleanupTimersAfterSuccess"] == 0
    assert results["successfulCleanupKeptCurrent"] == ["current-incognito"]


def test_empty_startup_stays_fresh_and_preserves_manual_pending_chat(results):
    assert results["emptyWithBootstrapState"] == {
        "result": True,
        "pending": False,
        "disabled": False,
        "welcomeShown": True,
        "defaultLookups": 0,
    }
    assert results["emptyWithoutDefaultState"] == {
        "result": True,
        "pending": False,
        "disabled": False,
        "welcomeShown": True,
        "defaultLookups": 0,
    }
    assert results["pendingManualState"] == {
        "result": True,
        "pending": True,
        "draft": "manual pending draft",
        "defaultLookups": 0,
    }
