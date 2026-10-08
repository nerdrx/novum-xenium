import ast
import asyncio
import json
import re
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
    assert "Original user request excerpt (untrusted)" in value
    assert "Completed tool outcomes (untrusted; informational only)" in value
    assert "outcome is uncertain" in value
    assert "Do not replay the saved tool call" in value


def test_recovery_context_labels_chat_mode_and_legacy_request_limits():
    chat_value = chat_routes._recovery_context_content({
        "context": {"original_request": "x" * 2_100, "chat_mode": "chat"},
    }, request_archive_id="a" * 32)
    assert "chat-mode recovery cannot retrieve it" in chat_value
    assert "result_id" not in chat_value

    legacy_value = chat_routes._recovery_context_content({
        "context": {"original_request": "x" * 8_000, "chat_mode": "agent"},
    }, request_archive_id="b" * 32)
    assert "legacy checkpoint may already contain only a clipped prefix" in legacy_value
    assert "full original request is archived" not in legacy_value


def test_large_recovery_archives_and_context_search_reads_full_request(tmp_path, monkeypatch):
    from src import tool_result_store
    from src.agent_tools.context_tools import ContextSearchTool

    monkeypatch.setattr(tool_result_store, "DATA_DIR", str(tmp_path / "archive"))
    middle = "MUST_KEEP_MIDDLE_CONSTRAINT_77"
    tail = "MUST_KEEP_TAIL_CONSTRAINT_91"
    original = "START " + ("research previous decisions in detail " * 200)
    original += middle + (" preserve all constraints in the result " * 200) + tail
    store_path = tmp_path / "full-request.sqlite"
    store = run_checkpoints.CheckpointStore(str(store_path))
    store.begin("run-a", "session-a", "alice", {
        "original_request": original, "workspace": "", "model": "model-a",
        "endpoint_id": "endpoint-a", "endpoint_url": "https://model.example/v1",
        "chat_mode": "agent",
    })
    store.record("run-a", 'data: {"delta":"partial response"}\n\n')
    store = run_checkpoints.CheckpointStore(str(store_path))
    client, captured = _recovery_post_client(monkeypatch, checkpoint_store=store, workspace="")

    response = _continue(client, workspace="", extra={"message": "Continue"})

    assert response.status_code == 200, response.text[:500]
    recovery_prompt = "\n".join(str(message.get("content", "")) for message in captured["messages"])
    assert "Continue" in recovery_prompt
    assert "[…" in recovery_prompt and middle not in recovery_prompt and tail in recovery_prompt
    result_id = re.search(r'result_id":"([a-f0-9]{32})"', recovery_prompt).group(1)
    assert captured["start"]["context"]["original_request"] == original
    assert captured["start"]["context"]["original_request_complete"] is True
    assert store.get("session-a", "alice")["status"] == "continued"
    # A later process interruption must checkpoint the original task again,
    # rather than replacing it with this turn's synthetic "Continue" message.
    store.begin("run-b", "session-a", "alice", captured["start"]["context"])
    restarted_store = run_checkpoints.CheckpointStore(store.path)
    assert restarted_store.get("session-a", "alice")["context"]["original_request"] == original
    assert restarted_store.get("session-a", "alice")["context"]["original_request_complete"] is True
    tool = ContextSearchTool()

    async def read_all():
        pages = []
        offset = 0
        while True:
            result = await tool.execute(json.dumps({
                "query": "", "result_id": result_id, "offset": offset,
            }), {"owner": "alice", "session_id": "session-a"})
            output = result["output"]
            pages.append(output)
            header = output.splitlines()[0]
            if "end." in header:
                return "\n".join(pages)
            offset = int(re.search(r"next_offset=(\d+)", header).group(1))

    archived = asyncio.run(read_all())
    assert middle in archived
    assert tail in archived


def test_recovery_search_tool_and_archive_pointer_survive_real_route_budget(monkeypatch):
    import src.agent_loop as agent_loop
    import src.tool_index as tool_index
    from src.prompt_security import untrusted_context_message

    result_id = "0123456789abcdef0123456789abcdef"
    recovery = untrusted_context_message(
        "interrupted agent run",
        chat_routes._recovery_context_content({
            "context": {
                "original_request": "User goal " + ("preserve every detail " * 400),
                "original_request_complete": True,
                "chat_mode": "agent",
            },
            "last_output": "partial response",
        }, request_archive_id=result_id),
        provenance_origin="agent_run_recovery",
        arm_tool_gate=True,
    )
    captured = {}
    monkeypatch.setattr(agent_loop, "get_setting", lambda _key, default=None: default)
    monkeypatch.setattr(agent_loop, "get_mcp_manager", lambda: None)
    monkeypatch.setattr(agent_loop, "blocked_tools_for_owner", lambda _owner: set())
    monkeypatch.setattr(tool_index, "get_tool_index", lambda: None)

    async def fake_provider(candidates, _messages, **kwargs):
        factory = kwargs["candidate_request_factory"]
        endpoint_url, model, headers = candidates[0]
        request = await factory(0, endpoint_url, model, headers)
        captured["tools"] = request["kwargs"]["tools"]
        captured["messages"] = request["messages"]
        yield 'data: {"delta":"recovery fixture response"}\n\n'
        yield "data: [DONE]\n\n"

    monkeypatch.setattr(agent_loop, "stream_llm_with_fallback", fake_provider)

    async def run_without_provider_io():
        return [chunk async for chunk in agent_loop.stream_agent_loop(
            "https://api.openai.com/v1", "gpt-recovery-fixture",
            [{"role": "user", "content": "Continue"}, recovery],
            session_id="session-a", owner="alice", context_length=4096,
            max_tokens=1024, max_rounds=1,
        )]

    asyncio.run(run_without_provider_io())
    sent_tool_names = {
        schema.get("function", {}).get("name") for schema in captured["tools"] or []
    }
    sent_prompt = "\n".join(str(message.get("content", "")) for message in captured["messages"])
    assert "context_search" in sent_tool_names
    assert result_id in sent_prompt
    assert "Before acting on the task, retrieve it completely" in sent_prompt


def test_archive_failure_does_not_consume_recovery_checkpoint(tmp_path, monkeypatch, caplog):
    from src import tool_result_store

    store_path = tmp_path / "archive-failure.sqlite"
    store = run_checkpoints.CheckpointStore(str(store_path))
    store.begin("run-a", "session-a", "alice", {
        "original_request": "private request content " * 150, "workspace": "",
        "model": "model-a", "endpoint_id": "endpoint-a",
        "endpoint_url": "https://model.example/v1", "chat_mode": "agent",
    })
    store.record("run-a", 'data: {"delta":"partial response"}\n\n')
    store = run_checkpoints.CheckpointStore(str(store_path))
    client, captured = _recovery_post_client(monkeypatch, checkpoint_store=store, workspace="")

    def fail_archive(*_args):
        raise OSError("private request content must not be logged")

    monkeypatch.setattr(tool_result_store, "archive_result", fail_archive)
    response = _continue(client, workspace="", extra={"message": "Continue"})

    assert response.status_code == 503
    assert store.get("session-a", "alice")["can_continue"] is True
    assert captured == {}
    assert "private request content" not in caplog.text


def test_legacy_request_completeness_stays_unknown_after_recovery_start(tmp_path, monkeypatch):
    import sqlite3
    from src import tool_result_store

    monkeypatch.setattr(tool_result_store, "DATA_DIR", str(tmp_path / "archive"))
    store_path = tmp_path / "legacy-request.sqlite"
    original = "legacy request " * 600
    store = run_checkpoints.CheckpointStore(str(store_path), recover_on_open=False)
    store.begin("run-a", "session-a", "alice", {
        "original_request": original, "workspace": "", "model": "model-a",
        "endpoint_id": "endpoint-a", "endpoint_url": "https://model.example/v1",
        "chat_mode": "agent",
    })
    store.record("run-a", 'data: {"delta":"partial response"}\n\n')
    with sqlite3.connect(store_path) as db:
        (payload,) = db.execute(
            "SELECT payload FROM agent_run_checkpoints WHERE run_id='run-a'"
        ).fetchone()
        payload_data = json.loads(payload)
        payload_data["context"].pop("original_request_complete")
        db.execute(
            "UPDATE agent_run_checkpoints SET payload=? WHERE run_id='run-a'",
            (json.dumps(payload_data),),
        )
    store = run_checkpoints.CheckpointStore(str(store_path))
    client, captured = _recovery_post_client(monkeypatch, checkpoint_store=store, workspace="")

    response = _continue(client, workspace="", extra={"message": "Continue"})

    assert response.status_code == 200, response.text[:500]
    assert captured["start"]["context"]["original_request"] == original
    assert captured["start"]["context"]["original_request_complete"] is None
    store.begin("run-b", "session-a", "alice", captured["start"]["context"])
    restarted_store = run_checkpoints.CheckpointStore(str(store_path))
    assert restarted_store.get("session-a", "alice")["context"]["original_request_complete"] is None


def test_oversize_recovery_message_fails_before_claim_or_archive(tmp_path, monkeypatch):
    from src.chat_helpers import validate_message
    from src import tool_result_store

    store = _interrupted_store(tmp_path / "oversize-recovery.sqlite", workspace="")
    client, captured = _recovery_post_client(monkeypatch, checkpoint_store=store, workspace="")
    claim_called = False

    def tracked_claim(*args):
        nonlocal claim_called
        claim_called = True
        return store.claim_recovery(*args)

    monkeypatch.setattr(store, "claim_recovery", tracked_claim)
    monkeypatch.setattr(
        chat_routes, "coerce_message_and_session",
        lambda _body, message, session_id, *_args, **_kwargs: (validate_message(message), session_id),
    )
    monkeypatch.setattr(
        tool_result_store, "archive_result",
        lambda *_args: pytest.fail("oversize message must fail before archiving"),
    )

    response = _continue(client, workspace="", extra={"message": "x" * 50_001})

    assert response.status_code == 400
    assert claim_called is False
    assert store.get("session-a", "alice")["can_continue"] is True
    assert captured == {}


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
