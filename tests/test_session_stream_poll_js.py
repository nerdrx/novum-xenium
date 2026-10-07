"""Exercise detached-stream polling across a transient status request failure."""

import json
import shutil
import subprocess
from pathlib import Path

import pytest


_REPO = Path(__file__).resolve().parents[1]
_SOURCE = (_REPO / "static" / "js" / "sessions.js").read_text(encoding="utf-8")
_START = _SOURCE.index("async function _checkServerStream(sessionId) {")
_END = _SOURCE.index("\n}\n\nexport function clearStreamComplete", _START) + 2
_FUNCTION = _SOURCE[_START:_END].replace(
    "const spinnerMod = await import('./spinner.js');",
    "const spinnerMod = fakeSpinnerMod;",
)


def test_transient_status_error_keeps_detached_stream_polling():
    if not shutil.which("node"):
        pytest.skip("node is not installed")

    script = f"""
      const sessionId = 'session-1';
      const calls = {{ cleared: [], selected: [], spinnerDestroyed: 0 }};
      const box = {{ appendChild(node) {{ node.parentNode = this; }} }};
      const body = {{ appendChild() {{}} }};
      const holder = {{
        className: '', innerHTML: '', parentNode: box,
        querySelector() {{ return body; }}, remove() {{ this.parentNode = null; }}
      }};
      const spinner = {{
        createElement() {{ return {{}}; }}, start() {{}},
        destroy() {{ calls.spinnerDestroyed += 1; }}
      }};
      let poll;
      let fetchImpl = async () => ({{ ok: true, json: async () => ({{ status: 'streaming' }}) }});
      const check = new Function(
        'window', '_researchingSessions', '_serverStreamChecks', 'fetch', 'API_BASE', '_clearRunningState',
        'document', 'uiModule', 'getCurrentSessionId', 'selectSession',
        'setInterval', 'clearInterval', 'fakeSpinnerMod',
        {json.dumps('return (' + _FUNCTION + ');')}
      )(
        {{ chatModule: {{ hasActiveStream: () => false, resumeStream: async () => false }} }},
        new Set(), new Map(), (...args) => fetchImpl(...args), '/api', () => {{}},
        {{ getElementById: () => box, createElement: () => holder }},
        {{ scrollHistory() {{}} }}, () => sessionId,
        (id) => calls.selected.push(id),
        (callback) => {{ poll = callback; return 17; }},
        (id) => calls.cleared.push(id),
        {{ default: {{ create: () => spinner }} }}
      );

      await check(sessionId);
      fetchImpl = async () => {{ throw new TypeError('temporary network failure'); }};
      await poll();
      fetchImpl = async () => ({{ ok: true, json: async () => ({{ status: 'done' }}) }});
      await poll();
      console.log(JSON.stringify(calls));
    """
    result = subprocess.run(
        ["node", "--input-type=module"],
        input=script,
        capture_output=True,
        text=True,
        cwd=_REPO,
        timeout=30,
    )

    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout) == {
        "cleared": [17],
        "selected": ["session-1"],
        "spinnerDestroyed": 1,
    }


def test_status_codes_distinguish_temporary_failures_from_terminal_states():
    if not shutil.which("node"):
        pytest.skip("node is not installed")

    script = f"""
      const sessionId = 'session-1';
      const response = (status, info = {{ status: 'streaming' }}) => ({{
        ok: status >= 200 && status < 300, status, json: async () => info,
      }});
      async function scenario(initial, polls, resumeStream = async () => false) {{
        const calls = {{ cleared: [], selected: [], spinnerDestroyed: 0, stateCleared: [], resumeAttempts: 0, pollSnapshots: [] }};
        const box = {{ appendChild(node) {{ node.parentNode = this; }} }};
        const body = {{ appendChild() {{}} }};
        const holder = {{
          className: '', innerHTML: '', parentNode: box,
          querySelector() {{ return body; }}, remove() {{ this.parentNode = null; }}
        }};
        const spinner = {{
          createElement() {{ return {{}}; }}, start() {{}},
          destroy() {{ calls.spinnerDestroyed += 1; }}
        }};
        let poll;
        const responses = [initial, ...polls];
        let request = 0;
        const check = new Function(
          'window', '_researchingSessions', '_serverStreamChecks', 'fetch', 'API_BASE', '_clearRunningState',
          'document', 'uiModule', 'getCurrentSessionId', 'selectSession',
          'setInterval', 'clearInterval', 'fakeSpinnerMod',
          {json.dumps('return (' + _FUNCTION + ');')}
        )(
          {{ chatModule: {{
            hasActiveStream: () => false,
            resumeStream: async (...args) => {{ calls.resumeAttempts += 1; return resumeStream(...args); }},
          }} }},
          new Set(), new Map(), async () => responses[request++], '/api',
          (id) => calls.stateCleared.push(id),
          {{ getElementById: () => box, createElement: () => holder }},
          {{ scrollHistory() {{}} }}, () => sessionId,
          (id) => calls.selected.push(id),
          (callback) => {{ poll = callback; return 17; }},
          (id) => calls.cleared.push(id),
          {{ default: {{ create: () => spinner }} }}
        );
        await check(sessionId);
        const spinnerSurvivedStartup = calls.spinnerDestroyed === 0 && !!poll;
        while (poll && request < responses.length) {{
          await poll();
          calls.pollSnapshots.push({{
            request, cleared: [...calls.cleared], selected: [...calls.selected],
            spinnerDestroyed: calls.spinnerDestroyed,
          }});
          if (calls.cleared.length) break;
        }}
        return {{ ...calls, spinnerSurvivedStartup }};
      }}

      const transient = await scenario(
        response(503), [response(503), response(404)],
        async () => {{ throw new TypeError('resume unavailable'); }}
      );
      const missing = await scenario(response(404), []);
      const completed = await scenario(response(200, {{ status: 'done' }}), []);
      const unauthorized = await scenario(response(200), [response(401)]);
      const forbidden = await scenario(response(200), [response(403)]);
      console.log(JSON.stringify({{ transient, missing, completed, unauthorized, forbidden }}));
    """
    result = subprocess.run(
        ["node", "--input-type=module"],
        input=script,
        capture_output=True,
        text=True,
        cwd=_REPO,
        timeout=30,
    )

    assert result.returncode == 0, result.stderr
    state = json.loads(result.stdout)
    assert state["transient"] == {
        "cleared": [17],
        "selected": ["session-1"],
        "spinnerDestroyed": 1,
        "stateCleared": ["session-1"],
        "resumeAttempts": 2,
        "spinnerSurvivedStartup": True,
        "pollSnapshots": [
            {"request": 2, "cleared": [], "selected": [], "spinnerDestroyed": 0},
            {"request": 3, "cleared": [17], "selected": ["session-1"], "spinnerDestroyed": 1},
        ],
    }
    for terminal in ("missing", "completed"):
        assert state[terminal]["spinnerSurvivedStartup"] is False
        assert state[terminal]["stateCleared"] == ["session-1"]
        assert state[terminal]["spinnerDestroyed"] == 0
    for auth_failure in ("unauthorized", "forbidden"):
        assert state[auth_failure]["cleared"] == [17]
        assert state[auth_failure]["selected"] == []
        assert state[auth_failure]["spinnerDestroyed"] == 1
        assert state[auth_failure]["stateCleared"] == ["session-1"]


def test_initial_network_failure_falls_back_to_one_status_poll():
    if not shutil.which("node"):
        pytest.skip("node is not installed")

    script = f"""
      const sessionId = 'session-1';
      const calls = {{ selected: [], requests: 0, intervals: 0, spinnerDestroyed: 0, cleared: [] }};
      const box = {{ appendChild(node) {{ node.parentNode = this; }} }};
      const holder = {{
        parentNode: box, querySelector() {{ return {{ appendChild() {{}} }}; }},
        remove() {{ this.parentNode = null; }}
      }};
      const spinner = {{ createElement() {{ return {{}}; }}, start() {{}}, destroy() {{ calls.spinnerDestroyed++; }} }};
      let poll;
      let fetchImpl = async () => ({{ ok: true, status: 200, json: async () => ({{ status: 'streaming' }}) }});
      const check = new Function(
        'window', '_researchingSessions', '_serverStreamChecks', 'fetch', 'API_BASE', '_clearRunningState',
        'document', 'uiModule', 'getCurrentSessionId', 'selectSession',
        'setInterval', 'clearInterval', 'fakeSpinnerMod',
        {json.dumps('return (' + _FUNCTION + ');')}
      )(
        {{ chatModule: {{ hasActiveStream: () => false, resumeStream: async () => false }} }},
        new Set(), new Map(), async () => {{
          calls.requests++;
          if (calls.requests === 1) throw new TypeError('offline');
          return {{ ok: true, status: 200, json: async () => ({{ status: calls.requests === 2 ? 'streaming' : 'done' }}) }};
        }}, '/api', () => {{}},
        {{ getElementById: () => box, createElement: () => holder }},
        {{ scrollHistory() {{}} }}, () => sessionId,
        id => calls.selected.push(id),
        callback => {{ calls.intervals++; poll = callback; return 17; }},
        id => calls.cleared.push(id), {{ default: {{ create: () => spinner }} }}
      );
      await check(sessionId);
      const pollStarted = typeof poll === 'function';
      const requestsBeforePoll = calls.requests;
      if (poll) {{
        await poll();
        const spinnerSurvivedStreaming = calls.spinnerDestroyed === 0;
        await poll();
        calls.spinnerSurvivedStreaming = spinnerSurvivedStreaming;
      }}
      console.log(JSON.stringify({{ ...calls, pollStarted, requestsBeforePoll }}));
    """
    result = subprocess.run(
        ["node", "--input-type=module"], input=script, capture_output=True,
        text=True, cwd=_REPO, timeout=30,
    )

    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout) == {
        "selected": ["session-1"], "requests": 3, "intervals": 1,
        "spinnerDestroyed": 1, "cleared": [17], "pollStarted": True,
        "requestsBeforePoll": 1, "spinnerSurvivedStreaming": True,
    }


def test_poll_response_after_navigation_cannot_select_old_session():
    if not shutil.which("node"):
        pytest.skip("node is not installed")

    script = f"""
      let current = 'session-1';
      let finishStatus;
      let poll;
      let fetchImpl = async () => ({{ ok: true, status: 200, json: async () => ({{ status: 'streaming' }}) }});
      const calls = {{ selected: [], spinnerDestroyed: 0, cleared: [] }};
      const box = {{ appendChild(node) {{ node.parentNode = this; }} }};
      const holder = {{
        parentNode: box, querySelector() {{ return {{ appendChild() {{}} }}; }},
        remove() {{ this.parentNode = null; }}
      }};
      const spinner = {{ createElement() {{ return {{}}; }}, start() {{}}, destroy() {{ calls.spinnerDestroyed++; }} }};
      const check = new Function(
        'window', '_researchingSessions', '_serverStreamChecks', 'fetch', 'API_BASE', '_clearRunningState',
        'document', 'uiModule', 'getCurrentSessionId', 'selectSession',
        'setInterval', 'clearInterval', 'fakeSpinnerMod',
        {json.dumps('return (' + _FUNCTION + ');')}
      )(
        {{ chatModule: {{ hasActiveStream: () => false, resumeStream: async () => false }} }},
        new Set(), new Map(), (...args) => fetchImpl(...args),
        '/api', () => {{}},
        {{ getElementById: () => box, createElement: () => holder }},
        {{ scrollHistory() {{}} }}, () => current,
        id => calls.selected.push(id),
        callback => {{ poll = callback; return 17; }},
        id => calls.cleared.push(id), {{ default: {{ create: () => spinner }} }}
      );
      await check('session-1');
      fetchImpl = async () => ({{
        ok: true, status: 200, json: () => new Promise(resolve => finishStatus = resolve)
      }});
      const checking = poll();
      await new Promise(resolve => setImmediate(resolve));
      current = 'session-2';
      finishStatus({{ status: 'done' }});
      await checking;
      console.log(JSON.stringify(calls));
    """
    result = subprocess.run(
        ["node", "--input-type=module"], input=script, capture_output=True,
        text=True, cwd=_REPO, timeout=30,
    )

    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout) == {
        "selected": [], "spinnerDestroyed": 1, "cleared": [17],
    }
