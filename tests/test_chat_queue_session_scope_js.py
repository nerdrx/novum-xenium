import json
import shutil
import subprocess
from pathlib import Path

import pytest


_REPO = Path(__file__).resolve().parents[1]


def test_queued_request_stays_with_origin_chat_and_stop_is_scoped():
    if not shutil.which("node"):
        pytest.skip("node is not installed")

    source = (_REPO / "static/js/chat.js").read_text()

    def function(start, end):
        begin = source.index(start)
        return source[begin : source.index(end, begin)]

    functions = "\n".join(
        [
            function("function _renderQueuedRequestsForCurrentSession()", "function _watchQueuedSessionChanges"),
            function("function _watchQueuedSessionChanges()", "function _removeQueuedRequest"),
            function("function _removeQueuedRequest(id)", "function _setComposerAndSend"),
            function("function _setComposerAndSend(message", "function _promoteQueuedRequest"),
            function("function _promoteQueuedRequest(id)", "function _queueAgentRequest"),
            function("function _queueAgentRequest(message)", "export function queueStreamingComposerRequest"),
            function("export function queueStreamingComposerRequest()", "function _drainQueuedAgentRequests").replace("export function ", "function "),
            function("function _drainQueuedAgentRequests()", "\n\n\n  /**\n   * Handle chat form submission"),
        ]
    )
    script = f"""
      const assert = require('node:assert/strict');
      let currentSessionId = 'chat-A';
      let isStreaming = true;
      let _sendInFlight = false;
      let _pendingApprovedPlan = null;
      let _queuedRequestSeq = 0;
      let _queuedDrainTimer = null;
      let _queuedBubbleHost = null;
      let _queuedBubbleRenderKey = '';
      let _queuedBubbleObserver = null;
      const _queuedAgentRequests = [];
      const timers = [];
      const sent = [];
      const stopped = [];
      const input = {{ value: '', dispatchEvent() {{}} }};
      const sessionModule = {{ getCurrentSessionId: () => currentSessionId }};
      const uiModule = {{ el: () => input, autoResize() {{}}, showToast() {{}} }};
      const fileHandlerModule = {{ getPendingCount: () => 0 }};
      const window = {{}};
      const history = {{}};
      const document = {{
        getElementById: id => id === 'chat-history' ? history : null,
        querySelector: selector => selector === '.send-btn' ? {{ click() {{ stopped.push(currentSessionId); }} }} : null,
      }};
      let observerCallback = null;
      class MutationObserver {{ constructor(callback) {{ observerCallback = callback; }} observe() {{}} }}
      function setTimeout(callback) {{ timers.push(callback); return timers.length; }}
      function clearTimeout() {{}}
      function Event(type) {{ this.type = type; }}
      function _ensureQueuedBubbleHost() {{
        if (_queuedBubbleHost?.isConnected) return _queuedBubbleHost;
        _queuedBubbleHost = {{
          isConnected: true, children: [],
          appendChild(node) {{ node.parentNode = this; this.children.push(node); return node; }},
          remove() {{ this.isConnected = false; this.children = []; }},
        }};
        return _queuedBubbleHost;
      }}
      function _createQueuedBubble(item) {{
        const node = {{
          parentNode: null,
          remove() {{ if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(x => x !== this); this.parentNode = null; }},
        }};
        _ensureQueuedBubbleHost().appendChild(node);
        return node;
      }}
      function handleChatSubmit(event) {{
        sent.push({{ message: input.value, sessionId: currentSessionId, expectedSessionId: event.expectedSessionId }});
        return Promise.resolve();
      }}
      {functions}

      // Install the actual observer hook, then queue while A is streaming.
      _watchQueuedSessionChanges();
      assert.equal(typeof observerCallback, 'function');
      input.value = 'continue task A';
      assert.equal(queueStreamingComposerRequest(), true);
      assert.equal(input.value, '');
      input.value = 'later queued task A';
      assert.equal(queueStreamingComposerRequest(), true);
      assert.equal(input.value, '');
      const itemId = _queuedAgentRequests[0].id;
      const promotedItemId = _queuedAgentRequests[1].id;
      assert.equal(_queuedAgentRequests[0].sessionId, 'chat-A');
      assert.equal(_queuedBubbleHost.children.length, 2);

      // Switching to B hides A's bubble. Completion of A cannot send it to B.
      currentSessionId = 'chat-B';
      observerCallback();
      assert.equal(_queuedBubbleHost, null);
      isStreaming = false;
      _drainQueuedAgentRequests();
      assert.equal(timers.length, 0);
      input.value = 'draft for B';

      // A stale A bubble click cannot Stop B.
      _promoteQueuedRequest(itemId);
      assert.deepEqual(stopped, []);
      assert.equal(_queuedAgentRequests.length, 2);
      assert.equal(input.value, 'draft for B');
      assert.equal(sent.length, 0);

      // Returning to A restores its bubble; active promotion stops only A and
      // retains the queued item until A's stream is done.
      currentSessionId = 'chat-A';
      observerCallback();
      assert.equal(_queuedBubbleHost.children.length, 2);
      _drainQueuedAgentRequests();
      timers.shift()(); // schedule the next-tick send for A
      currentSessionId = 'chat-B';
      observerCallback();
      input.value = 'draft for B';
      timers.shift()(); // stale next-tick callback must preserve both queue items
      assert.equal(sent.length, 0);
      assert.equal(_queuedAgentRequests.length, 2);
      assert.equal(input.value, 'draft for B');

      // Returning to A restores both. Promote the second item and ensure it
      // takes priority rather than silently sending the queue head instead.
      currentSessionId = 'chat-A';
      observerCallback();
      isStreaming = true;
      _promoteQueuedRequest(promotedItemId);
      assert.deepEqual(stopped, ['chat-A']);
      assert.equal(_queuedAgentRequests.length, 2);
      timers.shift()(); // stale idle-drain timer exits while A is streaming
      isStreaming = false;
      _drainQueuedAgentRequests();
      timers.shift()(); // queue drain
      timers.shift()(); // guarded zero-delay submit
      assert.deepEqual(sent, [{{ message: 'later queued task A', sessionId: 'chat-A', expectedSessionId: 'chat-A' }}]);
      assert.equal(_queuedAgentRequests.length, 1);
      _drainQueuedAgentRequests();
      timers.shift()();
      timers.shift()();
      assert.deepEqual(sent[1], {{ message: 'continue task A', sessionId: 'chat-A', expectedSessionId: 'chat-A' }});
      assert.equal(_queuedAgentRequests.length, 0);
      assert.equal(_queuedBubbleHost, null);

      // A duplicate stale completion cannot dispatch the same item twice.
      _drainQueuedAgentRequests();
      assert.equal(timers.length, 0);
      assert.equal(sent.length, 2);
      console.log('queued request session scope ok');
    """
    result = subprocess.run(
        ["node", "-e", script],
        capture_output=True,
        text=True,
        cwd=_REPO,
        timeout=30,
    )

    assert result.returncode == 0, result.stderr
