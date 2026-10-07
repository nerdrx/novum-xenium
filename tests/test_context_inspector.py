import asyncio
import json
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import core.database as cdb
import routes.history.history_routes as history_routes
from src import tool_result_store
from src.context_inspector import describe_request
from src.model_context import estimate_tokens, estimate_tool_schema_tokens


def test_describe_request_totals_messages_and_native_schemas_by_category():
    messages = [
        {"role": "system", "content": "trusted instructions", "_agent_injected": "prompt"},
        {"role": "user", "content": "saved fact", "metadata": {"source": "saved memory: user", "trusted": False}, "_agent_injected": "context"},
        {"role": "user", "content": "active document", "metadata": {"source": "active editor document"}},
        {"role": "tool", "content": "tool output"},
        {"role": "assistant", "content": "prior reply"},
        {"role": "user", "content": "new request"},
    ]
    schemas = [{"type": "function", "function": {"name": "search", "parameters": {"type": "object"}}}]
    inspection = describe_request(
        messages, schemas, context_length=1000, output_reserve=150,
        archive_stats={"count": 2, "bytes": 8192},
    )
    categories = inspection["categories"]
    assert categories["instructions"]["items"] == 1
    assert categories["memory_docs"]["items"] == 2
    assert categories["tool_results"]["items"] == 1
    assert categories["conversation"]["items"] == 2
    assert categories["native_tool_schemas"]["tokens"] == estimate_tool_schema_tokens(schemas)
    assert categories["archives"] == {
        "tokens": 0, "items": 2, "characters": 0, "count": 2, "bytes": 8192,
    }
    assert inspection["total_tokens"] == estimate_tokens(messages) + estimate_tool_schema_tokens(schemas)
    assert inspection["available_tokens"] == 850
    assert inspection["remaining_tokens"] == max(850 - inspection["total_tokens"], 0)
    assert "trusted instructions" not in json.dumps(inspection)


def test_describe_request_clamps_known_window_to_actual_input_budget():
    inspection = describe_request([], [], context_length=1000, output_reserve=100, input_budget=250)
    assert inspection["input_budget_tokens"] == 250
    assert inspection["available_tokens"] == 250


def test_describe_request_reports_input_budget_for_unknown_window():
    inspection = describe_request([], [], context_length=None, output_reserve=100, input_budget=500)
    assert inspection["context_length"] is None
    assert inspection["input_budget_tokens"] == 500
    assert inspection["available_tokens"] == 500


def test_context_endpoint_reads_latest_assistant_inspection_and_scoped_archives(tmp_path, monkeypatch):
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    cdb.Base.metadata.create_all(engine, tables=[cdb.Session.__table__, cdb.ChatMessage.__table__])
    db_factory = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    monkeypatch.setattr(history_routes, "SessionLocal", db_factory)
    monkeypatch.setattr(history_routes, "_verify_session_owner", lambda *args, **kwargs: None)

    old = {"version": 1, "total_tokens": 10, "categories": {"instructions": {"tokens": 10}}}
    assert history_routes._clean_context_inspection(old)["input_budget_tokens"] is None
    newest = {
        "version": 1, "estimated": True, "total_tokens": 55,
        "context_length": 1000, "output_reserve": 100,
        "input_budget_tokens": 700, "available_tokens": 700, "remaining_tokens": 645,
        "categories": {
            "instructions": {"tokens": 20, "items": 1, "characters": 50},
            "native_tool_schemas": {"tokens": 5, "items": 1, "characters": 10},
            "memory_docs": {"tokens": 10, "items": 1, "characters": 20},
            "conversation": {"tokens": 15, "items": 2, "characters": 40},
            "tool_results": {"tokens": 5, "items": 1, "characters": 15},
            "archives": {"tokens": 0, "items": 1, "characters": 0, "count": 1, "bytes": 25},
        },
        "prompt_text": "must never be returned",
    }
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    db = db_factory()
    db.add(cdb.Session(id="session-1", owner="alice", name="chat", endpoint_url="http://local", model="model"))
    db.add_all([
        cdb.ChatMessage(id="older", session_id="session-1", role="assistant", content="old", meta_data=json.dumps({"context_inspection": old}), timestamp=now),
        cdb.ChatMessage(id="newer", session_id="session-1", role="assistant", content="new", meta_data=json.dumps({"context_inspection": newest}), timestamp=now + timedelta(seconds=1)),
    ])
    db.commit(); db.close()

    monkeypatch.setattr(tool_result_store, "DATA_DIR", str(tmp_path))
    tool_result_store.archive_result("alice", "session-1", "fetch", "alice archive")
    tool_result_store.archive_result("bob", "session-1", "fetch", "bob archive")
    monkeypatch.setattr(history_routes, "effective_user", lambda request: "alice")

    class _Session:
        endpoint_url = "http://local"
        model = "model"
        history = []
        def get_context_messages(self):
            return [{"role": "user", "content": "hello"}]

    class _Manager:
        def get_session(self, session_id):
            return _Session()

    from src import model_context
    monkeypatch.setattr(model_context, "get_context_length", lambda *_: 1000)
    router = history_routes.setup_history_routes(_Manager())
    endpoint = next(route.endpoint for route in router.routes
                    if route.path == "/api/session/{session_id}/context")
    result = asyncio.run(endpoint(SimpleNamespace(), "session-1"))

    assert result["last_request"]["total_tokens"] == 55
    assert result["last_request"]["input_budget_tokens"] == 700
    assert result["last_request"]["available_tokens"] == 700
    assert "prompt_text" not in result["last_request"]
    assert result["archives"]["count"] == 1
    assert result["archives"]["bytes"] == len("alice archive")
    engine.dispose()
