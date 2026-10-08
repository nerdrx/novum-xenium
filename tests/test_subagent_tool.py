import asyncio
import json
from types import SimpleNamespace

from src.agent_tools import TOOL_HANDLERS
from src.tool_schemas import FUNCTION_TOOL_SCHEMAS, function_call_to_tool_block
from src.tool_types import TOOL_TAGS


def test_delegate_subagent_is_registered_as_native_tool():
    schema = next(item["function"] for item in FUNCTION_TOOL_SCHEMAS
                  if item.get("function", {}).get("name") == "delegate_subagent")
    assert "delegate_subagent" in TOOL_TAGS
    assert "delegate_subagent" in TOOL_HANDLERS
    assert schema["parameters"]["additionalProperties"] is False
    assert "list_models" in schema["description"]
    call = function_call_to_tool_block("delegate_subagent", '{"task":"inspect this"}')
    assert call.tool_type == "delegate_subagent"
    assert call.content == '{"task": "inspect this"}'


def test_subagent_permission_gate_fails_closed(monkeypatch):
    from src.agent_tools import subagent_tools

    monkeypatch.setattr(subagent_tools, "subagents_enabled", lambda: False)
    result = asyncio.run(subagent_tools.delegate_subagent('{"task":"do work"}', {}))
    assert result["exit_code"] == 1
    assert "Enable the Subagents module" in result["error"]


def test_unavailable_child_model_creates_no_chat(monkeypatch):
    from src import ai_interaction
    from src.agent_tools import subagent_tools

    class Manager:
        created = False

        def get_session(self, session_id):
            return SimpleNamespace(owner="owner", endpoint_url="https://model.invalid/v1", model="parent", headers={})

        def create_session(self, *args, **kwargs):
            self.created = True

    manager = Manager()
    monkeypatch.setattr(subagent_tools, "subagents_enabled", lambda: True)
    monkeypatch.setattr(subagent_tools, "get_session_manager", lambda: manager)
    monkeypatch.setattr(ai_interaction, "_resolve_model", lambda *args, **kwargs: (_ for _ in ()).throw(ValueError("not configured")))
    result = asyncio.run(subagent_tools.delegate_subagent(
        '{"task":"do work","model":"unavailable"}',
        {"owner": "owner", "session_id": "parent", "security_context": object()},
    ))
    assert result["exit_code"] == 1
    assert "unavailable to this account" in result["error"]
    assert not manager.created


def test_spawn_wait_preserves_route_and_ownership(monkeypatch, tmp_path):
    from src import agent_runs, ai_interaction
    from src.agent_tools import subagent_tools
    from src import agent_loop
    from src import subagents

    class Session:
        def __init__(self, session_id, owner, endpoint_url, model, headers=None):
            self.id, self.owner, self.endpoint_url, self.model = session_id, owner, endpoint_url, model
            self.headers, self.history = headers or {}, []

        def add_message(self, message):
            self.history.append(message)

    class Manager:
        def __init__(self):
            self.sessions = {"parent": Session("parent", "alice", "https://parent.invalid/v1", "parent-model", {"X-Parent": "yes"})}

        def get_session(self, session_id):
            return self.sessions.get(session_id)

        def create_session(self, session_id, name, endpoint_url, model, rag=False, owner=None):
            child = Session(session_id, owner, endpoint_url, model)
            child.name = name
            self.sessions[session_id] = child
            return child

        def delete_session(self, session_id):
            self.sessions.pop(session_id, None)

    manager = Manager()
    statuses, owners, tasks, captured = {}, {}, {}, []
    monkeypatch.setattr(subagent_tools, "subagents_enabled", lambda: True)
    monkeypatch.setattr(subagent_tools, "get_session_manager", lambda: manager)
    monkeypatch.setattr(subagents, "DATA_DIR", str(tmp_path))

    class Db:
        def query(self, model): return self
        def filter(self, *args): return self
        def first(self): return SimpleNamespace(headers={}, mode="chat")
        def commit(self): pass
        def close(self): pass

    monkeypatch.setattr("core.database.SessionLocal", Db)
    monkeypatch.setattr(agent_loop, "_assemble_prompt", lambda *args, **kwargs: "")
    monkeypatch.setattr(agent_loop, "stream_agent_loop", lambda *a, **kw: None)

    async def fake_stream(*args, **kwargs):
        captured.append((args, kwargs))
        yield 'data: {"delta":"child answer"}\n\n'
        if kwargs["session_id"] == spawn_ids[0]:
            card = {"kind": "tool_approval", "approval_id": "approval-1", "session_id": kwargs["session_id"], "question": "Allow?", "options": [{"label": "Allow", "value": "approve"}]}
            yield "data: " + json.dumps({"type": "tool_output", "ask_user": card}) + "\n\n"
            yield "data: " + json.dumps({"type": "ask_user", "data": card}) + "\n\n"
        yield "data: [DONE]\n\n"

    spawn_ids = []
    monkeypatch.setattr(agent_loop, "stream_agent_loop", fake_stream)
    monkeypatch.setattr("src.tool_index.get_tool_index", lambda: None)
    monkeypatch.setattr(ai_interaction, "_resolve_model", lambda spec, owner=None: ("https://chosen.invalid/v1", "chosen-model", {"X-Chosen": owner}))
    monkeypatch.setattr(agent_runs, "is_active", lambda sid: statuses.get(sid) == "running")
    monkeypatch.setattr(agent_runs, "get_status", lambda sid: statuses.get(sid))
    monkeypatch.setattr(agent_runs, "get_run_id", lambda sid: sid if statuses.get(sid) == "running" else None)
    monkeypatch.setattr(agent_runs, "get_run_owner", lambda sid: owners.get(sid))
    monkeypatch.setattr(agent_runs, "stop", lambda sid, run_id: statuses.__setitem__(sid, "stopped") is None)

    def start(session_id, agen, *, owner=None, context=None):
        statuses[session_id], owners[session_id] = "running", owner

        async def drain():
            try:
                async for _ in agen:
                    pass
            except Exception:
                statuses[session_id] = "error"
            else:
                statuses[session_id] = "done"
        tasks[session_id] = asyncio.create_task(drain())

    monkeypatch.setattr(agent_runs, "start", start)
    security = SimpleNamespace(approval_mode="ask", delegated_credential=False, external_untrusted_context_seen=True)
    context = {"owner": "alice", "session_id": "parent", "workspace": "/work", "disabled_tools": {"bash"},
               "tool_policy": SimpleNamespace(disabled_tools=frozenset({"python"})), "security_context": security}

    async def exercise():
        default = await subagent_tools.delegate_subagent('{"task":"first task"}', context)
        assert default["exit_code"] == 0
        spawn_ids.append(default["session_id"])
        chosen = await subagent_tools.delegate_subagent('{"task":"second task","model":"qwen-test"}', context)
        assert chosen["exit_code"] == 0
        spawn_ids.append(chosen["session_id"])
        for session_id in spawn_ids:
            result = await subagent_tools.delegate_subagent(json.dumps({"action": "wait", "session_id": session_id, "timeout_seconds": 5}), context)
            if session_id == spawn_ids[0]:
                assert result["status"] == "waiting_approval"
            else:
                assert result["status"] == "done"
                assert "child answer" in result["response"]

    asyncio.run(exercise())
    assert len(captured) == 2
    assert captured[0][0][:2] == ("https://parent.invalid/v1", "parent-model")
    assert captured[0][1]["headers"] == {"X-Parent": "yes"}
    assert captured[1][0][:2] == ("https://chosen.invalid/v1", "chosen-model")
    assert captured[1][1]["headers"] == {"X-Chosen": "alice"}
    for _, kwargs in captured:
        assert kwargs["owner"] == "alice"
        assert kwargs["workspace"] == "/work"
        assert kwargs["approval_mode"] == "ask"
        assert kwargs["external_untrusted_context_seen"] is True
        assert {"bash", "delegate_subagent", "create_session", "send_to_session", "manage_session", "ask_user"} <= kwargs["disabled_tools"]
        assert kwargs["tool_policy"].disabled_tools == frozenset({"python"})
    # A child id cannot be used as a parent or controlled from another account.
    child_id = next(iter(statuses))
    from src.subagents import approval_resume_security, get_child
    record = get_child(child_id, "alice", "parent")
    assert record and record["security"]["approval_mode"] == "ask"
    assert record["security"]["workspace"] == "/work"
    assert record["security"]["delegated_credential"] is False
    assert approval_resume_security(child_id, "alice", approval_id="approval-1")["workspace"] == "/work"
    try:
        approval_resume_security(child_id, "alice")
    except ValueError:
        pass
    else:
        raise AssertionError("ordinary child-chat messages must not resume")
    assert any((message.metadata or {}).get("tool_events", [{}])[-1].get("ask_user", {}).get("approval_id") == "approval-1"
               for message in manager.get_session(child_id).history if message.role == "assistant")
    wrong_owner = dict(context, owner="mallory")
    denied = asyncio.run(subagent_tools.delegate_subagent(json.dumps({"action": "status", "session_id": child_id}), wrong_owner))
    assert denied["exit_code"] == 1


def test_subagent_actions_have_explicit_effects():
    from src.tool_capabilities import capabilities_for_action, ToolEffect, ResultIntegrity
    spawn = capabilities_for_action('delegate_subagent', '{"task":"work"}')
    assert spawn.known
    assert ToolEffect.NETWORK_EGRESS in spawn.effects
    assert ToolEffect.WRITE_PRIVATE in spawn.effects
    for action in ('status', 'wait'):
        read = capabilities_for_action('delegate_subagent', {"action": action})
        assert read.effects == frozenset({ToolEffect.READ_PRIVATE})
        assert read.result_integrity == ResultIntegrity.EXTERNAL_UNTRUSTED
    assert capabilities_for_action('delegate_subagent', {"action": "cancel"}).effects == frozenset({ToolEffect.WRITE_PRIVATE})
