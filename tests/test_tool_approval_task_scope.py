"""Task- and chat-scoped approval continuation coverage for issue #6112."""

import asyncio
import json
import re
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

import pytest

import src.tool_capabilities as tool_capabilities
from core.models import ChatMessage, Session
from src.tool_approval_scopes import (
    CHAT_SESSION_APPROVAL_CONTEXT_MARKER,
    TASK_APPROVAL_CONTINUATION_METADATA_FIELD,
    TASK_APPROVAL_ORIGIN_RUN_ID_FIELD,
    TASK_APPROVAL_QUESTION_RUN_ID_FIELD,
    ToolApprovalScope,
    sanitize_client_message_metadata,
    stamp_chat_session_grant,
)
from src.tool_approvals import (
    ExactToolApproval,
    TaskApprovalContinuationStore,
    ToolApprovalStore,
)
from src.tool_capabilities import ToolRunSecurityContext, capabilities_for_action


@pytest.fixture(autouse=True)
def _enable_approval_gate_for_legacy_gate_tests(monkeypatch):
    monkeypatch.setattr(tool_capabilities, "TOOL_APPROVAL_GATE_ENABLED", True)


def _pending(
    store: ToolApprovalStore,
    *,
    workspace=None,
    selected_tools=None,
    continuation_query="inspect the project using memory and skills",
):
    content = "printf exact"
    return store.create(
        owner="Alice",
        session_id="session-1",
        origin_run_id="run-1",
        tool_name="bash",
        content=content,
        workspace=workspace,
        external_untrusted_context_seen=True,
        selected_tools=selected_tools,
        continuation_query=continuation_query,
        capabilities=capabilities_for_action("bash", content),
    )


def test_card_offers_task_chat_session_and_deny_without_leaking_private_state():
    pending = _pending(
        ToolApprovalStore(),
        selected_tools=["manage_skills", "bash", "manage_skills"],
    )

    payload = pending.public_payload()

    assert payload["session_id"] == "session-1"
    assert [option["value"] for option in payload["options"]] == [
        "approve_task",
        "approve",
        "deny",
    ]
    assert [option["label"] for option in payload["options"]] == [
        "Allow for this task",
        "Allow for this chat session",
        "Deny",
    ]
    serialized = json.dumps(payload, sort_keys=True)
    assert "Allow once" not in serialized
    assert "selected_tools" not in serialized
    assert "continuation_query" not in serialized
    assert "manage_skills" not in serialized
    assert "inspect the project" not in serialized


def test_allow_for_task_bypasses_only_the_resumed_run_gate():
    store = ToolApprovalStore()
    pending = _pending(store, selected_tools=["bash", "manage_skills"])
    grant = store.consume(
        pending.approval_id,
        decision="approve_task",
        owner="alice",
        session_id="session-1",
    )

    assert grant is not None
    assert grant.scope is ToolApprovalScope.TASK
    assert grant.allow_remaining_actions is True
    assert grant.grants_chat_session is False
    assert grant.pending.continuation_query == (
        "inspect the project using memory and skills"
    )

    resumed = ToolRunSecurityContext(
        external_untrusted_context_seen=True,
        approval_gate_bypassed=grant.allow_remaining_actions,
    )
    assert resumed.decision_for("bash").allowed is True

    # A new ordinary user turn constructs a fresh context and asks again.
    fresh = ToolRunSecurityContext(external_untrusted_context_seen=True)
    assert fresh.decision_for("bash").allowed is False


def _task_continuation_fixture(
    monkeypatch,
    *,
    workspace=None,
    approval_ttl_seconds=600,
    continuation_ttl_seconds=600,
    created_at=None,
    continuation_query="inspect the project using memory and skills",
):
    monkeypatch.setattr("src.tool_approval_scopes._grant_key", lambda: b"test-key")
    approvals = ToolApprovalStore(ttl_seconds=approval_ttl_seconds)
    pending = _pending(
        approvals,
        workspace=workspace,
        selected_tools=["bash", "web_fetch"],
        continuation_query=continuation_query,
    )
    grant = approvals.consume(
        pending.approval_id,
        decision="approve_task",
        owner="alice",
        session_id="session-1",
    )
    assert grant is not None
    ask_user = {
        "question": "Which desktop architecture should I use?",
        "options": [
            {"label": "Create full Electron desktop app", "description": "Build desktop UI."},
            {"label": "Keep it as a web app", "description": "Use the browser."},
        ],
        "multi": False,
    }
    store = TaskApprovalContinuationStore(ttl_seconds=continuation_ttl_seconds)
    continuation_created_at = (
        pending.expires_at + 1
        if created_at == "after_approval_expiry"
        else created_at
    )
    marker = store.create(
        grant,
        question_run_id="run-2",
        approval_mode="auto",
        owner="alice",
        session_id="session-1",
        workspace=workspace,
        document_id=None,
        document_version=None,
        document_digest=None,
        ask_user=ask_user,
        now=continuation_created_at,
    )
    assert marker is not None
    return store, pending, ask_user, marker


def _consume_task_continuation(store, marker, ask_user, **overrides):
    context = {
        "approval_mode": "auto",
        "owner": "alice",
        "session_id": "session-1",
        "origin_run_id": "run-1",
        "question_run_id": "run-2",
        "workspace": None,
        "document_id": None,
        "document_version": None,
        "document_digest": None,
        "ask_user": ask_user,
        "reply": (
            "Create full Electron desktop app. FFmpeg-NX-Studio is fine; "
            "proceed with the original request."
        ),
    }
    context.update(overrides)
    return store.consume(marker, **context)


def test_auto_task_ask_user_choice_creates_one_use_continuation(monkeypatch):
    store, pending, ask_user, marker = _task_continuation_fixture(monkeypatch)

    continuation = _consume_task_continuation(store, marker, ask_user)

    assert continuation is not None
    assert continuation.allow_remaining_actions is True
    assert continuation.scope is ToolApprovalScope.TASK
    assert continuation.origin_run_id == pending.origin_run_id
    assert continuation.question_run_id == "run-2"
    assert continuation.source_approval_id == pending.approval_id
    assert continuation.selected_label == "Create full Electron desktop app"
    assert continuation.reply.endswith("proceed with the original request.")
    assert continuation.selected_tools == pending.selected_tools
    assert continuation.continuation_query == pending.continuation_query
    assert _consume_task_continuation(store, marker, ask_user) is None


def test_task_clarification_can_continue_through_second_native_question(monkeypatch):
    design_url = "https://github.com/example/project/blob/main/docs/DESIGN.md"
    store, pending, first_card, first_marker = _task_continuation_fixture(
        monkeypatch,
        continuation_query=f"Build an Electron GUI following {design_url}",
    )
    first = _consume_task_continuation(store, first_marker, first_card)
    assert first is not None
    second_card = {
        "question": "Which packaging target?",
        "options": [{"label": "Windows and Linux"}, {"label": "Linux only"}],
    }
    effective_query = (
        first.continuation_query
        + "\nLatest user instruction: Only repair the CommonJS startup and conversion path."
    )
    second_marker = store.create(
        first,
        approval_mode="auto", owner="alice", session_id="session-1",
        question_run_id="run-3", workspace=None, document_id=None,
        document_version=None, document_digest=None, ask_user=second_card,
        continuation_query=effective_query,
    )
    assert second_marker is not None
    second = _consume_task_continuation(
        store, second_marker, second_card,
        question_run_id="run-3",
        reply="Windows and Linux; proceed with the original request.",
    )
    assert second is not None
    assert second.origin_run_id == pending.origin_run_id
    assert second.question_run_id == "run-3"
    assert second.source_approval_id == pending.approval_id
    assert second.continuation_query == effective_query
    assert "Latest user instruction: Only repair the CommonJS startup" in second.continuation_query
    from src.coding_grounding import CodingGrounding

    next_turn_query = (
        second.continuation_query
        + "\nLatest user instruction: Convert main/index.js to CommonJS now."
    )
    grounding = CodingGrounding(next_turn_query)
    assert grounding.latest_scope.startswith("Only repair the CommonJS")
    assert grounding.skill_matching_query == grounding.latest_scope
    assert design_url not in grounding.preferred_urls


def test_task_continuation_refuses_wrong_choice_context_and_replays(monkeypatch):
    cases = [
        {"approval_mode": "ask"},
        {"owner": "bob"},
        {"session_id": "session-2"},
        {"origin_run_id": "different-run"},
        {"question_run_id": "different-question-run"},
        {"workspace": "/tmp/elsewhere"},
        {"document_id": "doc-other"},
        {"document_version": 2},
        {"document_digest": "a" * 64},
        {"reply": "Pick an unoffered architecture"},
        {"reply": "Create full Electron desktop app. Never mind, build a calculator."},
        {"reply": "Create full Electron desktop app. I changed my mind; make a different app."},
        {"reply": "Create full Electron desktop app. Instead do an unrelated task."},
    ]
    for changes in cases:
        store, _, ask_user, marker = _task_continuation_fixture(monkeypatch)
        assert _consume_task_continuation(
            store, marker, ask_user, **changes
        ) is None
        if "owner" not in changes and "session_id" not in changes:
            assert _consume_task_continuation(store, marker, ask_user) is None

    store, _, ask_user, marker = _task_continuation_fixture(monkeypatch)
    changed_question = {**ask_user, "question": "A different question?"}
    assert _consume_task_continuation(store, marker, changed_question) is None
    assert _consume_task_continuation(store, marker, ask_user) is None

    store, _, ask_user, marker = _task_continuation_fixture(monkeypatch)
    changed_options = {**ask_user, "options": list(reversed(ask_user["options"]))}
    assert _consume_task_continuation(store, marker, changed_options) is None
    assert _consume_task_continuation(store, marker, ask_user) is None


def test_default_agent_workspace_matches_task_continuation_scope(tmp_path, monkeypatch):
    import routes.chat_routes as chat_routes
    import src.constants as constants
    import src.tool_execution as tool_execution
    import src.tool_security as tool_security

    workspace = tmp_path / "default-agent-root"
    workspace.mkdir()
    monkeypatch.setattr(constants, "AGENT_WORKSPACE_DIR", str(workspace))
    monkeypatch.setattr(tool_execution, "AGENT_WORKSPACE_DIR", str(workspace))
    monkeypatch.setattr(chat_routes, "effective_user", lambda _request: "alice")
    monkeypatch.setattr(tool_security, "owner_is_admin_or_single_user", lambda _owner: True)
    request = SimpleNamespace(
        headers={}, state=SimpleNamespace(current_user="alice"),
    )
    bound_workspace = chat_routes._bind_default_agent_workspace(
        request, "", agent_mode=True, client_runtime_context={},
    )

    store, _, ask_user, marker = _task_continuation_fixture(
        monkeypatch, workspace=bound_workspace,
    )
    continuation = _consume_task_continuation(
        store, marker, ask_user, workspace=bound_workspace,
    )
    assert continuation is not None
    assert continuation.workspace == str(workspace)


def test_task_continuation_refuses_expiry_and_non_task_or_non_auto_grants(monkeypatch):
    monkeypatch.setattr("src.tool_approval_scopes._grant_key", lambda: b"test-key")
    approvals = ToolApprovalStore(ttl_seconds=1)
    pending = _pending(approvals)
    grant = approvals.consume(
        pending.approval_id, decision="approve", owner="alice", session_id="session-1"
    )
    assert grant is not None
    ask_user = {"question": "Choose", "options": [{"label": "One"}, {"label": "Two"}]}
    store = TaskApprovalContinuationStore()
    assert store.create(
        grant,
        approval_mode="auto",
        question_run_id="run-2",
        owner="alice",
        session_id="session-1",
        workspace=None,
        document_id=None,
        document_version=None,
        document_digest=None,
        ask_user=ask_user,
    ) is None

    task_approval = approvals.create(
        owner="alice",
        session_id="session-2",
        origin_run_id="run-2",
        tool_name="bash",
        content="printf exact",
        workspace=None,
        external_untrusted_context_seen=True,
        capabilities=capabilities_for_action("bash", "printf exact"),
    )
    task_grant = approvals.consume(
        task_approval.approval_id,
        decision="approve_task",
        owner="alice",
        session_id="session-2",
    )
    assert task_grant is not None
    assert store.create(
        task_grant,
        question_run_id="run-3",
        approval_mode="ask",
        owner="alice",
        session_id="session-2",
        workspace=None,
        document_id=None,
        document_version=None,
        document_digest=None,
        ask_user=ask_user,
    ) is None
    assert store.create(
        ExactToolApproval(
            task_approval,
            scope=ToolApprovalScope.TASK,
            allow_remaining_actions=False,
        ),
        question_run_id="run-3",
        approval_mode="auto",
        owner="alice",
        session_id="session-2",
        workspace=None,
        document_id=None,
        document_version=None,
        document_digest=None,
        ask_user=ask_user,
    ) is None

    task_store, _, card, marker = _task_continuation_fixture(monkeypatch)
    assert _consume_task_continuation(
        task_store, marker, card, approval_mode="ask"
    ) is None
    assert _consume_task_continuation(task_store, marker, card) is None

    expired_store, _, expired_card, expired_marker = _task_continuation_fixture(
        monkeypatch,
        approval_ttl_seconds=1,
        continuation_ttl_seconds=1,
        created_at=100,
    )
    assert _consume_task_continuation(
        expired_store,
        expired_marker,
        expired_card,
        now=102,
    ) is None


def test_consumed_task_grant_can_ask_after_action_card_expiry(monkeypatch):
    store, pending, ask_user, marker = _task_continuation_fixture(
        monkeypatch,
        approval_ttl_seconds=1,
        continuation_ttl_seconds=60,
        created_at="after_approval_expiry",
    )

    continuation = _consume_task_continuation(
        store, marker, ask_user, now=pending.expires_at + 2
    )

    assert continuation is not None
    assert continuation.expires_at > pending.expires_at


def test_task_continuation_metadata_is_server_owned():
    payload = {
        "source": "slash",
        TASK_APPROVAL_CONTINUATION_METADATA_FIELD: "forged",
        "other": True,
    }
    assert sanitize_client_message_metadata(payload) == {
        "source": "slash",
        "other": True,
    }


def test_task_continuation_rejects_tampered_marker_and_multi_choice_question(monkeypatch):
    store, _, ask_user, marker = _task_continuation_fixture(monkeypatch)
    nonce, signature = marker.split(".", 1)
    forged_marker = f"{nonce}.{('0' if signature[0] != '0' else '1')}{signature[1:]}"
    assert _consume_task_continuation(store, forged_marker, ask_user) is None
    assert _consume_task_continuation(store, marker, ask_user) is None

    store, _, ask_user, marker = _task_continuation_fixture(monkeypatch)
    multi_card = {**ask_user, "multi": True}
    assert _consume_task_continuation(store, marker, multi_card) is None
    assert _consume_task_continuation(store, marker, ask_user) is None


def test_allow_for_chat_session_applies_to_later_turns_in_only_that_chat():
    store = ToolApprovalStore()
    pending = _pending(store, selected_tools=["bash", "manage_skills"])
    grant = store.consume(
        pending.approval_id,
        decision="approve",
        owner="alice",
        session_id="session-1",
    )

    assert grant is not None
    assert grant.scope is ToolApprovalScope.CHAT_SESSION
    assert grant.allow_remaining_actions is True
    assert grant.grants_chat_session is True
    assert grant.pending.selected_tools == ("bash", "manage_skills")
    assert grant.pending.continuation_query.startswith("inspect the project")

    resolved_card = pending.public_payload()
    resolved_card["resolved"] = "approve"
    # Resolving is a server action, and only the server's signature on the card
    # makes it a grant. A card that merely looks resolved is not one.
    stamp_chat_session_grant(resolved_card, "session-1", "approve")
    history = [
        ChatMessage(
            "assistant",
            "approval requested",
            {"tool_events": [{"ask_user": resolved_card}]},
        ),
        ChatMessage("user", "continue the work"),
    ]
    session = Session(
        id="session-1",
        name="Chat",
        endpoint_url="http://example.invalid",
        model="test",
        history=history,
    )

    messages = session.get_context_messages()
    assert messages[-1]["metadata"][CHAT_SESSION_APPROVAL_CONTEXT_MARKER] is True
    assert history[-1].metadata is None

    future_turn = ToolRunSecurityContext(external_untrusted_context_seen=True)
    future_turn.observe_messages(messages)
    assert future_turn.approval_gate_bypassed is True
    assert future_turn.decision_for("bash").allowed is True

    # The persisted card is bound to its original chat id, so a fork/copy does
    # not inherit the grant merely by copying transcript metadata.
    other_session = Session(
        id="session-2",
        name="Fork",
        endpoint_url="http://example.invalid",
        model="test",
        history=history,
    )
    other_messages = other_session.get_context_messages()
    assert CHAT_SESSION_APPROVAL_CONTEXT_MARKER not in (
        other_messages[-1].get("metadata") or {}
    )
    other_turn = ToolRunSecurityContext(external_untrusted_context_seen=True)
    other_turn.observe_messages(other_messages)
    assert other_turn.decision_for("bash").allowed is False


def test_deny_executes_nothing_and_grants_no_task_or_chat_scope():
    store = ToolApprovalStore()
    pending = _pending(store)

    assert store.consume(
        pending.approval_id,
        decision="deny",
        owner="alice",
        session_id="session-1",
    ) is None
    assert store.peek(pending.approval_id) is None

    denied_card = pending.public_payload()
    denied_card["resolved"] = "deny"
    session = Session(
        id="session-1",
        name="Chat",
        endpoint_url="http://example.invalid",
        model="test",
        history=[
            ChatMessage(
                "assistant",
                "approval requested",
                {"tool_events": [{"ask_user": denied_card}]},
            ),
            ChatMessage("user", "another request"),
        ],
    )
    messages = session.get_context_messages()
    assert CHAT_SESSION_APPROVAL_CONTEXT_MARKER not in (
        messages[-1].get("metadata") or {}
    )


def test_private_continuation_state_is_canonical_bounded_and_digest_bound():
    selected_tools = ["manage_skills", "bash", "manage_skills", "", 7]
    selected_tools.extend(f"tool_{index:04d}" for index in range(600))
    selected_tools.append("x" * 513)
    pending = _pending(
        ToolApprovalStore(),
        selected_tools=selected_tools,
        continuation_query="  " + ("original request " * 500),
    )
    assert pending.selected_tools[:2] == ("bash", "manage_skills")
    assert len(pending.selected_tools) == 512
    assert all(len(name) <= 512 for name in pending.selected_tools)
    assert "x" * 513 not in pending.selected_tools
    assert pending.continuation_query.startswith("original request")
    assert len(pending.continuation_query) == 4000

    tampered = replace(
        pending,
        selected_tools=("bash", "manage_skills", "send_email"),
        continuation_query="different request",
    )
    grant = ExactToolApproval(tampered)
    assert grant.matches(
        owner="alice",
        session_id="session-1",
        tool_name="bash",
        content="printf exact",
        workspace=None,
    ) is False


def test_consumed_card_resolution_updates_memory_and_persisted_metadata(monkeypatch):
    from routes import chat_routes

    ask_user = {
        "kind": "tool_approval",
        "approval_id": "approval-1",
        "session_id": "session-1",
    }
    metadata = {
        "_db_id": "message-1",
        "tool_events": [{"ask_user": ask_user}],
    }
    sess = SimpleNamespace(
        id="session-1",
        history=[SimpleNamespace(metadata=metadata)],
    )
    db_message = SimpleNamespace(meta_data=None)

    class Column:
        def __eq__(self, value):
            return value

    class FakeDBMessage:
        id = Column()
        session_id = Column()

    class FakeQuery:
        def filter(self, *conditions):
            return self

        def first(self):
            return db_message

    class FakeDB:
        committed = False
        rolled_back = False
        closed = False

        def query(self, model):
            assert model is FakeDBMessage
            return FakeQuery()

        def commit(self):
            self.committed = True

        def rollback(self):
            self.rolled_back = True

        def close(self):
            self.closed = True

    db = FakeDB()
    monkeypatch.setattr(chat_routes, "DBChatMessage", FakeDBMessage)
    monkeypatch.setattr(chat_routes, "SessionLocal", lambda: db)

    assert chat_routes._mark_tool_approval_resolved(
        sess,
        "approval-1",
        "approve",
    ) is True
    assert ask_user["resolved"] == "approve"
    persisted = json.loads(db_message.meta_data)
    assert persisted["tool_events"][0]["ask_user"]["resolved"] == "approve"
    assert "_db_id" not in persisted
    assert db.committed is True
    assert db.rolled_back is False
    assert db.closed is True


def test_deny_resolution_stream_is_control_only():
    from routes.chat_routes import _tool_approval_resolution_stream

    async def collect():
        return [chunk async for chunk in _tool_approval_resolution_stream("deny")]

    chunks = asyncio.run(collect())
    assert chunks[-1] == "data: [DONE]\n\n"
    event = json.loads(chunks[0][len("data: "):])
    assert event == {"type": "tool_approval_resolved", "decision": "deny"}
    assert "Denied the" not in "".join(chunks)


def test_route_context_agent_frontend_and_cache_bust_wire_the_contract():
    root = Path(__file__).resolve().parents[1]
    route = (root / "routes/chat_routes.py").read_text(encoding="utf-8")
    helpers = (root / "routes/chat_helpers.py").read_text(encoding="utf-8")
    agent = (root / "src/agent_loop.py").read_text(encoding="utf-8")
    frontend = (root / "static/js/chat.js").read_text(encoding="utf-8")
    renderer = (root / "static/js/chatRenderer.js").read_text(encoding="utf-8")
    app = (root / "static/app.js").read_text(encoding="utf-8")
    index = (root / "static/index.html").read_text(encoding="utf-8")
    approvals = (root / "src/tool_approvals.py").read_text(encoding="utf-8")
    capabilities = (root / "src/tool_capabilities.py").read_text(encoding="utf-8")
    models = (root / "core/models.py").read_text(encoding="utf-8")

    assert 'decision not in {"approve", "approve_task", "deny"}' in route
    assert "set(pending_tool_approval.selected_tools)" in route
    assert "relevant_tools_are_selection_only=bool(" in route
    assert "pending_tool_approval.continuation_query" in route
    assert "persist_user_message=not tool_approval_continuation" in route
    assert "_mark_tool_approval_resolved(" in route
    assert "_tool_approval_resolution_stream(decision)" in route
    assert "Approved the exact" not in route
    assert "Denied the" not in route
    assert "continuation_context_message: str | None = None" in helpers
    assert "persist_user_message: bool = True" in helpers
    assert "_without_latest_matching_user_message(" not in helpers
    assert "selected_tools=approval_selected_tools" in agent
    assert "continuation_query=_retrieval_query or _last_user" in agent
    assert "approval_gate_bypassed=bool(" in agent
    assert "['approve', 'approve_task', 'deny']" in frontend
    assert "input.value = label" not in frontend
    assert "const msg = approvalForSend ? '' : (queuedMessageForSend ?? el('message').value);" in frontend
    assert "const hideUserBubbleForSend = _hideUserBubble;" in frontend
    assert "const skipBubble = hideUserBubbleForSend || !!approvalForSend;" in frontend
    assert "fd.append('message', approvalForSend ? '' : _finalMsgWithInject);" in frontend
    assert "json.type === 'tool_approval_resolved'" in frontend
    assert "if (aq.resolved) return null;" in renderer
    assert "ev.ask_user && !ev.ask_user.resolved" in renderer
    assert '"label": "Allow once"' not in approvals
    assert '"label": "Allow for this task"' in approvals
    assert '"label": "Allow for this chat session"' in approvals
    assert "scope_for_decision(normalized_decision)" in approvals
    assert "CHAT_SESSION_APPROVAL_CONTEXT_MARKER" in capabilities
    assert "CHAT_SESSION_APPROVAL_CONTEXT_MARKER" in models

    def version(source: str, module: str) -> str:
        match = re.search(rf"(?:\./js/|\./|/static/js/){module}\.js\?v=([^'\"<]+)", source)
        assert match, f"missing versioned {module}.js reference"
        return match.group(1)

    chat_version = version(app, "chat")
    renderer_version = version(app, "chatRenderer")
    stream_version = version(frontend, "chatStream")
    assert version(index, "chat") == chat_version
    assert version(frontend, "chatRenderer") == renderer_version
    assert version(index, "chatRenderer") == renderer_version
    assert version(index, "chatStream") == stream_version


@pytest.mark.parametrize(
    "allow_web,use_web,expected_enabled",
    [("false", None, False), (None, "false", False), ("true", None, True)],
)
def test_task_clarification_preserves_current_web_controls(
    allow_web, use_web, expected_enabled,
):
    from routes.chat_routes import _continuation_web_controls

    continuation = SimpleNamespace(web_search_enabled=True)
    actual_allow, actual_use, enabled = _continuation_web_controls(
        continuation, allow_web, use_web,
    )
    assert (actual_allow, actual_use, enabled) == (
        allow_web, use_web, expected_enabled,
    )


def test_task_clarification_restores_web_only_when_controls_are_missing():
    from routes.chat_routes import _continuation_web_controls

    continuation = SimpleNamespace(web_search_enabled=True)
    assert _continuation_web_controls(continuation, None, None) == (
        "true", None, True,
    )
    continuation = SimpleNamespace(web_search_enabled=False)
    assert _continuation_web_controls(continuation, None, None) == (
        "false", None, False,
    )


def test_latest_clarification_lookup_never_falls_back_past_newer_card():
    from routes.chat_routes import _latest_task_continuation_question

    old_event = {
        "ask_user": {"question": "Old?", "options": [{"label": "Yes"}]},
        TASK_APPROVAL_CONTINUATION_METADATA_FIELD: "signed-marker",
        TASK_APPROVAL_ORIGIN_RUN_ID_FIELD: "origin-run",
        TASK_APPROVAL_QUESTION_RUN_ID_FIELD: "question-run",
    }
    for newer_card in (
        {"question": "New?", "options": [{"label": "No"}]},
        {"kind": "tool_approval", "question": "Approve?"},
        {"question": "Resolved?", "resolved": "approve"},
    ):
        session = SimpleNamespace(history=[{
            "role": "assistant",
            "metadata": {"tool_events": [old_event, {"ask_user": newer_card}]},
        }])
        assert _latest_task_continuation_question(session) is None
