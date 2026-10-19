from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CHAT = (ROOT / "static/js/chat.js").read_text()


def test_queued_stack_is_consumed_as_one_ordered_message():
    assert "function _consumeQueuedRequestStack()" in CHAT
    assert "_queuedAgentRequests[i].sessionId === sid" in CHAT
    assert ".join('\\n\\n')" in CHAT


def test_queue_consumption_waits_for_session_and_stream_recheck():
    send = CHAT[CHAT.index("function _setComposerAndSend(") : CHAT.index("function _promoteQueuedRequest(id)")]
    assert send.index("expectedSessionId") < send.index("_consumeQueuedRequestStack()")
    assert send.index("_sendInFlight") < send.index("_consumeQueuedRequestStack()")
    assert "const sendMessage = stack ? stack.message : message" in send
    assert "queuedMessage: sendMessage" in send
    assert "if (!queuedItem)" in send


def test_automatic_drain_and_click_use_the_guarded_sender():
    drain = CHAT[CHAT.index("function _drainQueuedAgentRequests()") : CHAT.index("/**\n   * Handle chat form submission")]
    promote = CHAT[CHAT.index("function _promoteQueuedRequest(id)") : CHAT.index("function _queueAgentRequest(message)")]
    assert "_setComposerAndSend(next.message, next.sessionId, null, next)" in drain
    assert "_setComposerAndSend(item.message, item.sessionId, null, item)" in promote
    assert "_queuedAgentRequests.splice" not in promote


def test_queue_preserves_other_chats_and_async_send_races():
    import subprocess
    subprocess.run(
        ["node", "tests/helpers/test_queued_stack_session_races.cjs"],
        cwd=ROOT, check=True, capture_output=True, text=True,
    )
