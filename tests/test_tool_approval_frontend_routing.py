import re
import json
import shutil
import subprocess
from pathlib import Path
import re
from tests.helpers.stylesheets import app_css

import pytest


def test_tool_approval_bypasses_polymorphic_send_button_actions():
    root = Path(__file__).resolve().parents[1]
    chat = (root / "static/js/chat.js").read_text(encoding="utf-8")
    stream = (root / "static/js/chatStream.js").read_text(encoding="utf-8")

    # Approval sends through the submit form directly; the polymorphic button
    # can mean New Chat or Record voice when the composer is empty.
    assert "if (form.requestSubmit) form.requestSubmit();" in chat
    assert "form.dataset.odysseusControlPlaneSubmit = 'tool-approval';" in chat
    assert "sendButton.click()" not in chat
    app = (root / "static/app.js").read_text(encoding="utf-8")
    assert "if (_submitting && !isToolApprovalSubmit) return;" in app
    assert "sendButton.dataset.mode = ''" not in stream


def test_tool_approval_submits_pending_chat_without_clicking_new_chat_button():
    if not shutil.which("node"):
        pytest.skip("node is not installed")
    root = Path(__file__).resolve().parents[1]
    source = (root / "static/js/chat.js").read_text(encoding="utf-8")
    start = source.index("function _submitToolApprovalWhenIdle(approvalId) {")
    end = source.index("\n\n  function _fmtContextNumber", start)
    handler = source[start:end]
    handler = handler[:handler.index("\n  window.addEventListener('odysseus:notes-context-selected'")]
    script = f"""
      const listeners = {{}};
      const timers = [];
      const calls = {{ submits: 0, buttonClicks: 0, events: [] }};
      const input = {{ value: '', dataset: {{}} }};
      const form = {{ dataset: {{}},
        requestSubmit() {{ calls.submits++; calls.submitFlag = this.dataset.odysseusControlPlaneSubmit || ''; }},
        dispatchEvent(event) {{ calls.events.push(event.type); return true; }},
      }};
      const button = {{ click() {{ calls.buttonClicks++; }} }};
      const document = {{
        addEventListener(type, callback) {{ listeners[type] = callback; }},
        getElementById(id) {{ return id === 'message' ? input : id === 'chat-form' ? form : null; }},
        querySelector(selector) {{ return selector === '.send-btn' ? button : null; }},
      }};
      const run = new Function(
        'document', 'setTimeout', 'Event',
        {json.dumps('let isStreaming = true, _sendInFlight = false, _pendingToolApproval = null; ' + handler + '; return { getPending: () => _pendingToolApproval, setIdle: () => { isStreaming = false; } };')}
      )(document, (fn) => {{ timers.push(fn); }}, Event);
      listeners['odysseus:tool-approval']({{ detail: {{
        approval_id: 'approval-42', decision: 'approve_task', document_id: 'doc-7',
        tool: 'write_file',
      }} }});
      const waiting = calls.submits === 0 && timers.length === 1;
      input.value = 'draft kept during approval';
      // Simulate the existing busy-wait callback after the stream completes.
      run.setIdle();
      timers.shift()();
      console.log(JSON.stringify({{
        waiting, submits: calls.submits, buttonClicks: calls.buttonClicks,
        pending: run.getPending(), events: calls.events,
        submitFlag: calls.submitFlag,
      }}));
    """
    result = subprocess.run(
        ["node", "--input-type=module"], input=script, capture_output=True,
        text=True, cwd=root, timeout=30,
    )
    assert result.returncode == 0, result.stderr
    state = json.loads(result.stdout)
    assert state["waiting"] is True
    assert state["submits"] == 1
    assert state["submitFlag"] == "tool-approval"
    assert state["buttonClicks"] == 0
    assert state["pending"] == {
            "approval_id": "approval-42", "decision": "approve_task",
            "document_id": "doc-7", "draft": "draft kept during approval",
            "tool": "write_file",
    }


def test_app_submit_debounce_only_yields_for_control_plane_and_keeps_special_routes():
    if not shutil.which("node"):
        pytest.skip("node is not installed")
    root = Path(__file__).resolve().parents[1]
    app = (root / "static/app.js").read_text(encoding="utf-8")
    start = app.index("  function handleSubmit(e) {")
    end = app.index("\n\n  chatForm.onsubmit = handleSubmit;", start)
    handler = app[start:end]
    handle_submit_source = json.dumps(
        "let chatForm = document.getElementById('chat-form'), _submitting = false; "
        + handler + "; return handleSubmit;"
    )
    script = f"""
      const timers = [];
      console.log = () => {{}};
      const calls = {{ chat: 0, compare: 0, group: 0, hidden: 0 }};
      const input = {{ value: 'group work', style: {{}} }};
      const form = {{ dataset: {{}} }};
      let compareActive = false, groupActive = false;
      const document = {{
        getElementById(id) {{ return id === 'chat-form' ? form : id === 'message' ? input : null; }},
        querySelector() {{ return null; }},
      }};
      const handleSubmit = new Function(
        'document', '_bumpChatPriority', 'compareModule', 'groupModule', 'workspaceModule',
        'chatRenderer', 'uiModule', 'chatModule', 'originalSubmit', 'setTimeout',
        {handle_submit_source}
      )(
        document, () => {{}},
        {{ isActive: () => compareActive, handleCompareSubmit: () => calls.compare++ }},
        {{ isActive: () => groupActive, isRunning: () => false, sendMessage: () => calls.group++ }},
        {{ getWorkspaceAvailabilityError: () => '' }},
        {{ hideWelcomeScreen() {{ calls.hidden++; }}, addMessage() {{}} }},
        {{ showToast() {{}} }}, {{ handleChatSubmit() {{ calls.chat++; }} }},
        () => calls.chat++, (fn, delay) => timers.push({{ fn, delay }}),
      );
      const event = () => ({{ preventDefault() {{}} }});
      handleSubmit(event());
      handleSubmit(event()); // ordinary duplicate remains debounced
      form.dataset.odysseusControlPlaneSubmit = 'tool-approval';
      handleSubmit(event());
      delete form.dataset.odysseusControlPlaneSubmit;
      compareActive = true;
      form.dataset.odysseusControlPlaneSubmit = 'tool-approval';
      handleSubmit(event());
      compareActive = false;
      groupActive = true;
      handleSubmit(event());
      process.stdout.write(JSON.stringify({{ calls, timerDelays: timers.map(t => t.delay) }}));
    """
    result = subprocess.run(
        ["node", "--input-type=module"], input=script, capture_output=True,
        text=True, cwd=root, timeout=30,
    )
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout) == {
        "calls": {"chat": 2, "compare": 1, "group": 1, "hidden": 3},
        "timerDelays": [300, 300, 300, 300],
    }


def test_hidden_chat_form_request_submit_has_no_required_textarea_to_block_it():
    root = Path(__file__).resolve().parents[1]
    html = (root / "static/index.html").read_text(encoding="utf-8")
    form_start = html.index('<form id="chat-form"')
    form_end = html.index("</form>", form_start)
    textarea = re.search(r'<textarea[^>]*id="message"[^>]*>', html)
    assert textarea
    assert textarea.start() < form_start or textarea.start() > form_end
    assert "required" in textarea.group(0)
    assert 'form="chat-form"' not in textarea.group(0)
    assert 'style="display:none;"' in html[form_start:form_end]


def test_ask_user_card_has_no_close_button_and_chat_scale_text():
    root = Path(__file__).resolve().parents[1]
    renderer = (root / "static/js/chatRenderer.js").read_text(encoding="utf-8")
    styles = app_css()

    assert "closeBtn.className = 'modal-close ask-user-close';" not in renderer
    assert "closeBtn.setAttribute('aria-label', 'Dismiss question');" not in renderer
    assert "card.appendChild(head);" not in renderer
    assert "otherSend.textContent" not in renderer
    assert "otherSend.innerHTML" in renderer
    assert 'd="M12 19V5M5 12l7-7 7 7"' in renderer
    assert "ask-user-card-attached" in renderer
    assert "has-ask-user-bottom" in renderer
    assert ".ask-user-head" in styles
    assert ".ask-user-close" in styles
    assert "display: none !important;" in styles
    question_block = styles[styles.index(".ask-user-question {"):styles.index(".ask-user-options {")]
    card_block = styles[styles.index(".ask-user-card {"):styles.index(".ask-user-card-attached {")]
    attached_block = styles[styles.index(".ask-user-card-attached {"):styles.index(".ask-user-card-attached::before {")]
    connector_block = styles[styles.index(".ask-user-card-attached::before {"):styles.index("/* Focused only programmatically", styles.index(".ask-user-card-attached::before {"))]
    label_start = styles.index(".ask-user-option-label {", styles.index(".ask-user-option-label,"))
    label_block = styles[label_start:styles.index(".ask-user-option-desc {", label_start)]
    assert "color: var(--fg);" in question_block
    assert "max-width: 85%;" in card_block
    assert "isolation: isolate;" in card_block
    assert "margin-left: 8px;" in attached_block
    assert "width: 85%;" in attached_block
    assert "max-width: 85%;" in attached_block
    assert "z-index: -1;" in connector_block
    assert "color: var(--accent, var(--red));" in label_block
    assert "font-size: 11px;" in styles
    assert "font-size: 11px !important;" in styles
    assert "background: var(--ai-bubble-bg, var(--panel));" in styles
    assert "background: var(--send-btn-bg, var(--red));" in styles
    assert "background: color-mix(in srgb, var(--fg) 4%, var(--panel));" not in styles
    assert ".ask-user-other-input" in styles
    assert ".ask-user-answer" in styles
    assert ".ask-user-answer-value" in styles
    assert ".ask-user-card-attached::before" in styles
    assert ".agent-thread.has-ask-user-bottom::before" in styles


def test_scroll_bottom_button_uses_dropdown_caret_glyph():
    root = Path(__file__).resolve().parents[1]
    html = (root / "static/index.html").read_text(encoding="utf-8")
    styles = app_css()

    assert 'class="scroll-nav-caret"' in html
    assert "&#9662;" in html
    assert ">▼</button>" not in html
    assert ".scroll-nav-caret" in styles
    assert "font-family: Arial, Helvetica, sans-serif;" in styles


def test_ask_user_number_shortcuts_reuse_option_click_path():
    root = Path(__file__).resolve().parents[1]
    renderer = (root / "static/js/chatRenderer.js").read_text(encoding="utf-8")
    start = renderer.index("function _handleAskUserShortcut(event)")
    end = renderer.index("document.addEventListener('keydown', _handleAskUserShortcut);", start)
    shortcut = renderer[start:end]

    assert "if (!/^[1-3]$/.test(event.key)) return;" in shortcut
    assert "event.repeat" in shortcut
    assert "event.ctrlKey" in shortcut
    assert "event.altKey" in shortcut
    assert "event.metaKey" in shortcut
    assert "event.shiftKey" in shortcut
    assert "input, textarea, select, [contenteditable=\"true\"]" in shortcut
    assert "card.querySelectorAll('.ask-user-option')[Number(event.key) - 1]" in shortcut
    assert "event.preventDefault();" in shortcut
    assert "option.click();" in shortcut


def test_digit_shortcuts_never_answer_a_tool_approval_card():
    """A stray digit must not grant a scope the user did not deliberately pick."""

    root = Path(__file__).resolve().parents[1]
    renderer = (root / "static/js/chatRenderer.js").read_text(encoding="utf-8")
    start = renderer.index("function _handleAskUserShortcut(event)")
    end = renderer.index("document.addEventListener('keydown', _handleAskUserShortcut);", start)
    shortcut = renderer[start:end]

    assert "if (card.dataset.askUserKind === 'tool_approval') return;" in shortcut
    # The renderer has to label the card for that guard to ever fire.
    assert (
        "card.dataset.askUserKind = isToolApproval ? 'tool_approval' : 'question';"
        in renderer
    )


def test_ask_user_renderer_accepts_scoped_root_and_submit_callback():
    root = Path(__file__).resolve().parents[1]
    renderer = (root / "static/js/chatRenderer.js").read_text(encoding="utf-8")

    assert "const chatBox = renderOptions.root || document.getElementById('chat-history');" in renderer
    assert "const onSubmit = typeof renderOptions.onSubmit === 'function'" in renderer
    assert "kind: 'answer'" in renderer
    assert "kind: 'tool_approval'" in renderer
    assert "function _markAskUserAnswered(card, text)" in renderer
    assert "function _answerAskUserCards(root, text)" in renderer
    assert "if (accepted !== false) _markAskUserAnswered(card, text);" in renderer
    assert "if (accepted !== false) _markAskUserAnswered(card, label);" in renderer
    assert "scope.querySelectorAll('.ask-user-card:not(.ask-user-answered)')" in renderer
    assert "if (role === 'user') _answerAskUserCards(box," in renderer
    assert "if (role === 'user') removeAskUserCards(box);" not in renderer
    assert "document.dispatchEvent(new CustomEvent('odysseus:tool-approval', { detail }))" in renderer


def test_every_changed_approval_module_is_cache_busted_together():
    """Keep shared chat and compare modules on a consistent cached version."""

    root = Path(__file__).resolve().parents[1]
    sources = [
        path.read_text(encoding="utf-8")
        for path in (root / "static").rglob("*")
        if path.suffix in {".js", ".html"}
    ]

    def versions(module_name):
        pattern = re.compile(rf"{re.escape(module_name)}\?v=([A-Za-z0-9_-]+)")
        return [match for source in sources for match in pattern.findall(source)]

    # Every URL for a stateful module must resolve to one ES-module instance.
    # Different query strings create distinct modules and duplicate listeners.
    for module_name in ("chatRenderer.js", "chatStream.js", "chat.js"):
        found = versions(module_name)
        assert found, f"missing cache-busted reference for {module_name}"
        assert len(set(found)) == 1, f"split module graph for {module_name}: {found}"

    # Shared modules must have one URL apiece. ui.js is consistently versioned
    # throughout the graph; the other shared modules remain unversioned.
    for module_name in ("sessions.js", "memory.js", "markdown.js", "models.js"):
        assert any(module_name in source for source in sources)
        assert not versions(module_name), f"split module graph for {module_name}"
    assert len(set(versions("ui.js"))) == 1

    compare_stream = (root / "static/js/compare/stream.js").read_text(encoding="utf-8")
    compare_vote = (root / "static/js/compare/vote.js").read_text(encoding="utf-8")
    renderer_version = versions("chatRenderer.js")[0]
    assert f"chatRenderer.js?v={renderer_version}" in compare_stream
    assert f"chatRenderer.js?v={renderer_version}" in compare_vote
    assert len(set(versions("compare/index.js"))) == 1
