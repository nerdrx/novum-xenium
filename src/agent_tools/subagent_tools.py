"""Owned, detached child-agent chats backed by the normal session/run stores."""

from __future__ import annotations

import asyncio
import json
import re
import time
import uuid
from datetime import datetime, timezone

from core.models import ChatMessage
from src.ai_interaction import get_session_manager
from src.module_store import ModuleStore
from src.constants import DATA_DIR
from src.subagents import get_child, register, subagents_enabled, update_status

MAX_TASK_CHARS = 8000
MAX_WAIT_SECONDS = 30
MAX_RESULT_CHARS = 6000
_TERMINAL = {"done", "error", "stopped", "interrupted", "continued", "corrupt"}


def _title(raw, task):
    value = re.sub(r"[\x00-\x1f\x7f]", " ", str(raw or "")).strip()
    value = re.sub(r"\s+", " ", value)[:72]
    if not value:
        value = re.sub(r"[\x00-\x1f\x7f]", " ", task).strip().split(".", 1)[0][:64]
    return value or "Delegated task"


def _status(child):
    from src import agent_runs, run_checkpoints
    live = agent_runs.get_status(child["session_id"])
    if live:
        if live == "done" and child.get("status") in ("error", "waiting_approval"):
            return child["status"]
        return live
    if child.get("status") in ("error", "waiting_approval"):
        return child["status"]
    checkpoint = run_checkpoints.get_checkpoint(child["session_id"], child.get("owner"))
    return str((checkpoint or {}).get("status") or (child.get("status") if child.get("status") not in ("running", "starting") else None) or "interrupted")


def _response(session_manager, session_id):
    session = session_manager.get_session(session_id)
    for message in reversed(getattr(session, "history", []) if session else []):
        if getattr(message, "role", None) == "assistant":
            return str(getattr(message, "content", "") or "")[-MAX_RESULT_CHARS:]
    return ""


async def _start(ctx, args):
    if not subagents_enabled():
        return {"error": "Enable the Subagents module before delegating work.", "exit_code": 1}
    task = args.get("task")
    if not isinstance(task, str) or not task.strip() or len(task) > MAX_TASK_CHARS:
        return {"error": "task must contain 1-8000 characters.", "exit_code": 1}
    model_spec = args.get("model")
    if model_spec is not None and (not isinstance(model_spec, str) or not model_spec.strip() or len(model_spec) > 180):
        return {"error": "model must be an available model name, not an endpoint URL.", "exit_code": 1}
    owner = ctx.get("owner")
    parent_id = str(ctx.get("session_id") or "")
    if get_child(parent_id, owner):
        return {"error": "Subagent chats cannot create nested subagents.", "exit_code": 1}
    manager = get_session_manager()
    parent = manager.get_session(parent_id) if manager and parent_id else None
    if not parent or str(getattr(parent, "owner", None) or "") != str(owner or ""):
        return {"error": "Parent chat is unavailable for this account.", "exit_code": 1}
    security = ctx.get("security_context")
    if security is None:
        return {"error": "Delegation requires an active chat security context.", "exit_code": 1}

    endpoint_url = str(parent.endpoint_url or "")
    model = str(parent.model or "")
    headers = dict(parent.headers or {})
    if model_spec:
        from src.ai_interaction import _resolve_model
        try:
            endpoint_url, model, headers = await asyncio.to_thread(_resolve_model, model_spec.strip(), owner=owner)
        except (ValueError, PermissionError) as error:
            return {"error": f"That model is unavailable to this account: {error}", "exit_code": 1}
        except Exception:
            return {"error": "Could not resolve that model for this account.", "exit_code": 1}
    if not endpoint_url or not model:
        return {"error": "Parent chat has no usable model route.", "exit_code": 1}

    disabled = set(ctx.get("disabled_tools") or ())
    disabled.update({"delegate_subagent", "create_session", "send_to_session", "manage_session", "ask_user"})
    policy = ctx.get("tool_policy")
    approval_mode = str(getattr(security, "approval_mode", "ask") or "ask")
    delegated = bool(getattr(security, "delegated_credential", False))
    untrusted = bool(getattr(security, "external_untrusted_context_seen", False))
    workspace = str(ctx.get("workspace") or "")
    policy_state = {
        "disabled_tools": sorted(getattr(policy, "disabled_tools", ()) or ()),
        "hidden_tools": sorted(getattr(policy, "hidden_tools", ()) or ()),
        "mode": str(getattr(policy, "mode", "normal") or "normal"),
        "block_all_tool_calls": bool(getattr(policy, "block_all_tool_calls", False)),
        "disable_mcp": bool(getattr(policy, "disable_mcp", False)),
    }
    envelope = {
        "disabled_tools": sorted(disabled), "tool_policy": policy_state,
        "approval_mode": approval_mode, "delegated_credential": delegated,
        "external_untrusted_context_seen": untrusted, "workspace": workspace,
    }

    title = _title(args.get("title"), task)
    child_id = uuid.uuid4().hex
    child_name = f"🤖 {title}"[:100]
    try:
        child = manager.create_session(child_id, child_name, endpoint_url, model, rag=False, owner=owner)
        child.headers = dict(headers or {})
        # Session headers and route metadata use the same persisted fields as ordinary chats.
        from core.database import Session as DbSession, SessionLocal
        db = SessionLocal()
        try:
            row = db.query(DbSession).filter(DbSession.id == child_id).first()
            if row:
                row.headers = child.headers
                row.mode = "agent"
                db.commit()
        finally:
            db.close()
        child.add_message(ChatMessage("user", task.strip(), metadata={
            "subagent": {"parent_session_id": parent_id, "security": envelope}
        }))
    except Exception as error:
        try:
            manager.delete_session(child_id)
        except Exception:
            pass
        return {"error": f"Could not create child chat: {type(error).__name__}", "exit_code": 1}

    try:
        from src.agent_loop import TOOL_SECTIONS, _assemble_prompt, stream_agent_loop
        from src.tool_index import ALWAYS_AVAILABLE, get_tool_index
        try:
            index = await asyncio.to_thread(get_tool_index)
            selected = await asyncio.to_thread(index.get_tools_for_query, task.strip(), 8) if index else set(ALWAYS_AVAILABLE)
        except Exception:
            selected = set(ALWAYS_AVAILABLE)
        selected = set(selected or ()) | set(ALWAYS_AVAILABLE)
        selected -= disabled
        system_prompt = "You are a delegated subagent. Complete only the assigned task, follow the inherited tool and approval limits, and report concrete findings. Do not create or message other chats or ask the user questions; report blockers and questions to the parent in your final answer.\n\n"
        system_prompt += _assemble_prompt(selected, disabled)
        messages = [{"role": "system", "content": system_prompt}, {"role": "user", "content": task.strip()}]
        agent = stream_agent_loop(
            endpoint_url, model, messages, headers=headers, session_id=child_id,
            history_session=child, owner=owner, workspace=workspace,
            disabled_tools=disabled, relevant_tools=selected, tool_policy=policy,
            approval_mode=approval_mode, delegated_credential=delegated,
            external_untrusted_context_seen=untrusted,
        )
    except Exception as error:
        try:
            manager.delete_session(child_id)
        except Exception:
            pass
        return {"error": f"Could not prepare child agent: {type(error).__name__}", "exit_code": 1}

    record = {
        "session_id": child_id, "name": child_name, "parent_session_id": parent_id,
        "owner": str(owner or ""), "model": model, "status": "starting",
        "created_at": datetime.now(timezone.utc).isoformat(), "security": envelope,
    }

    async def persist_child_stream():
        output = ""
        events = []
        status = "done"
        waiting_approval = False
        try:
            async for event in agent:
                if event.startswith("event: error"):
                    status = "error"
                if event.startswith("data: ") and not event.startswith("data: [DONE]"):
                    try:
                        data = json.loads(event[6:].split("\n", 1)[0])
                    except (ValueError, TypeError):
                        data = {}
                    if isinstance(data, dict) and (data.get("error") or data.get("type") == "error"):
                        status = "error"
                    if isinstance(data, dict) and data.get("type") == "ask_user" and isinstance(data.get("data"), dict) and data["data"].get("approval_id"):
                        waiting_approval = True
                    if isinstance(data, dict) and isinstance(data.get("delta"), str):
                        output = (output + data["delta"])[-24_000:]
                    if isinstance(data, dict) and data.get("type") == "tool_output":
                        item = {key: data[key] for key in ("tool", "command", "output", "exit_code", "pending", "pending_id", "approval_id", "status", "ask_user") if key in data}
                        if isinstance(item.get("ask_user"), dict) and item["ask_user"].get("approval_id"):
                            waiting_approval = True
                        for key in ("command", "output"):
                            if isinstance(item.get(key), str):
                                item[key] = item[key][-3000:]
                        events.append(item)
                        del events[:-64]
                yield event
                if status == "error":
                    raise RuntimeError("Subagent stream reported an error")
        except asyncio.CancelledError:
            status = "stopped"
            raise
        except Exception:
            status = "error"
            raise
        finally:
            if status == "done" and waiting_approval:
                status = "waiting_approval"
            text = output
            try:
                child.add_message(ChatMessage("assistant", text or ("Subagent stopped." if status == "stopped" else "Subagent finished without a text response."),
                                               metadata={"subagent": {"parent_session_id": parent_id, "status": status}, "tool_events": events, "untrusted_content": True}))
            finally:
                update_status(child_id, status)

    try:
        from src import agent_runs
        register(record)
        agent_runs.start(child_id, persist_child_stream(), owner=owner, context={
            "original_request": task.strip(), "workspace": str(workspace or ""),
            "model": model, "endpoint_url": endpoint_url, "chat_mode": "agent",
        })
        update_status(child_id, "running")
    except Exception as error:
        try:
            if "agent_runs" in locals() and agent_runs.is_active(child_id):
                agent_runs.stop(child_id, agent_runs.get_run_id(child_id))
            else:
                await agent.aclose()
                update_status(child_id, "error")
                manager.delete_session(child_id)
        except Exception:
            pass
        return {"error": str(error)[:200], "exit_code": 1}

    card = {"session_id": child_id, "title": child_name, "icon": "🤖", "status": "running"}
    return {"output": f"Started [{child_name}](#session-{child_id}). The child chat continues independently and can be stopped or checked from this parent chat.",
            "subagent": card, "session_id": child_id, "status": "running", "exit_code": 0}


async def _control(ctx, args):
    action = args.get("action")
    owner = ctx.get("owner")
    parent_id = str(ctx.get("session_id") or "")
    child_id = args.get("session_id")
    if not isinstance(child_id, str) or not re.fullmatch(r"[a-f0-9]{32}", child_id):
        return {"error": "session_id must be an exact child chat id returned by spawn.", "exit_code": 1}
    child = get_child(child_id, owner, parent_id)
    if not child:
        return {"error": "Subagent chat not found for this parent chat.", "exit_code": 1}
    manager = get_session_manager()
    actual_session = manager.get_session(child_id) if manager else None
    if not actual_session or str(getattr(actual_session, "owner", None) or "") != str(owner or ""):
        return {"error": "Subagent chat not found for this parent chat.", "exit_code": 1}
    from src import agent_runs
    run_owner = agent_runs.get_run_owner(child_id)
    if agent_runs.is_active(child_id) and str(run_owner or "") != str(owner or ""):
        return {"error": "Subagent chat not found for this parent chat.", "exit_code": 1}
    status = _status(child)
    if action == "cancel":
        run_id = agent_runs.get_run_id(child_id)
        stopped = bool(run_id and agent_runs.stop(child_id, run_id))
        if stopped or status == "waiting_approval":
            from src.tool_approvals import tool_approval_store
            tool_approval_store.retire_for_session(owner=owner, session_id=child_id)
            update_status(child_id, "stopped")
            status = "stopped"
    elif action == "wait":
        timeout = args.get("timeout_seconds", 15)
        if isinstance(timeout, bool) or not isinstance(timeout, int) or not 1 <= timeout <= MAX_WAIT_SECONDS:
            return {"error": f"timeout_seconds must be from 1 to {MAX_WAIT_SECONDS}.", "exit_code": 1}
        deadline = time.monotonic() + timeout
        while status == "running" and time.monotonic() < deadline:
            await asyncio.sleep(min(0.25, max(0, deadline - time.monotonic())))
            status = _status(child)
    elif action != "status":
        return {"error": "action must be spawn, status, wait, or cancel.", "exit_code": 1}

    card = {"session_id": child_id, "title": child["name"], "icon": "🤖", "status": status}
    result = {"output": f"Subagent {child['name']}: {status}.", "subagent": card, "status": status, "exit_code": 0, "untrusted_content": True}
    if status in _TERMINAL:
        response = _response(manager, child_id)
        if response:
            result["response"] = response
            result["output"] += "\n\n" + response
    return result


async def delegate_subagent(content: str, ctx: dict) -> dict:
    if not subagents_enabled():
        return {"error": "Enable the Subagents module before delegating work.", "exit_code": 1}
    try:
        args = json.loads(content or "{}")
    except (ValueError, TypeError):
        return {"error": "delegate_subagent requires a JSON object.", "exit_code": 1}
    if not isinstance(args, dict):
        return {"error": "delegate_subagent requires a JSON object.", "exit_code": 1}
    action = args.get("action", "spawn")
    if action == "spawn":
        return await _start(ctx, args)
    return await _control(ctx, args)


class DelegateSubagentTool:
    async def execute(self, content: str, ctx: dict) -> dict:
        return await delegate_subagent(content, ctx)
