# Android notifications

Android notifications use the Novum server's authenticated notification feed. The app does not use Firebase, FCM, or a third-party push provider.

When the user opts in, Android runs a foreground service and shows a persistent notification that the background connection is active. While Android permits network access, the service polls `GET /api/tasks/notification-feed?after=<cursor>&limit=50&email=true` about once per minute. This is an approximate cadence: deep Doze can defer network access until a maintenance window. The service uses Android's `specialUse` foreground-service type for this explicitly user-enabled, persistent connection to the self-hosted workspace; that declaration does not bypass Android background or power restrictions. The first request establishes the current cursor without replaying older events. The cursor is stored on-device for the configured server; the server scopes feed results to the authenticated owner.

Task, email, and chat event details stay on the server. Native event notifications use generic text and carry only an opaque event ID. Tapping one opens `#notification-<id>` in the workspace, which resolves the event through the authenticated owner-scoped detail endpoint before routing to the task, chat, or email.

Email discovery is bounded and server-side. The Android poller's `email=true` query refreshes a short-lived watcher while enabled; the server checks configured mail accounts in the background and advances each account's UID cursor without fetching message bodies or invoking a model. Feed reads do not download email contents.

Android notification permission is required. Deep Doze may delay polling until Android permits network access. Force-stopping the app, rebooting the device, or the OS stopping its process can stop polling until the app is reopened and the connection is enabled again. Connectivity and server availability also determine whether new events can be discovered; older events are not replayed when notifications are first enabled.
