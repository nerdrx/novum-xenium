"""FCM HTTP v1 outbox. Disabled until an administrator configures credentials."""

import json
import logging
import os
import threading
import uuid
from datetime import datetime, timedelta, timezone
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

logger = logging.getLogger(__name__)
_credentials_lock = threading.Lock()
_credentials_cache = None
_credentials_path = None
_credentials_mtime = None


def server_id():
    """Return a stable opaque install id without exposing its configured host."""
    from core.database import SessionLocal, NotificationServerIdentity
    db = SessionLocal()
    try:
        row = db.query(NotificationServerIdentity).filter(NotificationServerIdentity.id == 1).first()
        if row:
            return row.server_id
        value = uuid.uuid4().hex
        db.add(NotificationServerIdentity(id=1, server_id=value))
        try:
            db.commit()
            return value
        except Exception:
            db.rollback()
            row = db.query(NotificationServerIdentity).filter(NotificationServerIdentity.id == 1).first()
            if row:
                return row.server_id
            raise
    finally:
        db.close()


def _now():
    return datetime.now(timezone.utc).replace(tzinfo=None)


def register_device(owner, token, platform="android", *, opt_in=False, email_enabled=True, task_enabled=True, chat_enabled=True):
    """Register one current token for the authenticated owner; never log token."""
    from core.database import SessionLocal, NotificationDevice, NotificationEmailCursor, NotificationPushDelivery

    token = str(token or "").strip()
    platform = str(platform or "android").lower()
    if not owner or not token or len(token) > 4096 or platform not in {"android", "ios"} or opt_in is not True:
        raise ValueError("Invalid notification device")
    db = SessionLocal()
    try:
        device = db.query(NotificationDevice).filter(NotificationDevice.token == token).first()
        if device:
            if device.owner != str(owner):
                old_owner = device.owner
                new_owner_count = db.query(NotificationDevice.id).filter(
                    NotificationDevice.owner == str(owner),
                ).count()
                if new_owner_count >= 10:
                    raise ValueError("Notification device limit reached")
                if new_owner_count == 0:
                    db.query(NotificationEmailCursor).filter(
                        NotificationEmailCursor.owner == str(owner),
                    ).delete(synchronize_session=False)
                db.query(NotificationPushDelivery).filter(
                    NotificationPushDelivery.device_id == device.id,
                ).delete(synchronize_session=False)
                if not db.query(NotificationDevice.id).filter(
                    NotificationDevice.owner == old_owner,
                    NotificationDevice.id != device.id,
                ).first():
                    db.query(NotificationEmailCursor).filter(
                        NotificationEmailCursor.owner == old_owner,
                    ).delete(synchronize_session=False)
                device.id = uuid.uuid4().hex
            device.owner = str(owner)
            device.platform = platform
            device.email_enabled = bool(email_enabled)
            device.task_enabled = bool(task_enabled)
            device.chat_enabled = bool(chat_enabled)
        else:
            count = db.query(NotificationDevice.id).filter(NotificationDevice.owner == str(owner)).count()
            if count >= 10:
                raise ValueError("Notification device limit reached")
            if count == 0:
                db.query(NotificationEmailCursor).filter(
                    NotificationEmailCursor.owner == str(owner),
                ).delete(synchronize_session=False)
            device = NotificationDevice(
                id=uuid.uuid4().hex, owner=str(owner), token=token, platform=platform,
                email_enabled=bool(email_enabled), task_enabled=bool(task_enabled),
                chat_enabled=bool(chat_enabled),
            )
            db.add(device)
        db.commit()
        return device.id
    finally:
        db.close()


def unregister_device(owner, device_id):
    from core.database import SessionLocal, NotificationDevice, NotificationPushDelivery, NotificationEmailCursor

    db = SessionLocal()
    try:
        device = db.query(NotificationDevice).filter(
            NotificationDevice.id == device_id, NotificationDevice.owner == owner,
        ).first()
        if not device:
            return False
        db.query(NotificationPushDelivery).filter(
            NotificationPushDelivery.device_id == device.id,
        ).delete(synchronize_session=False)
        db.delete(device)
        db.flush()
        if not db.query(NotificationDevice.id).filter(NotificationDevice.owner == owner).first():
            db.query(NotificationEmailCursor).filter(
                NotificationEmailCursor.owner == owner,
            ).delete(synchronize_session=False)
        db.commit()
        return True
    finally:
        db.close()


def push_status():
    path = os.environ.get("NX_FCM_SERVICE_ACCOUNT_FILE", "").strip()
    if not path or not os.path.isfile(path):
        return False, "credentials_missing"
    try:
        with open(path, "r", encoding="utf-8") as credential_file:
            service_account_data = json.load(credential_file)
        if not service_account_data.get("project_id") or not service_account_data.get("private_key"):
            return False, "credentials_invalid"
    except Exception:
        return False, "credentials_invalid"
    try:
        import google.auth.transport.requests  # noqa: F401
        import google.oauth2.service_account  # noqa: F401
    except ImportError:
        return False, "google_auth_missing"
    return True, "ready"


def _get_access_token():
    """Load credentials only from an explicit server-side file path."""
    global _credentials_cache, _credentials_path, _credentials_mtime
    path = os.environ.get("NX_FCM_SERVICE_ACCOUNT_FILE", "").strip()
    if not path or not os.path.isfile(path):
        return None, None
    with _credentials_lock:
        try:
            from google.auth.transport.requests import Request as GoogleRequest
            from google.oauth2 import service_account
        except ImportError:
            logger.warning("FCM disabled: install the optional google-auth package")
            return None, None
        try:
            mtime = os.stat(path).st_mtime_ns
            if _credentials_cache is None or _credentials_path != path or _credentials_mtime != mtime:
                _credentials_cache = service_account.Credentials.from_service_account_file(
                    path, scopes=["https://www.googleapis.com/auth/firebase.messaging"],
                )
                _credentials_path = path
                _credentials_mtime = mtime
            if not _credentials_cache.valid:
                request = GoogleRequest()
                class _BoundedGoogleRequest:
                    def __call__(self, *args, **kwargs):
                        kwargs.setdefault("timeout", 5)
                        return request(*args, **kwargs)
                _credentials_cache.refresh(_BoundedGoogleRequest())
            return _credentials_cache.project_id, _credentials_cache.token
        except Exception:
            logger.warning("FCM credentials could not be loaded or refreshed", exc_info=True)
            return None, None


def _send_fcm(token, event_id, kind, status, project_id, access_token, instance_id):
    payload = json.dumps({
        "message": {
            "token": token,
            "data": {
                "event_id": str(event_id), "kind": str(kind), "server_id": str(instance_id),
                "status": str(status or ""),
            },
            "android": {"priority": "HIGH", "ttl": "86400s"},
            "apns": {"headers": {"apns-collapse-id": f"nx-event-{event_id}"}},
        }
    }).encode()
    request = Request(
        f"https://fcm.googleapis.com/v1/projects/{project_id}/messages:send",
        data=payload,
        headers={"Authorization": f"Bearer {access_token}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urlopen(request, timeout=5) as response:
            return 200 <= response.status < 300, False, str(response.status)
    except HTTPError as exc:
        try:
            data = json.loads(exc.read().decode("utf-8", "replace"))
        except Exception:
            data = {}
        details = ((data.get("error") or {}).get("details") or [])
        unregistered = any(
            detail.get("errorCode") == "UNREGISTERED"
            for detail in details if isinstance(detail, dict)
        )
        return False, unregistered, str(exc.code)
    except (URLError, TimeoutError) as exc:
        return False, False, type(exc).__name__


def process_pending_push(limit=50):
    """Attempt a bounded batch. Delivery rows make retries idempotent per device."""
    project_id, access_token = _get_access_token()
    if not project_id or not access_token:
        return 0
    from core.database import (
        SessionLocal, NotificationFeedItem, NotificationDevice, NotificationPushDelivery,
    )

    now = _now()
    db = SessionLocal()
    try:
        # Recover claims left behind by a process crash.
        db.query(NotificationPushDelivery).filter(
            NotificationPushDelivery.status == "sending",
            NotificationPushDelivery.updated_at < now - timedelta(minutes=10),
        ).update({NotificationPushDelivery.status: "pending", NotificationPushDelivery.retry_at: now}, synchronize_session=False)
        db.commit()
        due = db.query(NotificationPushDelivery.event_id, NotificationPushDelivery.device_id).filter(
            NotificationPushDelivery.status == "pending",
            (NotificationPushDelivery.retry_at.is_(None) | (NotificationPushDelivery.retry_at <= now)),
        ).order_by(NotificationPushDelivery.event_id.asc()).limit(max(1, min(int(limit), 5))).all()
    finally:
        db.close()

    sent = 0
    for event_id, device_id in due:
        db = SessionLocal()
        try:
            due_clause = (
                NotificationPushDelivery.retry_at.is_(None)
                | (NotificationPushDelivery.retry_at <= _now())
            )
            claimed = db.query(NotificationPushDelivery).filter(
                NotificationPushDelivery.event_id == event_id,
                NotificationPushDelivery.device_id == device_id,
                NotificationPushDelivery.status == "pending",
                due_clause,
            ).update({
                NotificationPushDelivery.status: "sending",
                NotificationPushDelivery.attempts: NotificationPushDelivery.attempts + 1,
                NotificationPushDelivery.updated_at: _now(),
            }, synchronize_session=False)
            if claimed != 1:
                continue
            db.commit()
            delivery = db.query(NotificationPushDelivery).filter(
                NotificationPushDelivery.event_id == event_id,
                NotificationPushDelivery.device_id == device_id,
            ).first()
            attempts = delivery.attempts
            device = db.query(NotificationDevice).filter(
                NotificationDevice.id == device_id,
                NotificationDevice.owner == delivery.owner,
            ).first()
            event = db.query(NotificationFeedItem).filter(
                NotificationFeedItem.id == event_id,
                NotificationFeedItem.owner == delivery.owner,
            ).first()
            if not device or not event:
                delivery.status = "cancelled"
                db.commit()
                continue
            preference = {
                "email": device.email_enabled,
                "chat": device.chat_enabled,
            }.get(event.kind, device.task_enabled)
            if not preference:
                delivery.status = "cancelled"
                db.commit()
                continue
            token, kind, status = device.token, event.kind, event.status
            db.commit()
        except Exception:
            db.rollback()
            logger.warning("Could not claim FCM delivery", exc_info=True)
            continue
        finally:
            db.close()

        ok, invalid_token, code = _send_fcm(token, event_id, kind, status, project_id, access_token, server_id())
        db = SessionLocal()
        try:
            delivery = db.query(NotificationPushDelivery).filter(
                NotificationPushDelivery.event_id == event_id,
                NotificationPushDelivery.device_id == device_id,
            ).first()
            if not delivery or delivery.status != "sending":
                continue
            if ok:
                delivery.status = "sent"
                sent += 1
            elif invalid_token:
                delivery.status = "invalid"
                device = db.query(NotificationDevice).filter(
                    NotificationDevice.id == device_id,
                    NotificationDevice.owner == delivery.owner,
                    NotificationDevice.token == token,
                ).first()
                if device:
                    db.delete(device)
            elif attempts >= 5:
                delivery.status = "failed"
            else:
                delivery.status = "pending"
                delivery.retry_at = _now() + timedelta(seconds=min(3600, 30 * (2 ** (attempts - 1))))
            delivery.error_code = None if ok else code[:80]
            delivery.updated_at = _now()
            db.commit()
        except Exception:
            db.rollback()
            logger.warning("Could not record FCM delivery result", exc_info=True)
        finally:
            db.close()
    return sent
