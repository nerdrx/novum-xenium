"""Source-level wiring guards for live-thinking stream lifecycle.

The pure scheduler suite covers timing behavior. These assertions pin the
browser-only integration seams that are impractical to import without the full
application DOM.
"""

from pathlib import Path


_CHAT = (Path(__file__).resolve().parent.parent / "static" / "js" / "chat.js").read_text(
    encoding="utf-8"
)


def _between(start: str, end: str) -> str:
    return _CHAT.split(start, 1)[1].split(end, 1)[0]


def test_in_thinking_delta_short_circuits_before_cumulative_normalization():
    delta_handler = _between(
        "let _delta = json.delta;",
        "} else if (json.type === 'research_progress')",
    )
    delta_path = _between(
        "// Detect thinking-in-progress:",
        "} else if (json.type === 'research_progress')",
    )
    guard = "if (!_thinkingAnalysisGate.shouldAnalyze(roundText, {"
    normalize = "markdownModule.normalizeThinkingMarkup(roundText)"
    assert guard in delta_path
    assert delta_path.index(guard) < delta_path.index(normalize)
    assert "_queueLiveThinking(roundText);" in delta_path
    assert "createThinkingAnalysisGate" in _CHAT
    projector_append = "_roundDisplayProjector.append(_delta, roundText);"
    assert projector_append in delta_handler
    assert delta_handler.index(projector_append) < delta_handler.index(guard)
    assert "_renderStream({ knownNormal: true, displayText: _roundDisplayProjector.current() });" in delta_path
    assert "_replyDisplayProjector.append(_delta, roundReplyText)" in delta_path


def test_short_close_grace_expires_without_another_delta():
    assert "function _scheduleThinkingGrace()" in _CHAT
    grace = _between(
        "function _scheduleThinkingGrace()",
        "function _replyAfterClosedThinking",
    )
    assert "setTimeout(() =>" in grace
    assert "_finishLiveThinkingTransition();" in grace
    cancel = _between("_cancelLiveThinkingWork = () =>", "function _finalizeLiveThinking")
    assert "_cancelThinkingGrace();" in cancel
    delta_path = _between(
        "// Detect thinking-in-progress:",
        "} else if (json.type === 'research_progress')",
    )
    false_close = _between(
        "// Detect false close:",
        "if (hasUnclosedThink && !isThinking)",
    )
    assert "Do NOT require a prior unclosed delta" in false_close
    assert "_afterClose &&" in false_close
    assert "&& isThinking" not in false_close.split("let _falseCloseDeadline", 1)[1].split("if (isThinking)", 1)[0]
    assert "_thinkingRecheckAt = _falseCloseDeadline || 0;" in delta_path


def test_terminal_paths_use_one_authoritative_rich_round_render():
    tool_path = _between(
        "} else if (json.type === 'tool_start') {",
        "} else if (json.type === 'tool_output') {",
    )
    assert "_endLiveThinkingSection({ rich: false });" in tool_path
    assert tool_path.count("_finalizeRoundRender();") == 1
    assert "_renderStream();" not in tool_path

    agent_path = _between(
        "} else if (json.type === 'agent_step') {",
        "} else if (json.type === 'budget_exceeded') {",
    )
    assert "_endLiveThinkingSection({ rich: false });" in agent_path
    assert agent_path.count("_finalizeRoundRender();") == 1
    assert "if (!roundFinalized)" not in agent_path

    catch_path = _between(
        "// foreground session's text.\n      const _isBgCatch",
        "} finally {",
    )
    assert "if (_isBgCatch)" in catch_path
    assert "_cancelLiveThinkingWork();" in catch_path
    assert "_catchTerminalView = _finalizeInterruptedView();" in catch_path
    assert "_finalizeRoundRender();" not in catch_path
    assert "_endThinkingOnTerminalPath({ rich: false });" in catch_path
    assert "const _catchViewHolder = _catchTerminalView?.holder || holder;" in catch_path

    round_finalizer = _between(
        "_finalizeRoundRender = () => {",
        "_finalizeInterruptedView = () => {",
    )
    assert "if (roundFinalized) return roundFinalization;" in round_finalizer
    assert round_finalizer.index("processWithThinking") < round_finalizer.rindex("roundFinalized = true;")
    assert "lastContentRoundHolder = terminalHolder;" in round_finalizer

    interrupted_finalizer = _between(
        "_finalizeInterruptedView = () => {",
        "function _replyAfterClosedThinking",
    )
    assert "finalization?.hasContent" in interrupted_finalizer
    assert "lastContentRoundHolder || finalization?.holder" in interrupted_finalizer

    stop_path = _between(
        "// Render whatever was accumulated so far",
        "// Reset button state",
    )
    assert "const _stoppedViewHolder = _terminalView?.holder || currentHolder;" in stop_path
    assert "_stoppedViewHolder.querySelector('.body').appendChild(stoppedIndicator);" in stop_path

    done_path = _between(
        "if (data === '[DONE]') {",
        "try {\n              const json = JSON.parse(data);",
    )
    assert "_finalizeLiveThinking(_closedThinkingText(roundText), false);" in done_path
    assert "_renderStream();" not in done_path

    post_loop = _between(
        "if (!_streamSawDone) {",
        "// --- Final render (skip if stream was ever backgrounded or currently in background) ---",
    )
    assert "_cancelLiveThinkingWork();" in post_loop
    assert "_renderStream();" not in post_loop

    recovery_path = _between(
        "function _tryAutoRecover(holder, accumulated, sessionId)",
        "function _removeStallBanner()",
    )
    assert "processWithThinking" not in recovery_path


def test_detach_synchronously_cancels_delayed_view_work():
    registration = _between("_activeStreams.set(streamSessionId", "_syncForegroundStreamGlobals();")
    assert "cancelViewWork: () => _cancelLiveThinkingWork()" in registration

    detach = _between("export function detachCurrentStream", "// _notifyStreamComplete")
    cancel = "if (active.cancelViewWork) active.cancelViewWork();"
    background = "_backgroundStreams.set(sessionId"
    assert cancel in detach
    assert detach.index(cancel) < detach.index(background)


def test_background_spinner_distinguishes_waiting_from_streaming():
    background = _between(
        "export function checkBackgroundStream(sessionId)",
        "async function refreshRecoveryCheckpoint",
    )
    assert "_backgroundStreamStatusText(entry, startedAt)" in background
    assert "spinner.updateMessage(nextStatusText)" in background
    assert "_backgroundStreamStatusText(curPoll || entry, startedAt)" in background
    status_helper = _between(
        "function _backgroundStreamStatusText(",
        "let API_BASE =",
    )
    assert "Response streaming in background · ${elapsed}" in status_helper
    assert "${entry.accumulated.length} characters received" in status_helper
    assert "The reply will appear when this background run finishes." in status_helper
    assert "Stop or retry if stuck." in status_helper


def test_foreground_wait_copy_reports_elapsed_without_guessing_cause():
    wait_messages = _between(
        "const scheduleFirstTokenWaitMessages = () =>",
        "const clearProcessingProbe = () =>",
    )
    assert "_formatStreamElapsed(streamStartedAt)" in wait_messages
    assert "The cause is unknown" in wait_messages
    assert "Stop or retry if stuck." in wait_messages
    assert "Large local model is pre-filling context" not in wait_messages
    assert "spinner.updateMessage('Preparing request; waiting for model output.')" in _CHAT
    timeout = _between(
        "if (timedOut || abortReason === 'timeout')",
        "if (abortReason === 'offline')",
    )
    assert "_clientTimeoutMessage(_isAgent, streamStartedAt, !!accumulated)" in timeout
    client_timeout = _between(
        "function _clientTimeoutMessage(",
        "function _backgroundStreamStatusText(",
    )
    assert "client timeout" in client_timeout
    assert "No model output arrived; the cause is unknown." in client_timeout
    assert "Partial output was preserved." in client_timeout
    explicit_stop = _between(
        "if (abortCtrl && abortNow)",
        "// Don't set to null here",
    )
    assert "if (stopServer) abortCtrl._reason = 'user-stop';" in explicit_stop


def test_background_terminal_error_keeps_provider_message():
    catch_path = _between(
        "if (_isBgCatch) {\n        // Error happened while backgrounded",
        "} else {\n        // Stop streaming TTS on any error/abort",
    )
    assert "err && err.message ? err.message : String(err || 'Background stream failed')" in catch_path
    assert "_clientTimeoutMessage(_isAgent, bgErr.startedAt || streamStartedAt, !!accumulated)" in catch_path
    background = _between(
        "if (entry.status === 'error')",
        "if (entry.status === 'running')",
    )
    assert "_appendBackgroundStreamError(box, entry.error)" in background
    running = _between(
        "if (entry.status === 'running')",
        "async function refreshRecoveryCheckpoint",
    )
    assert "_appendBackgroundStreamError(box, curPoll.error)" in running
    error_helper = _between(
        "function _appendBackgroundStreamError(box, message)",
        "async function refreshRecoveryCheckpoint",
    )
    assert "error.textContent" in error_helper
    detach = _between(
        "export function detachCurrentStream(sessionId)",
        "// _notifyStreamComplete",
    )
    assert "startedAt: active.startedAt || Date.now()" in detach
    assert "Reload to check saved progress" in _CHAT
    assert "will not replay the old tool calls" in _CHAT
