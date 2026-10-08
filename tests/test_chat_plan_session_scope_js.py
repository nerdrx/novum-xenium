"""Exercise plan button and request-scoping logic from chat.js under Node."""

import json
import shutil
import subprocess
from pathlib import Path

import pytest


_REPO = Path(__file__).resolve().parents[1]


def test_inline_plan_approval_uses_its_chat_and_cannot_cross_navigation():
    if not shutil.which("node"):
        pytest.skip("node is not installed")

    source = (_REPO / "static/js/chat.js").read_text()
    helper_start = source.index("let _pendingApprovedPlan = null;")
    helper_end = source.index("function _escapeQueueText", helper_start)
    helper_source = source[helper_start:helper_end]
    composer_start = source.index("function _setComposerAndSend(message")
    composer_end = source.index("function _promoteQueuedRequest", composer_start)
    composer_source = source[composer_start:composer_end]
    submit_start = source.index("export async function handleChatSubmit")
    request_start = source.index("const toggleState = Storage.loadToggleState();", submit_start)
    request_end = source.index("if (el('web-toggle').checked)", request_start)
    request_source = source[request_start:request_end]
    extension_source = "\n".join([
        helper_source,
        composer_source,
        "globalThis.attach = _attachPlanActions;",
            "globalThis.pendingPlan = () => _pendingApprovedPlan;",
            "globalThis.clearPendingPlan = () => { _pendingApprovedPlan = null; };",
        "globalThis.planForSession = _pendingPlanForSession;",
        "globalThis.sendComposer = _setComposerAndSend;",
        "globalThis.buildRequest = function(sessionId) {",
            "  const streamSessionId = sessionId;",
            "  const expectedSessionId = arguments[2] ? sessionId : null;",
            "  const e = { pendingPlan: arguments[2] ? _pendingApprovedPlan : null };",
        "  const Storage = { loadToggleState: () => ({ mode: 'chat', plan_mode: false }) };",
        "  const el = () => ({ checked: false });",
        "  const isIncognitoForSend = false, recoveryForSend = null;",
        "  const msg = arguments[1] || 'hello';",
        "  const documentModule = null, activeDocIdForSend = null;",
        "  const fd = { values: [], append(key, value) { this.values.push([key, value]); } };",
        request_source,
        "  return fd.values;",
        "};",
    ])
    extension_source_literal = json.dumps(extension_source)

    script = f"""
      const assert = require('node:assert/strict');
      const vm = require('node:vm');
      const toasts = [];
      let currentSessionId = 'chat-A';
      let activeStream = '';
      const timers = [];
      const sent = [];
      const input = {{ value: '', dispatchEvent() {{}} }};
      const callbacks = {{}};
      const buttons = {{
        '.plan-inline-execute': {{ addEventListener: (_event, fn) => callbacks.execute = fn }},
        '.plan-inline-clear': {{ addEventListener: (_event, fn) => callbacks.clear = fn }},
      }};
      const context = {{
        _sendInFlight: false,
        document: {{ createElement: () => ({{ querySelector: selector => buttons[selector] }}) }},
        sessionModule: {{ getCurrentSessionId: () => currentSessionId }},
        hasActiveStream: sid => activeStream === sid,
        uiModule: {{ showToast: message => toasts.push(message), el: () => input }},
        window: {{ __odysseusSetPlanMode() {{}}, __odysseusSetChatMode() {{}} }},
        Event: function(type) {{ this.type = type; }},
        setTimeout: callback => (timers.push(callback), timers.length),
        handleChatSubmit: event => {{ sent.push({{ sessionId: currentSessionId, expectedSessionId: event.expectedSessionId }}); return Promise.resolve(); }},
      }};
      vm.createContext(context);
      vm.runInContext({extension_source_literal}, context);

      function target() {{
        return {{ querySelector: () => null, appendChild(node) {{ this.actions = node; }} }};
      }}
      function attachAndClick(plan, sid) {{
        const holder = target();
        context.attach(holder, plan, sid);
        callbacks.execute();
      }}

      // An old bubble in A uses its own plan and one-shot approval.
      attachAndClick('Plan from bubble A', 'chat-A');
      assert.deepEqual(JSON.parse(JSON.stringify(context.pendingPlan())), {{
        sessionId: 'chat-A', message: 'Execute the approved plan.', plan: 'Plan from bubble A'
      }});

      assert.deepEqual(JSON.parse(JSON.stringify(context.buildRequest('chat-A', 'Execute the approved plan.', true))), [
        ['mode', 'agent'], ['plan_mode', 'false'], ['approved_plan', 'Plan from bubble A']
      ]);
      timers.shift()();
      assert.deepEqual(JSON.parse(JSON.stringify(sent)), [
        {{ sessionId: 'chat-A', expectedSessionId: 'chat-A' }}
      ]);

      // Navigation before the zero-delay submit callback must cancel the
      // send, preserving a draft composed in B and clearing A's pending plan.
      attachAndClick('Plan from bubble A', 'chat-A');
      currentSessionId = 'chat-B';
      input.value = 'draft for B';
      timers.shift()();
      assert.equal(sent.length, 1);
      assert.equal(input.value, 'draft for B');
      assert.equal(context.pendingPlan(), null);
      assert.deepEqual(JSON.parse(JSON.stringify(context.buildRequest('chat-B', 'Execute the approved plan.'))), [
        ['mode', 'agent'], ['plan_mode', 'false']
      ]);
      assert.equal(context.pendingPlan(), null);

      // Editing the composer after Execute also discards the one-shot approval.
      currentSessionId = 'chat-A';
      attachAndClick('Plan from bubble A', 'chat-A');
      context.clearPendingPlan(); // Ordinary sends clear unbound approval at submit entry.
      assert.deepEqual(JSON.parse(JSON.stringify(context.buildRequest('chat-A', 'hello'))), [
        ['mode', 'chat'], ['plan_mode', 'false']
      ]);
      assert.equal(context.pendingPlan(), null);

      // A stale button cannot arm an approval while another chat is selected.
      currentSessionId = 'chat-B';
      attachAndClick('Plan from bubble A', 'chat-A');
      assert.equal(context.pendingPlan(), null);
      assert.ok(toasts.some(message => /contains this plan/.test(message)));

      // An Execute click during that chat's active stream is a no-op, so a
      // Stop action cannot leave approval armed for a later send.
      currentSessionId = 'chat-A';
      activeStream = 'chat-A';
      attachAndClick('Plan from bubble A', 'chat-A');
      assert.equal(context.pendingPlan(), null);
      assert.ok(toasts.some(message => /current response to finish/.test(message)));
      console.log('plan session scope ok');
    """
    result = subprocess.run(
        ["node", "-e", script],
        capture_output=True,
        text=True,
        cwd=_REPO,
        timeout=30,
    )

    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "plan session scope ok"
