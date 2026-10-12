"""Tests for the model-interaction tools after their move to the agent_tools
registry (#3629): chat_with_model, ask_teacher, list_models.

The implementations now live in src/agent_tools/model_interaction_tools.py
(moved out of src/ai_interaction.py). These assert (1) the handlers are
registered in TOOL_HANDLERS, (2) each handler runs the moved logic and threads
session_id/owner from the ctx, and (3) tool_execution.py dispatches them
through the registry rather than the legacy dispatch_ai_tool elif.
"""
import asyncio
from pathlib import Path

import src.ai_interaction as ai_interaction
import src.llm_core as llm_core
import src.database as database
from src.agent_tools import TOOL_HANDLERS
from src.agent_tools import model_interaction_tools as mit

_MODEL_TOOLS = ("chat_with_model", "ask_teacher", "list_models")


def test_model_interaction_tools_registered():
    for name in _MODEL_TOOLS:
        assert name in TOOL_HANDLERS, f"{name} missing from TOOL_HANDLERS"


def test_chat_with_model_threads_owner_and_returns(monkeypatch):
    seen = {}

    def fake_resolve(spec, owner=None):
        seen["spec"] = spec
        seen["owner"] = owner
        return ("http://x", "model-x", {})

    async def fake_call(url, model, messages, headers=None, timeout=None):
        seen["message"] = messages[-1]["content"]
        return "hi back"

    monkeypatch.setattr(ai_interaction, "_resolve_model", fake_resolve)
    monkeypatch.setattr(llm_core, "llm_call_async", fake_call)

    res = asyncio.run(mit.ChatWithModelTool().execute(
        "model-x\nhello there", {"owner": "alice", "session_id": "s1"}))

    assert res == {"model": "model-x", "response": "hi back"}
    assert seen["owner"] == "alice"
    assert seen["spec"] == "model-x"
    assert seen["message"] == "hello there"


def test_chat_with_model_missing_model_is_a_failed_tool_with_guidance(monkeypatch):
    monkeypatch.setattr(
        ai_interaction,
        "_resolve_model",
        lambda *_a, **_k: (_ for _ in ()).throw(ValueError("Model 'claude-sonnet-4' not found")),
    )
    result = asyncio.run(mit.chat_with_model("claude-sonnet-4\nhello", owner="alice"))
    assert result["exit_code"] == 1
    assert "claude-sonnet-4" in result["error"]
    assert "list_models" in result["error"]


def test_ask_teacher_threads_owner_and_marks_teacher(monkeypatch):
    seen = {}

    def fake_resolve(spec, owner=None):
        seen["owner"] = owner
        return ("http://x", "teacher-x", {})

    async def fake_call(url, model, messages, headers=None, timeout=None):
        return "do this and that"

    monkeypatch.setattr(ai_interaction, "_resolve_model", fake_resolve)
    monkeypatch.setattr(llm_core, "llm_call_async", fake_call)

    res = asyncio.run(mit.AskTeacherTool().execute(
        "teacher-x\nI am stuck", {"owner": "bob"}))

    assert res["teacher"] is True
    assert res["response"] == "do this and that"
    assert seen["owner"] == "bob"


def test_list_models_no_endpoints(monkeypatch):
    class _Q:
        def filter(self, *a, **k):
            return self

        def all(self):
            return []

    class _S:
        def query(self, *a, **k):
            return _Q()

        def close(self):
            pass

    monkeypatch.setattr(database, "SessionLocal", lambda: _S())

    res = asyncio.run(mit.ListModelsTool().execute("", {}))
    assert res == {"results": "No enabled model endpoints configured."}


def test_list_models_exposes_local_pinned_names_not_router_presets(monkeypatch):
    from types import SimpleNamespace

    endpoint = SimpleNamespace(
        name="zVram · Local models", base_url="http://router/v1", api_key=None,
        cached_models='["nx-model-0:LOCAL"]', pinned_models='["Friendly alias"]',
    )

    class Query:
        def filter(self, *a, **k): return self
        def all(self): return [endpoint]

    class Db:
        def query(self, *a, **k): return Query()
        def close(self): pass

    class Response:
        def raise_for_status(self): pass
        def json(self): return {"data": [{"id": "nx-model-0:LOCAL"}]}

    monkeypatch.setattr(database, "SessionLocal", lambda: Db())
    import src.endpoint_resolver as resolver
    monkeypatch.setattr(llm_core, "_detect_provider", lambda base: "openai")
    monkeypatch.setattr(resolver, "resolve_endpoint_runtime", lambda ep, owner=None: (ep.base_url, None))
    monkeypatch.setattr(resolver, "build_headers", lambda *a: {})
    monkeypatch.setattr(resolver, "build_models_url", lambda base: base + "/models")
    monkeypatch.setattr("httpx.get", lambda *a, **k: Response())

    result = asyncio.run(mit.list_models("", owner="alice"))
    assert "`Friendly alias`" in result["results"]
    assert "nx-model-0" not in result["results"]


def test_model_response_prefers_advertised_local_alias():
    from src.endpoint_resolver import model_ids_from_response

    assert model_ids_from_response({"data": [
        {"id": "nx-model-0:LOCAL", "aliases": ["Friendly alias"]},
    ]}) == ["Friendly alias"]


def test_dispatched_via_registry_not_dispatch_ai_tool():
    """The model tools route through the registry (_document_tool_dispatch), and
    are no longer in the dispatch_ai_tool elif tuple."""
    source = (Path(__file__).resolve().parent.parent / "src" / "tool_execution.py").read_text(encoding="utf-8")
    assert 'elif tool in ("chat_with_model", "ask_teacher", "list_models"):' in source

    marker = "from src.ai_interaction import dispatch_ai_tool"
    idx = source.index(marker)
    branch_head = source.rfind("elif tool in (", 0, idx)
    legacy_tuple = source[branch_head:idx]
    for name in _MODEL_TOOLS:
        assert f'"{name}"' not in legacy_tuple, f"{name} still routed via dispatch_ai_tool"
