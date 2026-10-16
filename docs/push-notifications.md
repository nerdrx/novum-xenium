# Android push notifications

The backend sends FCM HTTP v1 messages only after an authenticated client opts
in and registers its device. The payload contains a generic notification and an
opaque feed event ID and per-install `server_id`; clients resolve details through the authenticated
`GET /api/tasks/notification-feed/{event_id}` endpoint. Email subjects, senders,
message bodies, and routes are never sent through FCM.

To enable delivery, configure Firebase Cloud Messaging for the Android app and
place a service-account JSON file on the server. Install the optional
`google-auth` dependency and set `NX_FCM_SERVICE_ACCOUNT_FILE` to the mounted
server-side file path. Keep that file out of the repository, client builds,
logs, and backups exposed to clients. `GET /api/tasks/notification-status`
reports dependency, credential, and in-process worker readiness;
it never returns the path or credential data. Registration and status both
return the stable opaque `server_id`, which clients should scope to the canonical
server origin and validate on notification taps.

The app must request OS notification permission before registering with
`POST /api/tasks/notification-devices` using `{token, platform, opt_in: true}`.
It may set `email_enabled`, `task_enabled`, and `chat_enabled` per device. Limit is ten devices
per owner. Re-registering the same FCM token under another authenticated owner
transfers it and revokes its former owner association. On logout, call
`DELETE /api/tasks/notification-devices/{device_id}` before clearing the
session. Feed cursors remain local to each device.

Background email discovery runs every two minutes while in-process pollers are
enabled. It checks at most five opted-in owners' enabled mail accounts per
tick, reads at most 50 new message headers per account, and never fetches
email bodies or invokes a model. The first scan records a UIDNEXT baseline
without notifying for existing mail; UIDVALIDITY changes establish a fresh
baseline. Task, email, and chat events use generic push
text. Delivery retries are bounded to five
attempts per event and device; only FCM's explicit `UNREGISTERED` response
removes a device token.
