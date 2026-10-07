from types import SimpleNamespace

from src import harness_preflight as preflight


class _DB:
    def query(self, model):
        return self

    def all(self):
        return [self.endpoint]

    def close(self):
        pass


def test_endpoint_tool_claim_is_tristate():
    for configured, expected in ((True, "claimed"), (False, "unsupported"), (None, "unknown")):
        capability, assertions, status = preflight._capability(SimpleNamespace(model_type="llm", supports_tools=configured))
        assert status == expected
        tool_assertion = next(item for item in assertions if item["capability"] == "tool_call")
        assert tool_assertion["status"] == expected
        assert ("tool_call" in capability["capabilities"]) is (expected == "claimed")


def test_offline_preflight_is_redacted_and_keeps_unknowns(monkeypatch):
    import core.database
    import src.settings
    import src.run_evidence

    endpoint = SimpleNamespace(
        base_url="https://api.openai.com/v1?api_key=not-for-response", model_type="llm",
        supports_tools=None, endpoint_kind="openai", is_enabled=True, cached_models='["custom-model"]',
        hidden_models="[]",
    )
    db = _DB()
    db.endpoint = endpoint
    monkeypatch.setattr(core.database, "SessionLocal", lambda: db)
    monkeypatch.setattr(preflight, "owner_filter", lambda query, model, owner: query)
    monkeypatch.setattr(src.settings, "get_setting", lambda key, default=None: {
        "disabled_tools": ["bash"], "search_provider": "https://secret.example/?key=hidden",
        "search_enabled": True,
    }.get(key, default))
    monkeypatch.setattr(src.settings, "get_user_setting", lambda key, owner, default=None: default)
    monkeypatch.setattr(preflight, "_tool_inventory", lambda: ([{
        "name": "bash", "availability": "disabled", "capability_known": True, "effects": ["process"]
    }], {"bash"}, None))
    monkeypatch.setattr(src.run_evidence, "list_runs", lambda session, owner: [{
        "status": "failed", "model": "custom-model", "duration_seconds": 0.2,
        "events": [{"type": "error", "status": "private error text", "tool": "bash"}],
    }])
    monkeypatch.delenv("ODYSSEUS_EXECUTOR_URL", raising=False)

    result = preflight.build_preflight(
        SimpleNamespace(id="s1", model="custom-model", endpoint_url="https://api.openai.com/v1"), "alice",
        workspace="/private/workspace",
    )
    assert result["model"]["tool_calling"]["status"] == "unknown"
    assert result["model"]["context_window"]["status"] == "unknown"
    assert result["endpoint"]["probe"]["status"] == "not_run"
    assert result["tools"]["items"][0]["availability"] == "disabled"
    assert result["latest_run"]["failures"] == [{"type": "error", "tool": "bash"}]
    serialized = str(result)
    assert "secret.example" not in serialized
    assert "not-for-response" not in serialized
    assert "private error text" not in serialized
    assert "/private/workspace" not in serialized


def test_search_readiness_uses_provider_requirements_without_leaking_url(monkeypatch):
    import src.settings
    from services.search import providers

    monkeypatch.setattr(src.settings, "get_setting", lambda key, default=None: {
        "search_provider": "brave",
    }.get(key, default))
    monkeypatch.setattr(providers, "_get_provider_key", lambda provider: "secret-key")
    readiness = preflight._search_readiness()
    assert readiness == {
        "status": "configured_unverified", "provider": "brave",
        "source": "search_provider_configuration",
        "reason": "Per-turn toggle and provider reachability were not checked",
    }
    monkeypatch.setattr(src.settings, "get_setting", lambda key, default=None: {
        "search_provider": "https://internal/?token=secret",
    }.get(key, default))
    assert preflight._search_readiness()["provider"] == "unknown"


def test_worker_mapping_uses_vetted_supplied_workspace(monkeypatch):
    import core.database
    import src.settings
    import src.run_evidence
    import src.tool_execution

    class DB(_DB):
        def query(self, model):
            return self
        def all(self):
            return []

    monkeypatch.setattr(core.database, "SessionLocal", DB)
    monkeypatch.setattr(preflight, "owner_filter", lambda query, model, owner: query)
    monkeypatch.setattr(src.settings, "get_setting", lambda key, default=None: default)
    monkeypatch.setattr(src.settings, "get_user_setting", lambda key, owner, default=None: default)
    monkeypatch.setattr(src.run_evidence, "list_runs", lambda session, owner: [])
    monkeypatch.setattr(preflight, "_tool_inventory", lambda: ([], set(), None))
    monkeypatch.setattr(src.tool_execution, "vet_workspace", lambda path: "/worker/root/project" if path == "/host/project" else None)
    monkeypatch.setenv("ODYSSEUS_EXECUTOR_URL", "http://executor.internal")
    monkeypatch.setenv("ODYSSEUS_EXECUTOR_TOKEN", "secret")
    monkeypatch.setenv("ODYSSEUS_EXECUTOR_ROOT", "/worker/root")
    session = SimpleNamespace(id="s", model="custom", endpoint_url="")

    result = preflight.build_preflight(session, "alice", "/host/project")
    assert result["workspace"]["worker_mapped"] is True
    assert result["execution"]["status"] == "configured_unverified"

    monkeypatch.setattr(src.tool_execution, "vet_workspace", lambda path: "/outside/project")
    result = preflight.build_preflight(session, "alice", "/host/project")
    assert result["workspace"]["worker_mapped"] is False
    assert result["execution"]["status"] == "misconfigured"
