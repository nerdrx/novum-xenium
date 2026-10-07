"""Exercise research queue cancellation through the shipped jobs module."""
import shutil
import subprocess
from pathlib import Path

import pytest


_REPO = Path(__file__).resolve().parent.parent
_JOBS = (_REPO / "static" / "js" / "research" / "jobs.js").as_uri()
_HAS_NODE = shutil.which("node") is not None


def _run(script):
    proc = subprocess.run(
        ["node", "--input-type=module"], input=script,
        capture_output=True, text=True, cwd=str(_REPO), timeout=10,
    )
    assert proc.returncode == 0, proc.stderr


@pytest.mark.skipif(not _HAS_NODE, reason="node binary not on PATH")
def test_sequential_queue_does_not_launch_job_cancelled_while_waiting():
    _run(f"""
      import assert from 'node:assert/strict';
      const jobs = await import('{_JOBS}');
      let starts = 0;
      globalThis.fetch = async (url) => {{
        if (url.endsWith('/api/research/start')) {{
          starts++;
          return {{ ok: true, json: async () => ({{ session_id: `session-${{starts}}` }}) }};
        }}
        return {{ ok: true, json: async () => ({{}}) }};
      }};
      const streams = [];
      globalThis.EventSource = class {{
        constructor() {{ streams.push(this); }}
        close() {{}}
      }};
      let nextTimer = 0;
      const timers = new Map();
      globalThis.setInterval = (fn) => {{ const id = ++nextTimer; timers.set(id, fn); return id; }};
      globalThis.clearInterval = (id) => timers.delete(id);

      const first = jobs.addToQueue('first', {{}});
      const second = jobs.addToQueue('second', {{}});
      const running = jobs.startAllQueuedSequential();
      while (!streams.length || timers.size < 2) await new Promise(resolve => setTimeout(resolve, 0));
      await jobs.cancelJob(second.id);
      streams[0].onmessage({{ data: JSON.stringify({{ final: true, status: 'done' }}) }});
      let finished = false;
      running.then(() => finished = true);
      for (let tries = 0; tries < 10 && !finished; tries++) {{
        await new Promise(resolve => setTimeout(resolve, 0));
        for (const tick of [...timers.values()]) tick();
      }}
      await running;
      assert.equal(first.status, 'done');
      assert.equal(second.status, 'cancelled');
      assert.equal(starts, 1);
    """)


@pytest.mark.skipif(not _HAS_NODE, reason="node binary not on PATH")
def test_cancel_during_start_request_stops_created_server_session():
    _run(f"""
      import assert from 'node:assert/strict';
      const jobs = await import('{_JOBS}');
      let finishStart;
      const cancelled = [];
      globalThis.fetch = async (url) => {{
        if (url.endsWith('/api/research/start')) {{
          return new Promise(resolve => {{ finishStart = resolve; }});
        }}
        if (url.includes('/api/research/cancel/')) {{
          cancelled.push(url);
          return {{ ok: true, json: async () => ({{ cancelled: true }}) }};
        }}
        return {{ ok: true, json: async () => ({{}}) }};
      }};
      globalThis.EventSource = class {{ constructor() {{ throw new Error('cancelled job must not stream'); }} }};
      const starting = jobs.startJob('racing', {{}});
      const job = jobs.getJobs()[0];
      await jobs.cancelJob(job.id);
      finishStart({{ ok: true, json: async () => ({{ session_id: 'created-session' }}) }});
      await starting;
      assert.equal(job.status, 'cancelled');
      assert.deepEqual(cancelled, ['/api/research/cancel/created-session']);
      assert.equal(job.errorMsg, null);
    """)


@pytest.mark.skipif(not _HAS_NODE, reason="node binary not on PATH")
def test_failed_cancel_request_reports_server_state_uncertainty():
    _run(f"""
      import assert from 'node:assert/strict';
      const jobs = await import('{_JOBS}');
      let finishStart;
      let renders = 0;
      jobs.setRenderCallback(() => renders++);
      globalThis.fetch = async (url) => {{
        if (url.endsWith('/api/research/start')) return new Promise(resolve => finishStart = resolve);
        if (url.includes('/api/research/cancel/')) return {{ ok: false, status: 503 }};
        throw new Error(`Unexpected request: ${{url}}`);
      }};
      globalThis.EventSource = class {{ constructor() {{ throw new Error('cancelled job must not stream'); }} }};
      const starting = jobs.startJob('http cancellation failure', {{}});
      const job = jobs.getJobs()[0];
      await jobs.cancelJob(job.id);
      finishStart({{ ok: true, json: async () => ({{ session_id: 'http-failure-session' }}) }});
      await starting;
      assert.equal(job.status, 'cancelled');
      assert.match(job.errorMsg, /may still be running/);
      assert.ok(renders >= 2, 'warning must trigger a panel render');
    """)


@pytest.mark.skipif(not _HAS_NODE, reason="node binary not on PATH")
def test_network_cancel_failure_reports_server_state_uncertainty():
    _run(f"""
      import assert from 'node:assert/strict';
      const jobs = await import('{_JOBS}');
      let finishStart;
      globalThis.fetch = async (url) => {{
        if (url.endsWith('/api/research/start')) return new Promise(resolve => finishStart = resolve);
        if (url.includes('/api/research/cancel/')) throw new Error('offline');
        throw new Error(`Unexpected request: ${{url}}`);
      }};
      globalThis.EventSource = class {{ constructor() {{ throw new Error('cancelled job must not stream'); }} }};
      const starting = jobs.startJob('network cancellation failure', {{}});
      const job = jobs.getJobs()[0];
      await jobs.cancelJob(job.id);
      finishStart({{ ok: true, json: async () => ({{ session_id: 'network-failure-session' }}) }});
      await starting;
      assert.equal(job.status, 'cancelled');
      assert.match(job.errorMsg, /may still be running/);
    """)


@pytest.mark.skipif(not _HAS_NODE, reason="node binary not on PATH")
def test_repeated_start_clicks_share_one_in_flight_request():
    _run(f"""
      import assert from 'node:assert/strict';
      const jobs = await import('{_JOBS}');
      let finishStart;
      let starts = 0;
      let streams = 0;
      globalThis.fetch = async (url) => {{
        if (url.endsWith('/api/research/start')) {{
          starts++;
          return new Promise(resolve => finishStart = resolve);
        }}
        throw new Error(`Unexpected request: ${{url}}`);
      }};
      globalThis.EventSource = class {{ constructor() {{ streams++; }} close() {{}} }};
      globalThis.setInterval = () => 1;
      globalThis.clearInterval = () => {{}};
      const job = jobs.addToQueue('double click', {{}});
      const first = jobs.startQueued(job.id);
      const duplicate = jobs.startQueued(job.id);
      await Promise.resolve();
      assert.equal(starts, 1);
      finishStart({{ ok: true, json: async () => ({{ session_id: 'single-session' }}) }});
      await Promise.all([first, duplicate]);
      assert.equal(job.status, 'running');
      assert.equal(job.id, 'single-session');
      assert.equal(streams, 1);
    """)


@pytest.mark.skipif(not _HAS_NODE, reason="node binary not on PATH")
def test_running_cancel_requires_explicit_server_confirmation():
    _run(f"""
      import assert from 'node:assert/strict';
      const jobs = await import('{_JOBS}');
      let cancelAttempt = 0;
      let renders = 0;
      jobs.setRenderCallback(() => renders++);
      globalThis.fetch = async (url) => {{
        if (url.endsWith('/api/research/start')) {{
          return {{ ok: true, json: async () => ({{ session_id: `session-${{cancelAttempt}}` }}) }};
        }}
        cancelAttempt++;
        if (cancelAttempt === 1) return {{ ok: false, status: 503 }};
        if (cancelAttempt === 2) return {{ ok: true, json: async () => ({{ cancelled: false }}) }};
        if (cancelAttempt === 3) throw new Error('offline');
        return {{ ok: true, json: async () => ({{ cancelled: true }}) }};
      }};
      globalThis.EventSource = class {{ close() {{}} }};
      let interval = 0;
      globalThis.setInterval = () => ++interval;
      globalThis.clearInterval = () => {{}};

      for (let attempt = 1; attempt <= 3; attempt++) {{
        const job = await jobs.startJob(`failed cancel ${{attempt}}`, {{}});
        const before = renders;
        await jobs.cancelJob(job.id);
        assert.equal(job.status, 'running');
        assert.match(job.errorMsg, /may still be running/);
        assert.ok(renders > before, 'the visible running card must be re-rendered');
      }}
      const confirmed = await jobs.startJob('confirmed cancel', {{}});
      await jobs.cancelJob(confirmed.id);
      assert.equal(confirmed.status, 'cancelled');
      assert.equal(confirmed.errorMsg, null);
    """)


@pytest.mark.skipif(not _HAS_NODE, reason="node binary not on PATH")
def test_sse_disconnect_fallback_preserves_cancelled_terminal_status():
    _run(f"""
      import assert from 'node:assert/strict';
      const jobs = await import('{_JOBS}');
      let fallback;
      globalThis.setTimeout = (fn) => {{ fallback = fn; return 1; }};
      globalThis.fetch = async (url) => {{
        if (url.endsWith('/api/research/start')) {{
          return {{ ok: true, json: async () => ({{ session_id: 'session-cancelled' }}) }};
        }}
        if (url.endsWith('/api/research/status/session-cancelled')) {{
          return {{ ok: true, json: async () => ({{ status: 'cancelled' }}) }};
        }}
        throw new Error(`Unexpected request: ${{url}}`);
      }};
      let stream;
      globalThis.EventSource = class {{ constructor() {{ stream = this; }} close() {{}} }};
      const job = await jobs.startJob('cancelled after disconnect', {{}});
      stream.onerror();
      await fallback();
      assert.equal(job.status, 'cancelled');
    """)
