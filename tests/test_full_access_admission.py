"""Human Full Access preauthorization remains bounded by owner and policy."""
from types import SimpleNamespace

import pytest

from src.agent_runtime.authority import (
    ExactOperation, MISSING_AUTHORITY, active_request_authority,
    create_request_authority, request_authority_for_http,
    with_request_authority,
)
from src.tool_policy import ToolPolicy


def operation(tool):
    return ExactOperation.normalize(tool, '{}')


def test_full_preauthorizes_known_operations_without_lexical_intent(tmp_path):
    full = create_request_authority("Please handle this", approval_mode="full",
        owner="alice", session_id="chat", workspace=str(tmp_path))
    auto = create_request_authority("Please handle this")
    for tool in ("web_fetch", "read_file", "write_file", "manage_notes", "search_tools"):
        assert full.permits(operation(tool))
        assert not auto.permits(operation(tool))
    assert full.bound_to(owner="alice", session_id="chat", workspace=str(tmp_path))
    assert not full.bound_to(owner="bob", session_id="chat", workspace=str(tmp_path))
    assert not full.permits(operation("unknown_plugin_from_model"))
    assert len(full.resource_roots) == 1
    assert full.resource_roots[0].path == str(tmp_path)


def test_full_keeps_explicit_disabled_and_parent_limits():
    full = create_request_authority("Please handle this", approval_mode="full",
        policy=ToolPolicy(disabled_tools=frozenset({"web_fetch"})))
    assert not full.permits(operation("web_fetch"))
    assert full.permits(operation("read_file"))
    parent = create_request_authority("Transcribe /workspace/input/voice.wav")
    child = parent.intersect(full)
    assert child.permits(operation("transcribe_media"))
    assert not child.permits(operation("bash"))
    assert not child.permits(operation("read_file"))


@pytest.mark.parametrize("saved,requested,allowed", [
    ("full", "full", True), ("auto", "full", False),
    ("ask", "full", False), ("full", "auto", False),
])
def test_http_full_requires_saved_human_mode(monkeypatch, saved, requested, allowed):
    from routes import prefs_routes
    monkeypatch.setattr(prefs_routes, "resolve_tool_approval_mode", lambda request: saved)
    request = SimpleNamespace(headers={}, state=SimpleNamespace(current_user="alice"))
    authority = request_authority_for_http(request, "Please handle this",
        owner="alice", approval_mode=requested)
    assert authority.permits(operation("read_file")) is allowed


@pytest.mark.asyncio
@pytest.mark.parametrize("context,allowed", [
    ({}, True), ({"delegated_credential": True}, False),
    ({"plan_mode": True}, False), ({"workload": "background"}, False),
    ({"_parent_run_id": "parent"}, False),
])
async def test_native_full_cannot_upgrade_noninteractive_or_inherited_run(context, allowed):
    @with_request_authority
    async def run(messages, owner="alice", session_id="chat", approval_mode="full",
                  delegated_credential=False, plan_mode=False, workload=None,
                  _parent_run_id=None, request_authority=MISSING_AUTHORITY):
        yield active_request_authority().permits(operation("read_file"))
    assert [value async for value in run([{"role":"user", "content":"Please handle this"}],
                                         **context)] == [allowed]


@pytest.mark.asyncio
@pytest.mark.parametrize("mode,disabled,full_expected", [
    ("full", False, True), ("full", True, True), ("auto", False, False),
    ("full_plan", False, False), ("full_compare", False, False),
])
async def test_real_route_full_keeps_policy_without_classifier_denial(monkeypatch, mode, disabled, full_expected):
    from routes import chat_routes, prefs_routes
    from src import settings
    from tests.test_foreground_model_routing import _RouteRequest, _chat_stream_endpoint
    endpoint = _chat_stream_endpoint(monkeypatch, "agent", {})
    actual_mode = "full" if mode.startswith("full") else mode
    message = "Read the Python documentation online"
    monkeypatch.setattr(chat_routes, "coerce_message_and_session", lambda *a, **k: (message, "session-1"))
    monkeypatch.setattr(chat_routes, "resolve_tool_approval_mode", lambda request: actual_mode)
    monkeypatch.setattr(prefs_routes, "resolve_tool_approval_mode", lambda request: actual_mode)
    monkeypatch.setattr(settings, "get_setting", lambda key, default=None:
                        ["web_fetch"] if disabled and key == "disabled_tools" else default)
    observed = []
    async def capture_agent(*args, **kwargs):
        grant = kwargs["request_authority"]
        observed.append(kwargs)
        assert grant.permits(operation("web_fetch")) is not disabled
        if full_expected:
            assert kwargs["turn_contract"] is None
            assert grant.permits(operation("read_file"))
            assert "read_file" not in kwargs["disabled_tools"]
        yield 'data: {"delta":"Checked."}\n\n'
        yield 'data: [DONE]\n\n'
    monkeypatch.setattr(chat_routes, "stream_agent_loop", capture_agent)
    request = _RouteRequest("agent")
    request._form.update({"message":message, "compare_mode":"true" if mode == "full_compare" else "false",
                          "plan_mode":"true" if mode == "full_plan" else "false"})
    response = await endpoint(request)
    assert response.status_code == 200
    chunks = [chunk async for chunk in response.body_iterator]
    assert any("Checked." in chunk for chunk in chunks)
    assert len(observed) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("mode,disabled,expected", [
    ("full", set(), True), ("auto", set(), False),
    ("full", {"read_file"}, False),
])
async def test_actual_dispatcher_full_has_no_second_intent_approval(monkeypatch, tmp_path, mode, disabled, expected):
    from unittest.mock import AsyncMock
    from src import tool_execution as execution
    from src.tool_capabilities import ToolRunSecurityContext
    from src.tool_types import ToolBlock
    target = tmp_path / "hello.txt"
    target.write_text("fixture")
    implementation = AsyncMock(return_value=("read_file", {"exit_code":0,"output":"fixture"}))
    monkeypatch.setattr(execution, "_execute_tool_block_impl", implementation)
    grant = create_request_authority("Please handle this", approval_mode=mode,
        owner="alice", session_id="chat", workspace=str(tmp_path))
    _, result = await execution.execute_tool_block(ToolBlock("read_file", str(target)),
        owner="alice", session_id="chat", workspace=str(tmp_path),
        disabled_tools=disabled, request_authority=grant,
        security_context=ToolRunSecurityContext(approval_mode=mode))
    assert (implementation.await_count == 1) is expected
    assert bool(result.get("blocked")) is not expected


@pytest.mark.parametrize("token,headers", [
    (True, {}), (False, {"X-Odysseus-Internal-Token":"untrusted"}),
])
def test_full_http_cannot_borrow_owner_consent_for_other_credentials(monkeypatch, token, headers):
    from routes import prefs_routes
    monkeypatch.setattr(prefs_routes, "_load_for_user", lambda user: {"tool_approval_mode":"full"})
    request = SimpleNamespace(headers=headers,
        state=SimpleNamespace(current_user="alice", api_token=token))
    grant = request_authority_for_http(request, "Please handle this", owner="alice", approval_mode="full")
    assert not grant.permits(operation("read_file"))
