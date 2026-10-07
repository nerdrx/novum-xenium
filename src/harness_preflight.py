"""Offline, owner-scoped capability preflight for a chat session."""
from __future__ import annotations

import json
import os
from pathlib import Path

from src import model_capabilities as mc
from src.auth_helpers import owner_filter
from src.model_capability_readers.base import detect_vendor
from src.model_context import _lookup_known
from src.tool_capabilities import capabilities_for_tool
from src.tool_policy import known_tool_names


def _capability(endpoint):
    capability = mc.capability_from_endpoint_type(getattr(endpoint, "model_type", None))
    capability_data = capability.to_dict()
    supported = getattr(endpoint, "supports_tools", None)
    if supported is True:
        capability_data["capabilities"] = sorted(set(capability_data["capabilities"]) | {mc.CAP_TOOL_CALL})
    assertions = mc.capability_assertions_from_capability(
        capability, status=mc.ASSERTION_CLAIMED, source=capability.source,
        confidence=capability.confidence,
    )
    status = (mc.ASSERTION_CLAIMED if supported is True else
              mc.ASSERTION_UNSUPPORTED if supported is False else mc.ASSERTION_UNKNOWN)
    assertions = list(assertions) + [mc.CapabilityAssertion.build(
        capability=mc.CAP_TOOL_CALL, status=status,
        source=mc.SOURCE_ENDPOINT_CONFIG if supported is not None else mc.SOURCE_UNKNOWN,
        confidence=mc.CONFIDENCE_EXPLICIT if supported is not None else mc.CONFIDENCE_UNKNOWN,
    )]
    return capability_data, [item.to_dict() for item in assertions], status


def _tool_inventory():
    from src.agent_tools import TOOL_HANDLERS
    from src.settings import get_setting

    disabled = set(get_setting("disabled_tools", []) or [])
    known = known_tool_names()
    items = []
    for name in sorted(known | set(TOOL_HANDLERS)):
        caps = capabilities_for_tool(name)
        items.append({
            "name": name,
            "availability": "disabled" if name in disabled else
                            "available" if name in TOOL_HANDLERS else "unknown",
            "capability_known": bool(caps.known),
            "effects": sorted(caps.effects) if caps.known else [],
        })
    manager = None
    try:
        from src.tool_utils import get_mcp_manager
        manager = get_mcp_manager()
        if manager:
            from src.agent_loop import _load_mcp_disabled_map
            rows = manager.get_all_tools(_load_mcp_disabled_map())
            for row in rows:
                name = row.get("qualified_name", "")
                if not name:
                    continue
                items.append({
                    "name": name,
                    "availability": "disabled" if row.get("is_disabled") or name in disabled else "available",
                    "capability_known": capabilities_for_tool(name).known,
                    "effects": sorted(capabilities_for_tool(name).effects),
                })
    except Exception:
        # MCP inventory is optional; native declarations remain useful.
        pass
    return items, disabled, manager


def _search_readiness():
    from services.search.providers import PROVIDER_INFO, _get_provider_key, _get_search_instance
    from src.settings import get_setting

    provider = str(get_setting("search_provider", "searxng") or "").strip().lower()
    if provider == "disabled":
        return {"status": "disabled", "provider": provider, "source": "search_provider_configuration",
                "reason": "Search provider is disabled"}
    info = PROVIDER_INFO.get(provider)
    if info is None:
        return {"status": "unknown", "provider": "unknown", "source": "search_provider_configuration",
                "reason": "Configured provider is not recognized"}
    _, needs_key, needs_url = info
    if needs_key and not _get_provider_key(provider):
        return {"status": "unavailable", "provider": provider, "source": "search_provider_configuration",
                "reason": "Provider credential is not configured"}
    if needs_url and provider == "searxng" and not _get_search_instance():
        return {"status": "unavailable", "provider": provider, "source": "search_provider_configuration",
                "reason": "Search service URL is not configured"}
    return {"status": "configured_unverified", "provider": provider, "source": "search_provider_configuration",
            "reason": "Per-turn toggle and provider reachability were not checked"}


def build_preflight(session, owner: str, workspace: str | None = None, *, details=None):
    from core.database import ModelEndpoint, SessionLocal
    from src.settings import get_setting, get_user_setting
    from src.endpoint_resolver import normalize_base
    from src import run_evidence

    model = str(getattr(session, "model", "") or "")
    endpoint_url = str(getattr(session, "endpoint_url", "") or "")
    db = SessionLocal()
    endpoint = None
    try:
        query = owner_filter(db.query(ModelEndpoint), ModelEndpoint, owner)
        normalized = normalize_base(endpoint_url)
        if normalized:
            endpoint = next((row for row in query.all()
                             if normalize_base(row.base_url) == normalized), None)
    finally:
        db.close()

    cap, assertions, tool_status = _capability(endpoint) if endpoint else (
        mc.unknown_capability().to_dict(), [], mc.ASSERTION_UNKNOWN)
    known_context = _lookup_known(model)
    tools, globally_disabled, mcp = _tool_inventory()
    search = _search_readiness()

    browser_tool_names = {"builtin_browser"}
    browser_rows = [tool for tool in tools if tool["name"].startswith("mcp__builtin_browser__")]
    browser_disabled = bool(browser_rows) and all(row["availability"] == "disabled" for row in browser_rows)
    browser_connected = False
    if mcp and browser_rows:
        try:
            browser_connected = (
                mcp.get_server_status("builtin_browser").get("status") == "connected"
                and any(row["availability"] == "available" for row in browser_rows)
            )
        except Exception:
            pass
    browser_status = "disabled" if browser_disabled or browser_tool_names & globally_disabled else (
        "connected" if browser_connected else "unavailable")

    image_enabled = bool(get_user_setting("image_gen_enabled", owner, False))
    image_status = "disabled" if not image_enabled or "generate_image" in globally_disabled else "unavailable"
    if mcp:
        try:
            if mcp.get_server_status("image_gen").get("status") == "connected" and image_enabled and "generate_image" not in globally_disabled:
                image_status = "configured_unverified"
        except Exception:
            pass

    worker_url = os.getenv("ODYSSEUS_EXECUTOR_URL", "").strip()
    mode = "separate_container" if worker_url else "local_process"
    worker_status = "not_configured"
    mapped = None
    if worker_url:
        root = Path(os.getenv("ODYSSEUS_EXECUTOR_ROOT", "/workspace")).resolve()
        try:
            from src.tool_execution import vet_workspace
            vetted = vet_workspace(workspace or "")
            mapped = bool(vetted) and Path(vetted).resolve().is_relative_to(root)
        except Exception:
            mapped = False if workspace else None
        worker_status = "configured_unverified" if os.getenv("ODYSSEUS_EXECUTOR_TOKEN") and mapped else "misconfigured"

    runs = run_evidence.list_runs(getattr(session, "id", ""), owner)
    latest = None
    if runs:
        run = runs[0]
        failures = []
        for event in run.get("events", []):
            if not isinstance(event, dict):
                continue
            if event.get("type") == "error" or (event.get("type") == "tool_output" and event.get("exit_code") not in (None, 0)):
                failure = {key: event[key] for key in ("type", "tool", "exit_code") if key in event}
                if event.get("status") in {"failed", "error", "cancelled", "timeout"}:
                    failure["status"] = event["status"]
                failures.append(failure)
        latest = {"status": run.get("status"), "model": run.get("model"),
                  "duration_seconds": run.get("duration_seconds"), "failures": failures}

    result = {
        "schema_version": 1,
        "session": {"id": getattr(session, "id", ""), "model": model},
        "workspace": {"supplied": bool(workspace), "worker_mapped": mapped if worker_url else None},
        "model": {
            "id": model,
            "provider": {"id": detect_vendor(endpoint_url, getattr(endpoint, "endpoint_kind", "")),
                         "source": "endpoint_config_or_url_classification"},
            "capability": cap,
            "assertions": assertions,
            "tool_calling": {"status": tool_status, "source": "endpoint_config" if endpoint and getattr(endpoint, "supports_tools", None) is not None else "unknown"},
            "context_window": {"status": "registry_advisory" if known_context else "unknown", "tokens": known_context,
                               "source": "known_model_registry" if known_context else "unknown",
                               "reason": "Registry value is not the selected endpoint's serving limit" if known_context else "No curated registry value"},
        },
        "endpoint": {"configured": endpoint is not None,
                     "enabled": bool(endpoint.is_enabled) if endpoint else None,
                     "inventory_cached": bool(getattr(endpoint, "cached_models", None)) if endpoint else False,
                     "selected_model_hidden": model in _json_strings(getattr(endpoint, "hidden_models", None)) if endpoint else None,
                     "probe": {"status": "not_run", "reason": "Preflight is offline"}},
        "backends": {
            "search": search,
            "browser": {"status": browser_status, "source": "live_mcp_inventory",
                        "reason": "No connected browser tool" if browser_status == "unavailable" else ""},
            "image_generation": {"status": image_status, "source": "user_setting_and_mcp",
                                 "reason": "Image generation is disabled or unavailable" if image_status != "configured_unverified" else "Reachability was not probed"},
        },
        "tools": {"source": "native declarations and current MCP inventory", "globally_disabled": sorted(globally_disabled), "items": tools},
        "execution": {"mode": mode, "status": worker_status, "source": "executor environment configuration"},
        "latest_run": latest,
    }
    if details is not None:
        result["details"] = details
    return result


def _json_strings(value):
    try:
        parsed = json.loads(value or "[]")
        return parsed if isinstance(parsed, list) else []
    except (TypeError, json.JSONDecodeError):
        return []
