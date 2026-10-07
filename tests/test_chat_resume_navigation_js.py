"""Exercise resume-stream races across session navigation."""

import json
import shutil
import subprocess
from pathlib import Path

import pytest


_REPO = Path(__file__).resolve().parents[1]
_SOURCE = (_REPO / "static/js/chat.js").read_text(encoding="utf-8")
_DETACH_START = _SOURCE.index("export function detachCurrentStream(sessionId) {")
_DETACH_END = _SOURCE.index("\n  // _notifyStreamComplete", _DETACH_START)
_RESUME_START = _SOURCE.index("export async function resumeStream(sessionId, replaceHolder = null) {")
_RESUME_END = _SOURCE.index("\n  /**\n   * Check for background streams", _RESUME_START)
_FUNCTIONS = (
    _SOURCE[_DETACH_START:_DETACH_END].replace("export function detachCurrentStream", "function detachCurrentStream")
    + "\n"
    + _SOURCE[_RESUME_START:_RESUME_END].replace("export async function resumeStream", "async function resumeStream")
)


def _run(script):
    if not shutil.which("node"):
        pytest.skip("node is not installed")
    result = subprocess.run(
        ["node", "--input-type=module"], input=script, capture_output=True,
        text=True, cwd=_REPO, timeout=30,
    )
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def _factory():
    body = """let currentAbort = null, currentHolder = null, currentAccumulated = '';
let _streamSessionId = null;
""" + _FUNCTIONS + "\nreturn { resumeStream, detachCurrentStream };"
    return f"""(() => {{
      const make = (deps) => new Function(
        'deps', 'hasActiveStream', 'fetch', 'API_BASE', '_streamRunIds', 'document',
        'sessionModule', '_shortModel', 'uiModule', '_applyModelColor',
        '_resumingStreams', '_resumeStreams', 'spinnerModule', 'markdownModule',
        '_streamDisplayText', 'chatRenderer', '_activeStreams', '_getForegroundStreamState',
        'abortCurrentRequest', '_terminalSavedStreams', '_backgroundStreams',
        '_syncForegroundStreamGlobals', 'updateSubmitButton', 'chatStream',
        {json.dumps(body)}
      )(
        deps, deps.hasActiveStream, deps.fetch, '', new Map(), deps.document,
        deps.sessionModule, x => x || '', {{ esc: x => x, scrollHistory() {{}} }},
        () => {{}}, new Set(), deps.resumeStreams,
        {{ create: () => ({{ createElement: () => ({{}}), start() {{}}, destroy() {{ deps.destroyed++; }} }}) }},
        {{ normalizeThinkingMarkup: x => x, squashOutsideCode: x => x, mdToHtml: x => x }},
        x => x, {{ addMessage() {{}}, recordSessionMetricsCost() {{}} }}, new Map(),
        () => null, () => {{ deps.abortCalls++; }}, new Set(), new Map(), () => {{}},
        () => '', () => {{}}, {{ notifyStreamComplete() {{}}, insertStreamDoneToast() {{}} }}
      );
      return make(deps);
    }})()"""


def test_late_resume_fetch_does_not_append_into_new_chat():
    script = f"""
      import assert from 'node:assert/strict';
      let current = 'session-A';
      let finishFetch;
      const events = [];
      const box = {{ appendChild(el) {{ el.parentNode = this; events.push('append'); }} }};
      const holder = {{
        className: '', dataset: {{}}, parentNode: null,
        querySelector(sel) {{ return sel === '.role' ? {{ querySelector: () => null }} : {{ appendChild() {{}}, innerHTML: '' }}; }},
        remove() {{ this.parentNode = null; events.push('remove'); }},
      }};
      const deps = {{
        destroyed: 0, abortCalls: 0, resumeStreams: new Map(),
        hasActiveStream: () => false,
        fetch: (_url, options) => {{ deps.signal = options?.signal; return new Promise(resolve => finishFetch = resolve); }},
        document: {{ getElementById: () => box, createElement: () => holder, querySelector: () => null }},
        sessionModule: {{ getCurrentSessionId: () => current, getSessions: () => [{{ id: 'session-A', model: 'm' }}], loadSessions() {{}} }},
      }};
      const {{ resumeStream, detachCurrentStream }} = ({_factory()});
      const pending = resumeStream('session-A');
      current = 'session-B';
      detachCurrentStream('session-A');
      finishFetch({{ ok: true, headers: {{ get: () => '' }}, body: {{ getReader: () => ({{
        cancel: async () => {{}}, read: async () => ({{ done: true }}),
      }}) }} }});
      const attached = await pending;
      console.log(JSON.stringify({{ attached, aborted: deps.signal?.aborted, abortCalls: deps.abortCalls, events, locked: deps.resumeStreams.has('session-A') }}));
    """
    assert _run(script) == {
        "attached": False, "aborted": True, "abortCalls": 0, "events": [], "locked": False,
    }


def test_navigation_cancels_pending_resume_reader_and_clears_lock():
    script = f"""
      import assert from 'node:assert/strict';
      let current = 'session-A';
      let finishRead;
      let cancelCalls = 0;
      const events = [];
      const box = {{ appendChild(el) {{ el.parentNode = this; events.push('append'); }} }};
      const holder = {{
        className: '', dataset: {{}}, parentNode: null,
        querySelector(sel) {{ return sel === '.role' ? {{ querySelector: () => null }} : {{ appendChild() {{}}, innerHTML: '' }}; }},
        remove() {{ this.parentNode = null; events.push('remove'); }},
      }};
      const deps = {{
        destroyed: 0, abortCalls: 0, resumeStreams: new Map(), hasActiveStream: () => false,
        fetch: async () => ({{ ok: true, headers: {{ get: () => '' }}, body: {{ getReader: () => ({{
          read: () => new Promise(resolve => finishRead = resolve),
          cancel: async () => {{ cancelCalls++; }},
        }}) }} }}),
        document: {{ getElementById: () => box, createElement: () => holder, querySelector: () => null }},
        sessionModule: {{ getCurrentSessionId: () => current, getSessions: () => [{{ id: 'session-A', model: 'm' }}], loadSessions() {{}} }},
      }};
      const {{ resumeStream, detachCurrentStream }} = ({_factory()});
      const pending = resumeStream('session-A');
      await new Promise(resolve => setImmediate(resolve));
      const wasLocked = deps.resumeStreams.has('session-A');
      current = 'session-B';
      detachCurrentStream('session-A');
      const afterDetach = {{ cancelCalls, abortCalls: deps.abortCalls, locked: deps.resumeStreams.has('session-A'), parent: !!holder.parentNode, events: [...events] }};
      finishRead({{ done: true }});
      await pending;
      console.log(JSON.stringify({{ wasLocked, afterDetach, finalLocked: deps.resumeStreams.has('session-A') }}));
    """
    state = _run(script)
    assert state["wasLocked"] is True
    assert state["afterDetach"] == {
        "cancelCalls": 1, "abortCalls": 0, "locked": False, "parent": False, "events": ["append", "remove"],
    }
    assert state["finalLocked"] is False
