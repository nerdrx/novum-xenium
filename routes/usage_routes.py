"""Private, read-only analytics over retained chat history, not provider billing."""

import json
import math
import re
from datetime import datetime, timedelta, timezone
from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from sqlalchemy import case, false, func

from core.database import ChatMessage, Session, SessionLocal
from src.auth_helpers import require_user, storage_owner_for_request


def _counts():
    return dict.fromkeys(("messages", "user_messages", "assistant_messages", "sessions",
                          "input_tokens", "output_tokens", "total_tokens", "measured_messages",
                          "estimated_messages", "unknown_metrics_messages", "missing_metrics_messages",
                          "failed_messages"), 0)


def _number(value):
    if isinstance(value, bool):
        return None
    try:
        number = float(value)
        return int(number) if math.isfinite(number) and number >= 0 else None
    except (ValueError, TypeError, OverflowError):
        return None


def _metadata(raw):
    try:
        parsed = json.loads(raw or "{}")
        return parsed if isinstance(parsed, dict) else {}
    except (ValueError, TypeError):
        return {}


def _words(content):
    """Count user text, excluding JSON keys and embedded images in media messages."""
    if not content:
        return 0
    text = content
    if content.lstrip().startswith("["):
        try:
            blocks = json.loads(content)
            if isinstance(blocks, list):
                text = " ".join(b.get("text", "") for b in blocks
                                if isinstance(b, dict) and b.get("type") == "text"
                                and isinstance(b.get("text"), str))
        except ValueError:
            pass
    return len(re.findall(r"\S+", text))


def collect_usage(db, owner, days, *, now=None):
    now = now or datetime.now(timezone.utc)
    today = now.date()
    start = today - timedelta(days=days - 1)
    start_time = datetime.combine(start, datetime.min.time())
    end_time = datetime.combine(today + timedelta(days=1), datetime.min.time())
    totals = _counts()
    daily = {str(start + timedelta(days=i)): {"date": str(start + timedelta(days=i)), **_counts()}
             for i in range(days)}
    models, active_sessions, day_sessions, model_sessions = {}, set(), {}, {}
    words_written = 0
    owned = [Session.owner == owner, ~func.trim(Session.name).in_(("Nobody", "Incognito"))]
    # No owner must never turn into an unfiltered query or disclose legacy NULL rows.
    if owner is None:
        owned.append(false())
    rows = (db.query(ChatMessage.session_id, ChatMessage.timestamp, ChatMessage.role,
                     ChatMessage.meta_data, Session.model,
                     case((ChatMessage.role == "user", ChatMessage.content), else_=None))
            .join(Session, Session.id == ChatMessage.session_id)
            .filter(*owned, ChatMessage.timestamp >= start_time, ChatMessage.timestamp < end_time)
            .yield_per(100))
    for sid, timestamp, role, raw, selected_model, user_content in rows:
        date = str(timestamp.date())
        day = daily[date]
        active_sessions.add(sid)
        day_sessions.setdefault(date, set()).add(sid)
        for target in (totals, day):
            target["messages"] += 1
            if role in ("user", "assistant"):
                target[f"{role}_messages"] += 1
        if role == "user":
            words_written += _words(user_content)
        if role != "assistant":
            continue
        md = _metadata(raw)
        input_tokens, output_tokens = _number(md.get("input_tokens")), _number(md.get("output_tokens"))
        has_metrics = input_tokens is not None or output_tokens is not None
        source = md.get("usage_source")
        coverage_key = ("missing_metrics_messages" if not has_metrics else
                        "measured_messages" if source == "real" else
                        "estimated_messages" if source in ("estimated", "mixed") else "unknown_metrics_messages")
        for target in (totals, day):
            target[coverage_key] += 1
            target["input_tokens"] += input_tokens or 0
            target["output_tokens"] += output_tokens or 0
            target["failed_messages"] += int(md.get("failed") is True)
        # Agent rounds may switch models. Use stored per-route buckets when present;
        # their tokens replace, rather than add to, the message's aggregate tokens.
        buckets = md.get("usage_buckets")
        buckets = [b for b in buckets if isinstance(b, dict)] if isinstance(buckets, list) else []
        if not buckets:
            buckets = [{"model": md.get("model") or selected_model,
                        "input_tokens": input_tokens, "output_tokens": output_tokens}]
        touched_models = set()
        for bucket in buckets:
            model = bucket.get("model") or md.get("model") or selected_model or "Unknown"
            model = str(model)[:200]
            aggregate = models.setdefault(model, {"model": model, **_counts()})
            aggregate["input_tokens"] += _number(bucket.get("input_tokens")) or 0
            aggregate["output_tokens"] += _number(bucket.get("output_tokens")) or 0
            model_sessions.setdefault(model, set()).add(sid)
            if model not in touched_models:
                aggregate["messages"] += 1
                aggregate["assistant_messages"] += 1
                aggregate[coverage_key] += 1
                aggregate["failed_messages"] += int(md.get("failed") is True)
                touched_models.add(model)
    totals["sessions"] = len(active_sessions)
    for date, day in daily.items():
        day["sessions"] = len(day_sessions.get(date, ()))
    for model, aggregate in models.items():
        aggregate["sessions"] = len(model_sessions[model])
    for aggregate in [totals, *daily.values(), *models.values()]:
        aggregate["total_tokens"] = aggregate["input_tokens"] + aggregate["output_tokens"]
    ordered_models = sorted(models.values(), key=lambda m: (-m["assistant_messages"], m["model"]))
    active_dates = {date for date, value in daily.items() if value["user_messages"]}
    cursor = today if str(today) in active_dates else today - timedelta(days=1)
    streak = 0
    while str(cursor) in active_dates:
        streak += 1
        cursor -= timedelta(days=1)
    busiest = max(daily.values(), key=lambda d: d["messages"])
    recent = (db.query(Session.id, Session.name, Session.model,
                       func.max(ChatMessage.timestamp).label("last_message"),
                       func.count(ChatMessage.id).label("message_count"))
              .join(ChatMessage, ChatMessage.session_id == Session.id)
              .filter(*owned, Session.archived.is_(False), ChatMessage.timestamp.is_not(None))
              .group_by(Session.id, Session.name, Session.model)
              .order_by(func.max(ChatMessage.timestamp).desc(), Session.id).limit(6).all())
    return {
        "days": days, "timezone": "UTC", "start_date": str(start), "end_date": str(today),
        "totals": totals, "daily": list(daily.values()), "models": ordered_models,
        "recent_sessions": [{"id": r.id, "name": r.name, "model": r.model,
                             "last_message_at": r.last_message.isoformat() + "Z",
                             "message_count": r.message_count} for r in recent],
        "insights": {"active_days": len(active_dates), "streak_days": streak,
                     "words_written": words_written,
                     "favourite_model": ordered_models[0]["model"] if ordered_models else None,
                     "busiest_day": {"date": busiest["date"], "messages": busiest["messages"]}
                     if busiest["messages"] else None},
        "coverage": {"note": "Retained chat history only, including archived chats. Deleted and incognito chats "
                     "are excluded. Tokens can include estimates; older records may lack metrics or source labels. "
                     "This is not provider billing or your subscription allowance. Streaks are limited to this period."},
        "provider_limits": None,
    }


def setup_usage_routes():
    router = APIRouter()

    @router.get("/api/usage", dependencies=[Depends(require_user)])
    def usage(request: Request, response: Response, days: int = Query(7, ge=7, le=30)):
        if days not in (7, 30):
            raise HTTPException(422, "days must be 7 or 30")
        response.headers["Cache-Control"] = "private, no-store"
        with SessionLocal() as db:
            return collect_usage(db, storage_owner_for_request(request), days)

    return router
