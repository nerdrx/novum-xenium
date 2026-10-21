# Connected services and workspace features

This guide covers the user-facing calendar, email, documents, notes, memory,
skills, MCP, modules, media, Android and notification features in Novum Xenium.
The app connects to your existing backend and stores workspace data there.
Provider credentials and permissions remain separate: signing in to chat does
not configure an email account, CalDAV server, image provider, or MCP server.

Use the [repository README](https://github.com/nerdrx/novum-xenium#readme) for
product setup and the linked source pages below for current implementation detail. If a control is described as a gap,
the source does not establish a reliable end-user path for it; don't infer a
label from the internal API.

## Remove an integration

In **Settings → Integrations**, choose the card's remove button and confirm.
A refused or failed request shows an error and keeps the open form and draft.
Check server access and permissions before retrying. If the connection was
lost, reopen Integrations to check whether removal completed before trying
again. A successful removal refreshes the list without closing a different
integration form opened while the request was pending.

## Calendar

Use Calendar for local events, CalDAV sync, and ICS exchange. Open **Calendar**
from the navigation rail, then use **Calendar settings → Settings →
Integrations** to configure a CalDAV account. Events support date and time,
all-day status, recurrence, location, description, and a Notes-based reminder.
Calendar reminders are separate todo notes; browser notification delivery is
not guaranteed.

For event creation, views, search, account testing, sync recovery, ICS limits,
and backup boundaries, see [Use Calendar](calendar.md). The
[Calendar, Tasks, and Notes specification](https://github.com/nerdrx/novum-xenium/blob/a135f61b25fda702f2fa26b7ae83d1dcba39a714/specs/calendar-tasks-notes.md)
documents backend behavior and remaining limits.

## Email

For composing, mailbox drafts, sender choice and recovery after an unclear send result, see [Email drafts and recovery](email.md).

1. Open **Email** from the navigation rail or `/email`.
2. If no mailbox is listed, an administrator must add an account in **Settings
   → Integrations**. Configure the account's IMAP/SMTP details or complete its
   provider OAuth flow, then select the account in Email. Account setup and
   access are separate from the chat model provider.
3. Open a message to read it or use the message actions to reply, move, or
   archive. Compose a new message from the compose control. Review recipients,
   account and body before sending. Drafts can be saved for review.
4. Attachments can be opened or imported into the document library. Email
   unsubscribe scanning only identifies candidates; review the candidate
   before choosing an unsubscribe or cleanup action.

Email access is owner-scoped. The library supports unread state, flagged
messages, attachment ZIPs (up to 250 messages per request, assembled in
memory), translation, and reviewed unsubscribe flows. An email send may fail
after a draft is saved, so check the compose/recovery draft before retrying.
See [`specs/email-contacts.md`](https://github.com/nerdrx/novum-xenium/blob/main/specs/email-contacts.md) for account
configuration, OAuth, limits, recovery behavior and the exact HTTP/MCP
boundaries. The source identifies **Settings → Integrations** for account
management; detailed screenshots/labels for every mailbox provider flow are
not maintained, so follow the provider's displayed setup instructions.

## Documents and Library

1. Select **Library** in the left navigation. The Library has **Chats**,
   **Documents**, **Research** and **Archive** tabs. To open the editor, select
   a document row. The editor supports rich-text and Markdown source/preview.
2. To make a document, start a chat and request a document, or use the editor's
   create control. State the intended title, output format and authoritative
   source. Review the saved document and version before relying on it.
3. For a file, attach it to the chat or use the workspace's native save/open
   controls. PDF text extraction uses pypdf; PDF page rendering, form detection
   and filling require optional PyMuPDF. Office and EPUB extraction uses
   optional MarkItDown, with a DOCX text fallback.
4. Use the document's archive/delete actions from the Library. Archived items
   appear in **Archive**. Current content and immutable versions belong to the
   document; check the current version before approving an AI change.

Uploads are owner-checked, and persistent document references are validated
before saving. The app does not expose a general upload list/delete endpoint.
If preview, form or extraction controls are missing, the relevant optional
runtime may not be installed. Consult
[`specs/documents-rag-uploads.md`](https://github.com/nerdrx/novum-xenium/blob/main/specs/documents-rag-uploads.md) for
formats, optional dependencies, ownership and recovery limits. The app does
not promise visual correctness merely because a document was generated.

## Notes and reminders

1. Open **Notes** from the left navigation. Use the new-note control to add a
   note or todo; checklist items, labels, pinning and archive are available in
   the note editor/card actions.
2. To set a reminder, choose the reminder control and select **Later today**,
   **Tomorrow**, **Next week**, or **Select date and time**. These are the
   exact choices in the current picker. Review the due date and time before
   saving.
3. Use the Notes filters to find labels, goals, due-today or overdue items.
   Open **Archive** to find archived notes. Deleting requires confirmation;
   undo is available for supported archive actions.
4. A visible browser session can show a local notification. Reminder delivery
   can also use configured email, ntfy, or webhook channels; those channels
   must be configured separately by the operator. Browser permission does not
   configure external delivery.

Notes and calendar reminders share the reminder-note system. Reminders retry
only within 90 seconds of the due time; a recent successful delivery through
the same channel suppresses repeats for 25 minutes. If a reminder is late,
check the due time/timezone and configured delivery channel, then reopen Notes
to refresh. See [`specs/calendar-tasks-notes.md`](https://github.com/nerdrx/novum-xenium/blob/main/specs/calendar-tasks-notes.md)
and the current picker implementation
[`frontend/src/features/notes/ui/reminderPicker.js`](https://github.com/nerdrx/novum-xenium/blob/main/frontend/src/features/notes/ui/reminderPicker.js).

## Knowledge, memory and chat recall

1. Open **Brain** from the left navigation. Its memory tabs include **Memory**
   and **Skills**. The Memory view lets you inspect persistent facts and their
   state; use the visible add/edit/archive controls to manage them.
2. For a fact to persist beyond a chat, explicitly ask to save it to Memory,
   then inspect the saved entry. A fact mentioned in a conversation is not
   automatically guaranteed to become durable memory.
3. Use past-chat recall when you need a previous message. Open the matching
   message/source link to verify exact wording and timestamp; search snippets
   may omit context.
4. For document or vector retrieval, the personal docs/RAG surfaces are
   separately managed and privilege-gated. Ask an administrator to configure
   indexing if the relevant source is absent.

Memory is stored in the backend's `data/memory.json`; it is owner-aware and
retrieved text remains untrusted input. If Memory appears empty, check the
selected user/workspace and reload the Brain view. Do not treat a recalled
snippet as a permission grant or current instruction. See
[`specs/memory-skills.md`](https://github.com/nerdrx/novum-xenium/blob/main/specs/memory-skills.md) and
[`specs/documents-rag-uploads.md`](https://github.com/nerdrx/novum-xenium/blob/main/specs/documents-rag-uploads.md).

## Skills

1. Open **Brain → Skills** (or **Skills** in the navigation rail; route
   `/skills`). The skills view separates **All**, **Built-in**, **Approved**
   and **Draft**.
2. Open a skill and inspect its procedure and requested capabilities before
   using it. Approved status records the publication/audit state; it does not
   guarantee suitability for every task.
3. User-owned skills can be edited or deleted from the skills view. Built-in
   design skills are installed when skills are enabled; existing copies are
   preserved, and deleted defaults are not reinstalled automatically.
4. Ask the agent to use a skill for a matching task. Procedures load on demand;
   a skill's presence does not enable a disabled tool or grant external access.

If a skill is missing, check its current state/filter and whether skills are
enabled. Writes to the skill library remain behind the research/approval gate
where applicable. Read the lifecycle details in
[`docs/skills-lifecycle.md`](https://github.com/nerdrx/novum-xenium/blob/main/docs/skills-lifecycle.md) and the implementation
scope in [`specs/memory-skills.md`](https://github.com/nerdrx/novum-xenium/blob/main/specs/memory-skills.md).

## MCP servers and tools

MCP server configuration is an administrator task:

1. Open **Settings → Integrations → MCP** (the administration source labels
   the MCP server section there). Choose the add-server control and supply the
   transport configuration. Stdio servers require a command and arguments;
   HTTP servers use a server URL and may require OAuth.
2. Save the server, then use **Connect MCP server** or the server's connect
   control. Saving a module that references an MCP server does not connect it.
3. Check the server's status and discovered tools. Disable individual tools
   when they should not appear in agent prompts. A disconnected/`needs_auth`
   server must be reconnected or authorized before its tools can run.
4. In a chat, choose **Agent** mode for tool use. MCP tools are restricted to
   admin users. After external or untrusted context, high-impact actions can
   require approval. Review the exact tool and result before continuing.

Configured server environment JSON is stored in the database; treat it as
secret-bearing configuration. A server can time out after 20 seconds during
startup while other servers continue. If it fails, inspect its status/logs,
correct its transport/auth configuration, then reconnect once. The browser MCP
is optional and skipped at startup if its cached package is absent. See
[`specs/shell-mcp.md`](https://github.com/nerdrx/novum-xenium/blob/main/specs/shell-mcp.md) for transports, OAuth, trust
limits and disabled-tool behavior. Exact transport field labels vary by server
type; the current source does not define one universal wizard.

## Modules

1. Open **Settings → Modules**.
2. Paste a **public GitHub repository URL** and choose **Add repo**. Private
   GitHub repositories and custom Git hosts are not supported.
3. Review the catalog and permission list shown beside each module. Tick a
   module to download and enable it. Installed panels appear first; search or
   the status filter can narrow the list.
4. Use **Refresh** to check the catalog. **Update** downloads a new version
   and leaves it disabled for review. Untick to disable. Forgetting the repo
   does not remove installed modules.

Module installation does not connect MCP servers. Modules run their panel in
an isolated frame and request only declared host permissions; MCP connections
are managed separately in Integrations. ZIP packages are limited to 10 MiB,
20 MiB expanded, 100 entries, and panel HTML to 1 MiB. Removed/replaced module
packages remain on disk; automatic cleanup is not implemented. Full rules and
recovery are in [`docs/modules.md`](https://github.com/nerdrx/novum-xenium/blob/main/docs/modules.md).

## Images and audio

### Images

1. For local generation, download a supported model in **Cookbook** and wait
   for the completed download to appear in **Local images**.
2. Select **Settings → AI → Image Generation** and choose the model/provider.
   Submit a small request first; generated results can be opened from the
   Gallery.
3. If using the desktop manager, its **Image engine** controls Auto, CPU,
   Vulkan or zVram, automatic startup, model refresh and idle unloading.
   Model weights are separate downloads; first use loads the selected model.

The documented Vulkan path is Linux x86_64 with host drivers, Docker `/dev/dri`
access and the `docker/gpu.vulkan.yml` override. Windows/macOS Docker GPU
passthrough is not covered; CPU is the fallback. zVram paging can be slow and
does not guarantee a fit. Hosted image providers and the optional Codex image
bridge have separate setup from chat. See
[`docs/local-images.md`](https://github.com/nerdrx/novum-xenium/blob/main/docs/local-images.md),
[`docs/codex-image-bridge.md`](https://github.com/nerdrx/novum-xenium/blob/main/docs/codex-image-bridge.md), and
[Images and audio](media.md).

### Audio

Speech provider settings are not a single reliable user workflow in this
build: the backend supports browser/local/endpoint paths, but the Settings
speech card is hidden and the STT settings initializer exits when its controls
are absent. Browser speech recognition requires a secure context and microphone
permission; local STT requires optional `faster-whisper`; local Kokoro TTS
requires optional packages and a CUDA-capable PyTorch build. Configured speech
endpoints send audio/text to the configured endpoint. See
[`specs/speech.md`](https://github.com/nerdrx/novum-xenium/blob/main/specs/speech.md) for exact provider limits and the
visible-settings gap.

Linux desktop audio alarms are different from chat speech: ask for an explicit
future time, for example “play an alarm today at 15:00”. Playback defaults to
100% software volume for up to five minutes, then restores the previous volume
and mute state. Ask to stop the alarm to cancel it. The computer and user audio
session must remain available; it cannot wake a powered-off computer and is
not an Android alarm. Source details: [README, desktop section](https://github.com/nerdrx/novum-xenium#the-desktop-app).

## Android companion and alerts

1. Install the Android APK from [Releases](https://github.com/nerdrx/novum-xenium/releases)
   or NX Hub. Android 8 or newer and a current Android System WebView are
   required.
2. Enter your server address in the app, sign in to its Tailscale connection,
   then sign in to Novum. A router with an approved subnet route can instead
   provide access to a LAN server. The phone uses the existing backend; it does
   not run a local model.
3. To enable background alerts, enable **Notifications** in the companion and
   grant Android notification permission. The app shows a persistent
   connection notification and polls the authenticated server feed about once
   per minute when Android permits network access.
4. If alerts stop, reopen the app and re-enable the connection. Check network,
   server sign-in and Android notification permission. Doze can defer polling;
   force-stop, reboot or OS process termination can stop it until reopened.

Alerts cover incoming email, scheduled tasks and chat completion/attention.
They use the self-hosted authenticated feed, no Firebase/FCM service. First
enable establishes a cursor rather than replaying old events; details remain
on the server and event notifications carry generic text. This is not a
guaranteed real-time channel. See [Android README](https://github.com/nerdrx/novum-xenium/blob/main/android/README.md)
and [push notification notes](https://github.com/nerdrx/novum-xenium/blob/main/docs/push-notifications.md).

## Source index

- Product setup and feature overview: [repository README](https://github.com/nerdrx/novum-xenium#readme)
- Calendar, task and reminder behavior: [`specs/calendar-tasks-notes.md`](https://github.com/nerdrx/novum-xenium/blob/main/specs/calendar-tasks-notes.md)
- Email and account scope: [`specs/email-contacts.md`](https://github.com/nerdrx/novum-xenium/blob/main/specs/email-contacts.md)
- Documents, uploads and RAG: [`specs/documents-rag-uploads.md`](https://github.com/nerdrx/novum-xenium/blob/main/specs/documents-rag-uploads.md)
- Memory and skills: [`specs/memory-skills.md`](https://github.com/nerdrx/novum-xenium/blob/main/specs/memory-skills.md)
- MCP: [`specs/shell-mcp.md`](https://github.com/nerdrx/novum-xenium/blob/main/specs/shell-mcp.md)
- Modules: [`docs/modules.md`](https://github.com/nerdrx/novum-xenium/blob/main/docs/modules.md)
- Speech: [`specs/speech.md`](https://github.com/nerdrx/novum-xenium/blob/main/specs/speech.md)
- Android notifications: [`docs/push-notifications.md`](https://github.com/nerdrx/novum-xenium/blob/main/docs/push-notifications.md)
