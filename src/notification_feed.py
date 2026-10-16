"""Small durable notification feed with per-client, non-destructive cursors."""

import logging
import threading
import time
import uuid
from datetime import timezone

from sqlalchemy.exc import IntegrityError

logger = logging.getLogger(__name__)

# Open desktop/browser clients renew this small lease; closed clients do not
# keep an inbox polling forever. Mobile subscriptions are persisted separately.
_email_watchers = {}
_email_watchers_lock = threading.Lock()


def watch_email_notifications(owner, enabled):
    if not owner:
        return
    with _email_watchers_lock:
        now = time.monotonic()
        for key in list(_email_watchers):
            if _email_watchers[key] <= now:
                del _email_watchers[key]
        if enabled and (owner in _email_watchers or len(_email_watchers) < 1000):
            _email_watchers[owner] = now + 300


def active_email_watchers():
    with _email_watchers_lock:
        now = time.monotonic()
        return [owner for owner, expiry in _email_watchers.items() if expiry > now]


def server_id():
    """Return a stable opaque installation ID for binding notification taps."""
    from core.database import SessionLocal, NotificationServerIdentity

    db = SessionLocal()
    try:
        row = db.query(NotificationServerIdentity).filter(
            NotificationServerIdentity.id == 1
        ).first()
        if row:
            return row.server_id
        value = uuid.uuid4().hex
        db.add(NotificationServerIdentity(id=1, server_id=value))
        try:
            db.commit()
            return value
        except Exception:
            db.rollback()
            row = db.query(NotificationServerIdentity).filter(
                NotificationServerIdentity.id == 1
            ).first()
            if row:
                return row.server_id
            raise
    finally:
        db.close()



def add_notification(owner, kind, title, *, source, source_id, body=None, route=None, status=None):
    """Insert once per source event. Empty owners are intentionally ignored."""
    if not owner:
        return None
    from core.database import SessionLocal, NotificationFeedItem

    db = SessionLocal()
    try:
        item = NotificationFeedItem(
            owner=str(owner), kind=str(kind), status=(str(status)[:24] if status else None), title=str(title)[:200],
            body=(str(body)[:500] if body else None), route=(str(route)[:300] if route else None),
            source=str(source), source_id=str(source_id),
        )
        db.add(item)
        try:
            db.flush()
            cutoff = db.query(NotificationFeedItem.id).filter(
                NotificationFeedItem.owner == owner
            ).order_by(NotificationFeedItem.id.desc()).offset(5000).limit(1).first()
            if cutoff:
                db.query(NotificationPushDelivery).filter(
                    NotificationPushDelivery.owner == owner,
                    NotificationPushDelivery.event_id <= cutoff[0],
                ).delete(synchronize_session=False)
                db.query(NotificationFeedItem).filter(
                    NotificationFeedItem.owner == owner,
                    NotificationFeedItem.id <= cutoff[0],
                ).delete(synchronize_session=False)
            db.commit()
            db.refresh(item)
            return item.id
        except IntegrityError:
            db.rollback()
            existing = db.query(NotificationFeedItem.id).filter(
                NotificationFeedItem.owner == str(owner),
                NotificationFeedItem.source == str(source),
                NotificationFeedItem.source_id == str(source_id),
            ).first()
            return int(existing[0]) if existing else None
    except Exception:
        db.rollback()
        logger.warning("Notification feed insert failed", exc_info=True)
        return None
    finally:
        db.close()


def read_notification_page(owner, after=None, limit=50):
    """Return a bounded page and next cursor without acknowledging anything."""
    from core.database import SessionLocal, NotificationFeedItem

    db = SessionLocal()
    try:
        latest = db.query(NotificationFeedItem.id).filter(
            NotificationFeedItem.owner == owner
        ).order_by(NotificationFeedItem.id.desc()).first()
        latest_id = int(latest[0]) if latest else 0
        if after is None:
            return [], latest_id
        query = db.query(NotificationFeedItem).filter(
            NotificationFeedItem.owner == owner,
            NotificationFeedItem.id > int(after),
        ).order_by(NotificationFeedItem.id.asc()).limit(max(1, min(int(limit), 100)))
        items = query.all()
        records = [{
            "id": item.id,
            "kind": item.kind,
            "status": item.status,
            "title": item.title,
            "body": item.body,
            "route": item.route,
            "created_at": item.created_at.replace(tzinfo=timezone.utc).isoformat().replace("+00:00", "Z"),
        } for item in items]
        return records, (items[-1].id if items else int(after))
    finally:
        db.close()


def get_notification(owner, event_id):
    """Resolve one feed event only for its owner, for notification tap handling."""
    from core.database import SessionLocal, NotificationFeedItem

    db = SessionLocal()
    try:
        item = db.query(NotificationFeedItem).filter(
            NotificationFeedItem.owner == owner,
            NotificationFeedItem.id == int(event_id),
        ).first()
        if not item:
            return None
        return {
            "id": item.id, "kind": item.kind, "status": item.status, "title": item.title,
            "body": item.body, "route": item.route,
            "created_at": item.created_at.replace(tzinfo=timezone.utc).isoformat().replace("+00:00", "Z"),
        }
    finally:
        db.close()
