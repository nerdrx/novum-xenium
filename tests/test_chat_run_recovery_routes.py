import ast
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.middleware.base import BaseHTTPMiddleware

from core.middleware import INTERNAL_TOOL_HEADER
from src import run_checkpoints
from routes import chat_routes


class _IdentityMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        request.state.current_user = request.headers.get("x-test-user")
        if request.headers.get("x-test-api-token"):
            request.state.api_token = True
        return await call_next(request)


class _ToolPolicy:
    block_all_tool_calls = False

    @staticmethod
    def blocks(_tool):
        return False

    @staticmethod
    def reason_for(_tool):
        return ""

    @staticmethod
    def all_disabled_names():
        return []


class _PreservingToolPolicy(_ToolPolicy):
    def __init__(self, disabled=None):
        self._disabled = set(disabled or ())

    def all_disabled_names(self):
        return sorted(self._disabled)


class _NullQuery:
    def filter(self, *_args, **_kwargs):
        return self

    def order_by(self, *_args, **_kwargs):
        return self

    def first(self):
        return None

    def all(self):
        return []


class _NullDb:
    def query(self, *_args, **_kwargs):
        return _NullQuery()

    def close(self):
        return None


def _recovery_post_client(monkeypatch, *, checkpoint_store, workspace, model="model-a", endpoint_url="https://model.example/v1"):
    from types import SimpleNamespace
    import src.foreground_model_routing as foreground_model_routing

    captured = {}
    session = SimpleNamespace(
        endpoint_url=endpoint_url, model=model, headers={}, name="session",
        history=[], add_message=lambda message: None,
    )
    manager = SimpleNamespace(
        sessions={"session-a": session},
        get_session=lambda _session_id: session,
        save_sessions=lambda: None,
    )
    context = SimpleNamespace(
        user="alice", messages=[{"role": "user", "content": "continue"}],
        route_messages=[{"role": "user", "content": "continue"}], preface=[],
        preprocessed=SimpleNamespace(attachment_meta=[]), auto_opened_docs=[],
        rag_sources=[], web_sources=[], used_memories=[], uploaded_files=[], uprefs={},
        was_compacted=False, context_trimmed=False, context_length=4096,
        context_messages_before_trim=1, context_messages_after_trim=1,
        context_tokens_before_trim=1, context_tokens_after_trim=1,
        preset=SimpleNamespace(temperature=0.2, max_tokens=128, character_name=None),
    )

    monkeypatch.setattr(chat_routes.run_checkpoints, "_STORE", checkpoint_store)
    monkeypatch.setattr(chat_routes, "require_api_token_scope", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(chat_routes, "_set_user_time_from_request", lambda *_args: None)
    monkeypatch.setattr(chat_routes, "coerce_message_and_session", lambda _body, message, session_id, *_a, **_k: (message, session_id))
    monkeypatch.setattr(chat_routes, "_verify_session_owner", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(chat_routes, "effective_user", lambda _request: "alice")
    monkeypatch.setattr(chat_routes, "_resolve_request_workspace", lambda _request, requested: (workspace, False) if requested == workspace else ("", True))
    monkeypatch.setattr(chat_routes, "_reconcile_selected_route_from_request", lambda *_args, **_kwargs: False)
    monkeypatch.setattr(chat_routes, "_clear_orphaned_session_endpoint", lambda *_args, **_kwargs: False)
    monkeypatch.setattr(chat_routes, "_recover_empty_session_model", lambda *_args, **_kwargs: False)
    monkeypatch.setattr(chat_routes, "_enforce_chat_privileges", lambda *_args: None)
    monkeypatch.setattr(chat_routes, "resolve_session_auth", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(chat_routes, "get_session_mode", lambda *_args: "agent")
    monkeypatch.setattr(chat_routes, "set_session_mode", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(chat_routes, "build_effective_tool_policy", lambda **_kwargs: _ToolPolicy())
    monkeypatch.setattr(chat_routes, "_classify_tool_intent", lambda *_args: None)
    monkeypatch.setattr(chat_routes, "_is_contextual_web_followup", lambda *_args: False)
    monkeypatch.setattr(chat_routes, "_is_contextual_browser_followup", lambda *_args: False)
    monkeypatch.setattr(chat_routes, "_resolve_workspace_from_message_path", lambda *_args: ("", ""))
    monkeypatch.setattr(chat_routes, "_is_image_generation_session", lambda *_args, **_kwargs: False)
    monkeypatch.setattr(chat_routes, "_allowed_models_for_request", lambda *_args: [])
    monkeypatch.setattr(chat_routes, "resolve_foreground_model_policy", lambda **_kwargs: foreground_model_routing.ForegroundModelPolicy())
    monkeypatch.setattr(chat_routes, "build_foreground_model_candidates", lambda url, m, headers, **_kwargs: [(url, m, headers)])
    monkeypatch.setattr(chat_routes, "build_foreground_route_descriptors", lambda *_args, **_kwargs: [{"endpoint_id": "endpoint-a", "endpoint_label": "Test"}])
    monkeypatch.setattr(chat_routes, "build_chat_context", lambda *_args, **_kwargs: _async_value(context))
    monkeypatch.setattr(chat_routes, "SessionLocal", _NullDb)
    monkeypatch.setattr(chat_routes, "estimate_tokens", lambda _messages: 10)
    monkeypatch.setattr(chat_routes, "accumulate_token_usage", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(chat_routes, "save_assistant_response", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(chat_routes, "run_post_response_tasks", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(chat_routes, "clean_thinking_for_save", lambda reply, metadata: (reply, metadata))
    monkeypatch.setattr(chat_routes, "stream_agent_loop", _fake_agent_loop(captured))

    def fake_start(_session_id, agen, **kwargs):
        captured["start"] = kwargs
        return SimpleNamespace(run_id="new-run", agen=agen)

    monkeypatch.setattr(chat_routes.agent_runs, "start", fake_start)
    monkeypatch.setattr(chat_routes.agent_runs, "subscribe", lambda _session_id, run: run.agen)
    import src.settings as settings
    monkeypatch.setattr(settings, "get_setting", lambda _key, default=None: default)
    monkeypatch.setattr(settings, "get_user_setting", lambda _key, owner="", default=None: default)

    app = FastAPI()
    app.add_middleware(_IdentityMiddleware)
    app.dependency_overrides[chat_routes.require_chat_api_token_scope] = lambda: None
    app.include_router(chat_routes.setup_chat_routes(manager, SimpleNamespace(), SimpleNamespace(), SimpleNamespace(), SimpleNamespace(), SimpleNamespace()))
    return TestClient(app), captured


def _interrupted_store(path, *, workspace, model="model-a", plan_mode=True):
    first = run_checkpoints.CheckpointStore(str(path), recover_on_open=False)
    first.begin("run-a", "session-a", "alice", {
        "original_request": "Update the project",
        "workspace": workspace, "model": model, "endpoint_id": "endpoint-a",
        "endpoint_url": "https://model.example/v1", "chat_mode": "agent",
        "plan_mode": plan_mode,
    })
    first.record("run-a", 'data: {"delta":"partial work"}\n\n')
    first.record("run-a", 'data: {"type":"tool_start","tool":"write_file","command":"src/app.py"}\n\n')
    return run_checkpoints.CheckpointStore(str(path))


def _continue(client, *, workspace, extra=None):
    fields = {
        "session": "session-a", "message": "Continue from the saved checkpoint",
        "mode": "agent", "recovery_run_id": "run-a", "workspace": workspace,
    }
    fields.update(extra or {})
    return client.post("/api/chat_stream", data=fields, headers={"x-test-user": "alice"})


async def _async_value(value):
    return value


def _fake_agent_loop(captured):
    async def stream_agent_loop(_url, _model, messages, **kwargs):
        captured["messages"] = messages
        captured["loop_kwargs"] = kwargs
        yield 'data: {"delta":"continued"}\n\n'
        yield "data: [DONE]\n\n"
    return stream_agent_loop


@pytest.fixture
def recovery_client(tmp_path, monkeypatch):
    store = run_checkpoints.CheckpointStore(str(tmp_path / "runs.sqlite"), recover_on_open=False)
    store.begin("run-a", "session-a", "alice", {
        "original_request": "Change the workspace safely",
        "workspace": str(tmp_path), "model": "model-a", "endpoint_id": "endpoint-a",
    })
    store.record("run-a", 'data: {"delta":"partial response"}\n\n')
    run_checkpoints.CheckpointStore(str(tmp_path / "runs.sqlite"))
    monkeypatch.setattr(run_checkpoints, "_STORE", run_checkpoints.CheckpointStore(
        str(tmp_path / "runs.sqlite"), recover_on_open=False
    ))
    monkeypatch.setattr(chat_routes, "effective_user", lambda request: request.state.current_user)
    monkeypatch.setattr(chat_routes, "_verify_session_owner", lambda *_args, **_kwargs: None)
    app = FastAPI()
    app.add_middleware(_IdentityMiddleware)
    app.dependency_overrides[chat_routes.require_chat_api_token_scope] = lambda: None
    app.include_router(chat_routes.setup_chat_routes(
        MagicMock(), MagicMock(), MagicMock(), MagicMock(), MagicMock(), MagicMock()
    ))
    return TestClient(app)


def test_checkpoint_endpoint_is_owner_scoped_and_browser_only(recovery_client):
    client = recovery_client
    alice = client.get("/api/chat/checkpoint/session-a", headers={"x-test-user": "alice"})
    assert alice.status_code == 200
    assert alice.json()["partial_response"] == "partial response"
    assert alice.json()["replay_tools"] is False
    assert client.get("/api/chat/checkpoint/session-a", headers={"x-test-user": "bob"}).status_code == 404
    assert client.get("/api/chat/checkpoint/session-a", headers={
        "x-test-user": "alice", "x-test-api-token": "1",
    }).status_code == 403
    assert client.get("/api/chat/checkpoint/session-a", headers={
        "x-test-user": "alice", INTERNAL_TOOL_HEADER: "internal",
    }).status_code == 403


def test_chat_stream_continue_claims_once_and_preserves_saved_read_only_mode(tmp_path, monkeypatch):
    workspace = str(tmp_path / "workspace")
    (tmp_path / "workspace").mkdir()
    store = _interrupted_store(tmp_path / "continue.sqlite", workspace=workspace, plan_mode=True)
    client, captured = _recovery_post_client(monkeypatch, checkpoint_store=store, workspace=workspace)

    response = _continue(client, workspace=workspace)
    assert response.status_code == 200, response.text[:500]
    assert "continued" in response.text
    assert captured["loop_kwargs"]["plan_mode"] is True
    assert captured["loop_kwargs"]["workspace"] == workspace
    assert captured["loop_kwargs"]["external_untrusted_context_seen"] is True
    assert captured["start"]["persist"] is True
    assert all("tool_calls" not in message for message in captured["messages"])
    assert any("Do not replay the saved tool call" in str(message) for message in captured["messages"])
    assert store.get("session-a", "alice")["status"] == "continued"

    again = _continue(client, workspace=workspace)
    assert again.status_code == 409
    assert captured["loop_kwargs"]["plan_mode"] is True


def test_chat_stream_recovery_preserves_deep_valid_workspace_path(tmp_path, monkeypatch):
    workspace_path = tmp_path
    for index in range(6):
        workspace_path = workspace_path / (f"d{index}-" + "x" * 95)
        workspace_path.mkdir()
    workspace = str(workspace_path)
    assert len(workspace.encode("utf-8")) > 512

    store = _interrupted_store(tmp_path / "deep-workspace.sqlite", workspace=workspace)
    client, captured = _recovery_post_client(
        monkeypatch, checkpoint_store=store, workspace=workspace,
    )

    response = _continue(client, workspace=workspace)

    assert response.status_code == 200, response.text[:500]
    assert captured["loop_kwargs"]["workspace"] == workspace
    assert store.get("session-a", "alice")["context"]["workspace"] == workspace


def test_recovery_copy_does_not_override_explicit_bash_off(tmp_path, monkeypatch):
    from src.action_intents import classify_tool_intent

    workspace = str(tmp_path / "workspace")
    (tmp_path / "workspace").mkdir()
    store = _interrupted_store(
        tmp_path / "bash-off.sqlite", workspace=workspace, plan_mode=False,
    )
    client, captured = _recovery_post_client(
        monkeypatch, checkpoint_store=store, workspace=workspace,
    )
    monkeypatch.setattr(chat_routes, "_classify_tool_intent", classify_tool_intent)
    monkeypatch.setattr(
        chat_routes, "build_effective_tool_policy",
        lambda **kwargs: _PreservingToolPolicy(kwargs.get("disabled_tools")),
    )

    response = _continue(client, workspace=workspace, extra={
        "message": (
            "Continue the interrupted task in the saved workspace. Check whether "
            "any uncertain action already took effect before repeating it, then "
            "complete the original request."
        ),
        "mode": "chat",
        "plan_mode": "false",
        "allow_bash": "false",
    })

    assert response.status_code == 200, response.text[:500]
    assert captured["loop_kwargs"]["workspace"] == workspace
    assert captured["loop_kwargs"]["plan_mode"] is False
    assert "bash" in captured["loop_kwargs"]["disabled_tools"]
    assert any("Continue the interrupted task" in str(message) for message in captured["messages"])
    assert "Do not replay the saved tool call" in str(captured["messages"])
    assert store.get("session-a", "alice")["status"] == "continued"


def test_ordinary_workspace_intent_still_auto_enables_bash(tmp_path, monkeypatch):
    from src.action_intents import classify_tool_intent

    workspace = str(tmp_path / "workspace")
    (tmp_path / "workspace").mkdir()
    store = run_checkpoints.CheckpointStore(str(tmp_path / "ordinary.sqlite"), recover_on_open=False)
    client, captured = _recovery_post_client(
        monkeypatch, checkpoint_store=store, workspace=workspace,
    )
    monkeypatch.setattr(chat_routes, "_classify_tool_intent", classify_tool_intent)
    monkeypatch.setattr(
        chat_routes, "build_effective_tool_policy",
        lambda **kwargs: _PreservingToolPolicy(kwargs.get("disabled_tools")),
    )

    response = client.post("/api/chat_stream", data={
        "session": "session-a", "message": "Fix the repo bug and run tests",
        "mode": "chat", "allow_bash": "false", "workspace": workspace,
    }, headers={"x-test-user": "alice"})

    assert response.status_code == 200, response.text[:500]
    assert "bash" not in (captured["loop_kwargs"]["disabled_tools"] or [])


@pytest.mark.parametrize("mismatch", ["workspace", "model", "endpoint"])
def test_chat_stream_rejects_stale_recovery_binding_before_claim(tmp_path, monkeypatch, mismatch):
    workspace = str(tmp_path / "workspace")
    (tmp_path / "workspace").mkdir()
    store = _interrupted_store(tmp_path / f"{mismatch}.sqlite", workspace=workspace)
    current_workspace = "" if mismatch == "workspace" else workspace
    current_model = "new-model" if mismatch == "model" else "model-a"
    endpoint_url = "https://new.example/v1" if mismatch == "endpoint" else "https://model.example/v1"
    client, captured = _recovery_post_client(
        monkeypatch, checkpoint_store=store, workspace=current_workspace,
        model=current_model, endpoint_url=endpoint_url,
    )

    response = _continue(client, workspace=workspace)
    assert response.status_code == 409, response.text[:500]
    assert captured == {}
    assert store.get("session-a", "alice")["can_continue"] is True


def test_incognito_chat_stream_disables_durable_run_checkpoints(tmp_path, monkeypatch):
    workspace = str(tmp_path / "workspace")
    workspace_path = tmp_path / "workspace"
    workspace_path.mkdir()
    store = run_checkpoints.CheckpointStore(str(tmp_path / "incognito.sqlite"), recover_on_open=False)
    client, captured = _recovery_post_client(monkeypatch, checkpoint_store=store, workspace=workspace)
    response = client.post("/api/chat_stream", data={
        "session": "session-a", "message": "A private answer", "mode": "agent",
        "incognito": "true",
    }, headers={"x-test-user": "alice"})
    assert response.status_code == 200, response.text[:500]
    assert captured["start"]["persist"] is False
    assert store.get("session-a", "alice") is None
def test_recovery_context_treats_saved_evidence_as_untrusted():
    value = chat_routes._recovery_context_content({
        "context": {"original_request": "Do a task"},
        "last_output": "unfinished",
        "tool_outcomes": [{"tool": "write_file", "output": "looks done"}],
        "pending_tool": {"tool": "bash", "command": "rm -rf?"},
    })
    assert "Original user request (untrusted)" in value
    assert "Completed tool outcomes (untrusted; informational only)" in value
    assert "outcome is uncertain" in value
    assert "Do not replay the saved tool call" in value


def test_chat_stream_claims_once_and_never_replays_checkpoint_tool_calls():
    source = Path(chat_routes.__file__).read_text(encoding="utf-8")
    tree = ast.parse(source)
    chat_stream = next(
        node for node in ast.walk(tree)
        if isinstance(node, ast.AsyncFunctionDef) and node.name == "chat_stream"
    )
    text = ast.get_source_segment(source, chat_stream)
    assert "run_checkpoints.claim_recovery(session, owner, recovery_run_id)" in text
    assert "untrusted_context_message(" in text
    assert "external_untrusted_context_seen = True" in text
    assert "persist=not incognito" in text
    assert "incognito=incognito" in text
    assert 'recovery_checkpoint.get("tool_calls")' not in text


def test_chat_ui_offers_explicit_continue_without_replaying_tools():
    source = (Path(__file__).resolve().parents[1] / "static/js/chat.js").read_text(encoding="utf-8")
    assert "api/chat/checkpoint/" in source
    assert "recovery-run-continue" in source
    assert "fd.append('recovery_run_id', recoveryForSend.runId)" in source
    assert "Saved progress is context only. The run will not replay prior tool calls or approvals." in source
    assert "Check whether any uncertain action already took effect" in source
