"""Exercise persona labels from detached-stream replay through final rendering."""

import json
import shutil
import subprocess
from pathlib import Path

import pytest


_REPO = Path(__file__).resolve().parents[1]
_SOURCE = (_REPO / "static/js/chat.js").read_text(encoding="utf-8")
_START = _SOURCE.index("export async function resumeStream(")
_END = _SOURCE.index("\n  /**\n   * Check for background streams", _START)
_FUNCTION = _SOURCE[_START:_END].replace("export async function resumeStream", "async function resumeStream")


def test_resume_replays_persona_name_into_live_and_final_bubble():
    if not shutil.which("node"):
        pytest.skip("node is not installed")

    script = f"""
      const sessionId = 'session-1';
      const timestamp = {{ textContent: '12:34' }};
      const role = {{
        textContent: '', appendChild(node) {{ this.timestamp = node; }},
        querySelector: (selector) => selector === '.role-timestamp' ? timestamp : null,
      }};
      const streamContent = {{ innerHTML: '' }};
      const body = {{ appendChild() {{}} }};
      const box = {{ appendChild(node) {{ node.parentNode = this; }} }};
      const holder = {{
        className: '', parentNode: box,
        querySelector(selector) {{
          if (selector === '.role') return role;
          if (selector === '.stream-content') return streamContent;
          if (selector === '.body') return body;
          return null;
        }},
        remove() {{ this.parentNode = null; }},
      }};
      const events = [
        {{ type: 'model_info', model: 'route-model', character_name: 'Mira' }},
        {{ delta: '<think>Reasoned.</think>Hello from Mira.' }},
        '[DONE]',
      ].map((event) => `data: ${{typeof event === 'string' ? event : JSON.stringify(event)}}\\n\\n`).join('');
      let delivered = false;
      const reader = {{
        async read() {{
          if (delivered) return {{ done: true }};
          delivered = true;
          return {{ done: false, value: new TextEncoder().encode(events) }};
        }},
        async cancel() {{}},
      }};
      const added = [];
      const spinner = {{ createElement: () => ({{}}), start() {{}}, destroy() {{}} }};
      const resumeStream = new Function(
        'hasActiveStream', 'fetch', 'API_BASE', '_streamRunIds', 'document',
        'sessionModule', '_shortModel', 'uiModule', '_applyModelColor',
        '_resumingStreams', '_resumeStreams', 'spinnerModule', 'markdownModule', '_streamDisplayText',
        'chatRenderer',
        {json.dumps('return (' + _FUNCTION + ');')}
      )(
        () => false,
        async () => ({{
          ok: true, headers: {{ get: () => 'run-1' }}, body: {{ getReader: () => reader }}
        }}),
        '/api', new Map(),
        {{ getElementById: () => box, createElement: () => holder }},
        {{
          getSessions: () => [{{ id: sessionId, model: 'route-model' }}],
          getCurrentSessionId: () => sessionId,
        }},
        (value) => value,
        {{ esc: (value) => value, scrollHistory() {{}} }},
        () => {{}}, new Set(), new Map(),
        {{ create: () => spinner }},
        {{ normalizeThinkingMarkup: (value) => value, squashOutsideCode: (value) => value, mdToHtml: (value) => value }},
        (value) => value,
        {{ addMessage: (...args) => added.push(args), recordSessionMetricsCost() {{}} }}
      );

      console.log(JSON.stringify({{
        attached: await resumeStream(sessionId),
        liveRole: role.textContent,
        timestampPreserved: role.timestamp === timestamp,
        finalRole: added[0]?.[3]?.character_name || '',
        finalText: added[0]?.[1] || '',
      }}));
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
        "attached": True,
        "liveRole": "Mira ",
        "timestampPreserved": True,
        "finalRole": "Mira",
        "finalText": "<think>Reasoned.</think>Hello from Mira.",
    }
