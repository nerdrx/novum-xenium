from pathlib import Path
import subprocess


ROOT = Path(__file__).resolve().parents[1]


def test_fetch_runs_keeps_empty_history_distinct_from_failures():
    source = (ROOT / "static/js/tasks.js").read_text(encoding="utf-8")
    start = source.index("async function _fetchRuns(")
    end = source.index("\nfunction _leaveRunHistory()", start)
    fetch_runs = source[start:end]
    script = f"""
const assert = require('node:assert/strict');
const API_BASE = 'http://synthetic.invalid';
{fetch_runs}
(async () => {{
  global.fetch = async () => ({{ ok: true, json: async () => ({{ runs: [] }}) }});
  assert.deepEqual(await _fetchRuns('synthetic'), []);
  global.fetch = async () => ({{ ok: false, status: 503 }});
  await assert.rejects(_fetchRuns('synthetic'), /HTTP 503/);
  global.fetch = async () => ({{ ok: true, json: async () => ({{}}) }});
  await assert.rejects(_fetchRuns('synthetic'), /Invalid history response/);
  global.fetch = async () => ({{ ok: true, json: async () => {{ throw new Error('bad json'); }} }});
  await assert.rejects(_fetchRuns('synthetic'), /bad json/);
  const realSetTimeout = global.setTimeout;
  const realClearTimeout = global.clearTimeout;
  let timeoutMs, cleared, timeoutCallback, bodyGuard, enteredJson = false;
  try {{
    global.setTimeout = (callback, ms) => {{ timeoutMs = ms; timeoutCallback = callback; return 17; }};
    global.clearTimeout = id => {{ cleared = id; }};
    global.fetch = async (_url, options) => ({{
      ok: true,
      json: async () => {{
        enteredJson = true;
        return await new Promise((_resolve, reject) => {{
          options.signal.addEventListener('abort', () => reject(new Error('synthetic body abort')), {{ once: true }});
          bodyGuard = realSetTimeout(() => reject(new Error('body timeout test stalled')), 1000);
        }});
      }},
    }});
    const pending = _fetchRuns('synthetic');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(enteredJson, true);
    assert.equal(timeoutMs, 15000);
    timeoutCallback();
    await assert.rejects(pending, /synthetic body abort/);
    assert.equal(timeoutMs, 15000);
    assert.equal(cleared, 17);
  }} finally {{
    realClearTimeout(bodyGuard);
    global.setTimeout = realSetTimeout;
    global.clearTimeout = realClearTimeout;
  }}
}})().catch(error => {{ console.error(error); process.exitCode = 1; }});
"""
    subprocess.run(["node", "-e", script], check=True, capture_output=True, text=True, timeout=10)
