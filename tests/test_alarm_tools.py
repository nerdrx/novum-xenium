from datetime import datetime, timezone
from zoneinfo import ZoneInfo

import pytest

from src.agent_tools import alarm_tools


class _FixedDateTime(datetime):
    current = datetime(2026, 10, 16, 11, 0, tzinfo=timezone.utc)

    @classmethod
    def now(cls, tz=None):
        return cls.current.astimezone(tz) if tz else cls.current.replace(tzinfo=None)


class _Response:
    def __init__(self, data):
        self.data = data

    def raise_for_status(self):
        return None

    def json(self):
        return self.data


class _Client:
    calls = []
    response = {"alarm": {"id": "f5a2bd4d-7068-45b5-a9f4-08e736739f0c", "status": "scheduled"}}
    error = None

    def __init__(self, **kwargs):
        self.kwargs = kwargs

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def request(self, method, url, **kwargs):
        self.calls.append((method, url, kwargs))
        if self.error:
            raise self.error
        return _Response(self.response)


@pytest.fixture(autouse=True)
def _bridge_env(monkeypatch, tmp_path):
    token = tmp_path / "bridge-token"
    token.write_text("test-secret")
    token.chmod(0o600)
    monkeypatch.setenv("NOVUM_ALARM_BRIDGE_TOKEN_FILE", str(token))
    monkeypatch.delenv("NOVUM_ALARM_BRIDGE_URL", raising=False)
    monkeypatch.setattr(_FixedDateTime, "current", datetime(2026, 10, 16, 11, 0, tzinfo=timezone.utc))
    monkeypatch.setattr(alarm_tools, "datetime", _FixedDateTime)
    monkeypatch.setattr(alarm_tools, "now_user_local", lambda: _FixedDateTime.current.astimezone(ZoneInfo("Europe/Berlin")))
    monkeypatch.setattr(alarm_tools, "user_timezone", lambda: ZoneInfo("Europe/Berlin"))
    monkeypatch.setattr(alarm_tools.httpx, "AsyncClient", _Client)
    _Client.calls = []
    _Client.error = None
    _Client.response = {"alarm": {"id": "f5a2bd4d-7068-45b5-a9f4-08e736739f0c", "status": "scheduled"}}


@pytest.mark.asyncio
async def test_create_injects_authenticated_owner_and_user_timezone():
    result = await alarm_tools.ManageAlarmsTool().execute(
        '{"action":"create","at":"15:00","label":"Wake up"}',
        {"owner": "alice"},
    )
    assert result["exit_code"] == 0
    method, url, kwargs = _Client.calls[0]
    assert method == "POST" and url == "http://127.0.0.1:8127/v1/alarms"
    assert kwargs["headers"]["Authorization"] == "Bearer test-secret"
    assert kwargs["json"]["owner"] == "alice"
    assert kwargs["json"]["at"] == "2026-10-16T15:00:00+02:00"
    assert kwargs["json"]["volume_percent"] == 100
    assert kwargs["json"]["duration_seconds"] == 300


@pytest.mark.asyncio
async def test_time_rejects_past_without_moving_to_tomorrow():
    result = await alarm_tools.ManageAlarmsTool().execute(
        '{"action":"create","at":"10:30"}', {"owner": "alice"}
    )
    assert result["exit_code"] == 1
    assert "already passed" in result["error"]
    assert not _Client.calls


@pytest.mark.asyncio
async def test_iso_naive_time_uses_user_zone_and_rejects_bad_bounds():
    result = await alarm_tools.ManageAlarmsTool().execute(
        '{"action":"create","at":"2026-10-16T15:10"}', {"owner": "alice"}
    )
    assert result["exit_code"] == 0
    assert _Client.calls[0][2]["json"]["at"] == "2026-10-16T15:10:00+02:00"
    _Client.calls = []
    result = await alarm_tools.ManageAlarmsTool().execute(
        '{"action":"create","at":"15:30","volume_percent":101}', {"owner": "alice"}
    )
    assert result["exit_code"] == 1
    assert "0 to 100" in result["error"]
    assert not _Client.calls


@pytest.mark.asyncio
async def test_hour_only_time_means_that_hour_today():
    result = await alarm_tools.ManageAlarmsTool().execute(
        '{"action":"create","at":"15"}', {"owner": "alice"}
    )
    assert result["exit_code"] == 0
    assert _Client.calls[0][2]["json"]["at"] == "2026-10-16T15:00:00+02:00"


@pytest.mark.asyncio
async def test_dst_gap_and_ambiguous_wall_times_require_explicit_offset(monkeypatch):
    # At the spring transition, 02:30 does not exist; do not silently turn it
    # into 03:30 when serializing the local-zone datetime.
    monkeypatch.setattr(_FixedDateTime, "current", datetime(2026, 3, 29, 0, 30, tzinfo=timezone.utc))
    result = await alarm_tools.ManageAlarmsTool().execute(
        '{"action":"create","at":"02:30"}', {"owner": "alice"}
    )
    assert result["exit_code"] == 1
    assert "does not exist" in result["error"]
    assert not _Client.calls

    # The fall transition repeats 02:30 with two possible UTC offsets.
    monkeypatch.setattr(_FixedDateTime, "current", datetime(2026, 10, 24, 10, 0, tzinfo=timezone.utc))
    result = await alarm_tools.ManageAlarmsTool().execute(
        '{"action":"create","at":"2026-10-25T02:30"}', {"owner": "alice"}
    )
    assert result["exit_code"] == 1
    assert "occurs twice" in result["error"]
    assert not _Client.calls

    # An explicit offset resolves which occurrence the user intends.
    result = await alarm_tools.ManageAlarmsTool().execute(
        '{"action":"create","at":"2026-10-25T02:30:00+01:00"}', {"owner": "alice"}
    )
    assert result["exit_code"] == 0
    assert _Client.calls[0][2]["json"]["at"] == "2026-10-25T02:30:00+01:00"


@pytest.mark.asyncio
async def test_model_cannot_select_owner_and_bridge_failure_is_honest():
    result = await alarm_tools.ManageAlarmsTool().execute(
        '{"action":"list","owner":"bob"}', {"owner": "alice"}
    )
    assert result["exit_code"] == 1
    assert "server-controlled" in result["error"]
    assert not _Client.calls

    _Client.error = alarm_tools.httpx.ConnectError("unavailable")
    result = await alarm_tools.ManageAlarmsTool().execute(
        '{"action":"list"}', {"owner": "alice"}
    )
    assert result["exit_code"] == 1
    assert "could not be reached" in result["error"]


def test_alarm_write_is_sensitive_to_untrusted_context():
    from src.tool_capabilities import ToolEffect, ToolRunSecurityContext, capabilities_for_action

    assert capabilities_for_action("manage_alarms", '{"action":"list"}').effects == {
        ToolEffect.READ_PRIVATE
    }
    creation = capabilities_for_action("manage_alarms", '{"action":"create","at":"15:00"}')
    assert ToolEffect.WRITE_PRIVATE in creation.effects
    security = ToolRunSecurityContext(external_untrusted_context_seen=True)
    assert not security.decision_for("manage_alarms", '{"action":"create","at":"15:00"}').allowed


def test_alarm_is_registered_as_a_tool_and_plan_mode_mutator():
    from src import tool_security
    from src.agent_tools import TOOL_HANDLERS
    from src.tool_security import plan_mode_disabled_tools
    from src.tool_types import TOOL_TAGS
    from src.tool_schemas import FUNCTION_TOOL_SCHEMAS

    assert "manage_alarms" in TOOL_HANDLERS and "manage_alarms" in TOOL_TAGS
    assert any(item["function"]["name"] == "manage_alarms" for item in FUNCTION_TOOL_SCHEMAS)
    assert "manage_alarms" in plan_mode_disabled_tools()
    assert "manage_alarms" in tool_security.NON_ADMIN_BLOCKED_TOOLS
    assert tool_security.is_public_blocked_tool("manage_alarms")


@pytest.mark.asyncio
async def test_non_admin_cannot_control_shared_host_audio(monkeypatch, tmp_path):
    from src import tool_execution
    from src.agent_tools import ToolBlock

    monkeypatch.setattr(tool_execution, "_owner_is_admin", lambda _owner: False)
    _, result = await tool_execution.execute_tool_block(
        ToolBlock("manage_alarms", '{"action":"create","at":"15:00"}'),
        owner="ordinary-user",
        security_context=tool_execution.NO_TOOL_SECURITY_CONTEXT,
    )
    assert result["exit_code"] == 1
    assert "admin" in result["error"].lower()
    assert not _Client.calls
