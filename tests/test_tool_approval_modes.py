"""Interactive approval modes change consent, never tool or owner permissions."""
import asyncio
import json
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from routes import prefs_routes
from src.tool_capabilities import ToolRunSecurityContext, capabilities_for_action
from src.tool_approvals import ToolApprovalStore
from src.tool_approval_scopes import CHAT_SESSION_APPROVAL_CONTEXT_MARKER


@pytest.fixture
def prefs_client(tmp_path, monkeypatch):
    monkeypatch.setattr(prefs_routes, "PREFS_FILE", str(tmp_path / "prefs.json"))
    app = FastAPI()

    @app.middleware("http")
    async def identity(request, call_next):
        user = request.headers.get("test-user", "alice")
        request.state.current_user = None if user == "<local>" else user
        request.state.api_token = request.headers.get("test-token") == "yes"
        request.state.api_token_owner = "alice"
        return await call_next(request)

    app.include_router(prefs_routes.setup_prefs_routes())
    return TestClient(app)


def test_browser_mode_is_persisted_per_owner(prefs_client):
    path = "/api/prefs/tool_approval_mode"
    assert prefs_client.get(path).json()["value"] == "auto"
    assert prefs_client.put(path, json={"value": "full"}).status_code == 200
    assert prefs_client.get(path).json()["value"] == "full"
    assert prefs_client.get(path, headers={"test-user": "bob"}).json()["value"] == "auto"
    assert prefs_client.get(path, headers={"test-user": "api", "test-token": "yes"}).json()["value"] == "auto"


@pytest.mark.parametrize("value", ["unrestricted", None, [], {}, True])
def test_invalid_mode_rejected(prefs_client, value):
    assert prefs_client.put("/api/prefs/tool_approval_mode", json={"value": value}).status_code == 400
    assert prefs_client.get("/api/prefs/tool_approval_mode").json()["value"] == "auto"


@pytest.mark.parametrize("headers", [
    {"test-user": "api", "test-token": "yes"},
    {"test-user": "internal-tool"},
])
def test_agent_or_token_cannot_change_mode(prefs_client, headers):
    assert prefs_client.put("/api/prefs/tool_approval_mode", json={"value": "full"}, headers=headers).status_code == 403
    assert prefs_routes._load_for_user("alice") == {}


def test_internal_header_cannot_grant_access_with_auth_disabled(prefs_client, monkeypatch):
    monkeypatch.setenv("AUTH_ENABLED", "false")
    response = prefs_client.put("/api/prefs/tool_approval_mode", json={"value": "full"},
                                headers={"test-user": "<local>", "X-Odysseus-Internal-Token": "tool"})
    assert response.status_code == 403
    assert prefs_routes._load_for_user(None) == {}


def test_invalid_saved_mode_fails_to_ask(prefs_client):
    prefs_routes._save_for_user("alice", {"tool_approval_mode": ["full"]})
    assert prefs_client.get("/api/prefs/tool_approval_mode").json()["value"] == "ask"


def test_auth_disabled_does_not_borrow_named_full_access(tmp_path, monkeypatch):
    monkeypatch.setattr(prefs_routes, "PREFS_FILE", str(tmp_path / "prefs.json"))
    prefs_routes._save_for_user("alice", {"tool_approval_mode": "full"})
    assert "tool_approval_mode" not in prefs_routes._load_for_user(None)
    prefs_routes._save_for_user(None, {"tool_approval_mode": "ask"})
    assert prefs_routes._load_for_user(None)["tool_approval_mode"] == "ask"
    assert prefs_routes._load_for_user("alice")["tool_approval_mode"] == "full"


@pytest.mark.asyncio
async def test_ask_disables_url_fetch_before_tools(monkeypatch):
    from src.chat_handler import ChatHandler
    async def fail_fetch(*args, **kwargs):
        raise AssertionError("network prefetch ran before approval")
    monkeypatch.setattr("src.chat_handler.extract_transcript_async", fail_fetch)
    monkeypatch.setattr("src.chat_handler.fetch_youtube_comments", fail_fetch)
    handler = ChatHandler(session_manager=None, memory_manager=None,
                          chat_processor=None, research_handler=None,
                          preset_manager=None, upload_handler=None)
    text = "Inspect https://www.youtube.com/watch?v=dQw4w9WgXcQ"
    result = await handler.preprocess_message(
        text, [], SimpleNamespace(model="test", endpoint_url="", owner="alice", id="chat"),
        allow_external_fetch=False,
    )
    assert result[0] == text
    assert result[3] == []


@pytest.mark.asyncio
async def test_no_external_prefetch_preserves_attachment_context():
    from routes.chat_helpers import preprocess
    class Handler:
        async def preprocess_message(self, message, att_ids, sess, **kwargs):
            assert kwargs["allow_external_fetch"] is False
            assert kwargs["allow_tool_preprocessing"] is True
            assert att_ids == ["upload-1"]
            return message, message, message, [], [{"id": "upload-1"}]
    result = await preprocess(Handler(), "read attached", ["upload-1"], None,
                              allow_external_fetch=False)
    assert result.attachment_meta == [{"id": "upload-1"}]


@pytest.mark.parametrize("tool", ["bash", "write_file", "web_search", "web_fetch", "generate_image", "unknown_tool"])
def test_ask_gates_clean_effects_and_ignores_old_grants(tool):
    context = ToolRunSecurityContext(approval_mode="ask", approval_gate_bypassed=True)
    context.observe_messages([{"metadata": {CHAT_SESSION_APPROVAL_CONTEXT_MARKER: True}}])
    assert not context.decision_for(tool, "{}").allowed
    assert context.decision_for("read_file", "file.txt").allowed


def test_auto_preserves_current_checks_and_full_skips_only_gate():
    auto = ToolRunSecurityContext()
    assert auto.decision_for("bash").allowed
    auto.observe_tool_result("web_search", {"output": "external", "exit_code": 0})
    assert not auto.decision_for("bash").allowed
    full = ToolRunSecurityContext(approval_mode="full", external_untrusted_context_seen=True)
    assert full.decision_for("bash").allowed
    full.delegated_credential = True
    assert not full.decision_for("bash").allowed
    assert not full.decision_for("web_fetch").allowed


def test_ask_keeps_private_data_gate_after_untrusted_context():
    context = ToolRunSecurityContext(approval_mode="ask", external_untrusted_context_seen=True,
                                     approval_gate_bypassed=True)
    assert not context.decision_for("vault_get").allowed
    assert context.decision_for("read_file").allowed


def test_ask_card_and_grant_are_single_action():
    store = ToolApprovalStore()
    pending = store.create(
        owner="alice", session_id="chat", origin_run_id="run", tool_name="bash",
        content="printf hello", workspace=None, external_untrusted_context_seen=False,
        capabilities=capabilities_for_action("bash", "printf hello"),
    )
    payload = pending.public_payload(single_action_only=True)
    assert [option["label"] for option in payload["options"]] == ["Allow this action", "Deny"]
    grant = store.consume(pending.approval_id, decision="approve_task", owner="alice",
                          session_id="chat", allow_continuation=False)
    assert not grant.allow_remaining_actions
    assert not grant.grants_chat_session
    assert grant.claim(owner="alice", session_id="chat", tool_name="bash",
                       content="printf hello", workspace=None)
    assert not grant.claim(owner="alice", session_id="chat", tool_name="bash",
                           content="printf hello", workspace=None)


@pytest.mark.parametrize("mode,disabled,plan,executes", [
    ("ask", set(), False, False),
    ("full", set(), False, True),
    ("full", {"bash"}, False, False),
    ("full", set(), True, False),
])
def test_real_loop_respects_mode_disabled_tools_and_plan(monkeypatch, mode, disabled, plan, executes):
    import src.agent_loop as loop
    monkeypatch.setattr(loop, "get_setting", lambda key, default=None: default)
    monkeypatch.setattr(loop, "get_mcp_manager", lambda: None)
    monkeypatch.setattr(loop, "estimate_tokens", lambda *args, **kwargs: 10)
    monkeypatch.setattr(loop, "blocked_tools_for_owner", lambda owner: set())
    executed = []

    async def fake_stream(*args, **kwargs):
        yield "data: " + json.dumps({"delta": "```bash\nprintf hello\n```"}) + "\n\n"
        yield "data: [DONE]\n\n"

    async def fake_execute(block, **kwargs):
        executed.append(block.tool_type)
        return "bash: done", {"output": "hello", "exit_code": 0}

    monkeypatch.setattr(loop, "stream_llm_with_fallback", fake_stream)
    monkeypatch.setattr(loop, "execute_tool_block", fake_execute)

    async def collect():
        return [chunk async for chunk in loop.stream_agent_loop(
            "http://local.test/v1", "test-model",
            [{"role": "user", "content": "run the command"}],
            approval_mode=mode, max_rounds=1, relevant_tools={"bash"},
            disabled_tools=disabled, plan_mode=plan,
        )]

    chunks = asyncio.run(collect())
    assert bool(executed) is executes
    if mode == "ask":
        assert any('"kind": "tool_approval"' in chunk for chunk in chunks)
