"""Exercise the real Compare probe helper without waiting for its timer."""

import json
import shutil
import subprocess
import textwrap
from pathlib import Path

import pytest

_REPO = Path(__file__).resolve().parent.parent


def test_probe_uses_selected_budget_and_aborts_cleanly():
    node = shutil.which("node")
    if not node:
        pytest.skip("node binary not on PATH")

    source = (_REPO / "static/js/compare/probe.js").read_text()
    start = source.index("const PROBE_NETWORK_GRACE_MS")
    end = source.index("function _clearProbeWaves()", start)
    helper_source = source[start:end]
    script = textwrap.dedent(f"""
        import assert from 'node:assert/strict';
        const helperSource = {json.dumps(helper_source)};
        const timers = [];
        function fakeSetTimeout(callback, ms) {{
          const timer = {{ callback, ms, cleared: false }};
          timers.push(timer);
          return timer;
        }}
        function fakeClearTimeout(timer) {{ timer.cleared = true; }}
        let fetchMode = 'success';
        let lastSignal;
        const payloads = [];
        function fakeFetch(_url, {{ body, signal }}) {{
          payloads.push(JSON.parse(body));
          lastSignal = signal;
          if (fetchMode === 'success') {{
            return Promise.resolve({{ json: async () => ({{ results: [{{ status: 'ok' }}] }}) }});
          }}
          return new Promise((_resolve, reject) => {{
            if (signal.aborted) return reject(new DOMException('Aborted', 'AbortError'));
            signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {{ once: true }});
          }});
        }}
        const state = {{ API_BASE: '', _timeout: 300 }};
        const makeProbe = new Function('state', 'fetch', 'setTimeout', 'clearTimeout',
          helperSource + '\\nreturn probeSelectedModel;');
        const probe = makeProbe(state, fakeFetch, fakeSetTimeout, fakeClearTimeout);

        await probe({{ model: 'huihui-qwen3.8:27b-local', endpointId: 'local' }});
        assert.equal(payloads[0].timeout_seconds, 300);
        assert.equal(timers[0].ms, 302000);
        assert.equal(timers[0].cleared, true);

        fetchMode = 'wait';
        const timedOutPromise = probe({{ model: 'slow' }});
        const timeoutTimer = timers[1];
        assert.equal(timeoutTimer.ms, 302000);
        timeoutTimer.callback();
        const timeoutResult = await timedOutPromise;
        assert.equal(lastSignal.aborted, true);
        assert.equal(timeoutResult.error, 'Timeout');
        assert.equal(timeoutTimer.cleared, true);

        const external = new AbortController();
        const cancelledPromise = probe({{ model: 'cancelled' }}, {{ signal: external.signal }});
        const cancelTimer = timers[2];
        external.abort();
        const cancelledResult = await cancelledPromise;
        assert.equal(lastSignal.aborted, true);
        assert.equal(cancelledResult.error, 'Cancelled');
        assert.equal(cancelTimer.cleared, true);
        console.log(JSON.stringify({{ budget: payloads[0].timeout_seconds, graceTimer: timers[0].ms, timeoutAborted: timeoutResult.error, cancelled: cancelledResult.error }}));
    """)
    result = subprocess.run(
        [node, "--input-type=module", "-e", script],
        cwd=_REPO,
        capture_output=True,
        timeout=15,
        text=True,
    )
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout.splitlines()[-1]) == {
        "budget": 300,
        "graceTimer": 302000,
        "timeoutAborted": "Timeout",
        "cancelled": "Cancelled",
    }
