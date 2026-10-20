# Handbook coverage and known limits

This handbook aims to let an operator complete documented Novum workflows without needing a chat assistant to explain the next step. Instructions below are grouped by task, and each main feature guide links to the maintained source for exact implementation details. The handbook does not claim that every platform, provider, or model has been exercised live.

## Documented operator workflows

- Install the standard Docker Compose app, sign in, connect a model endpoint, and run a first prompt.
- Use browser, desktop, and Android clients against the same backend; understand which client can manage host processes.
- Add local/hosted model endpoints, manage Cookbook downloads and launches, diagnose an offline provider, select models, understand context limits, and follow Linux AMD/ROCm, Vulkan, and zVram boundaries.
- Save and recover browser composer drafts; use chats, projects, managed worktrees, workspace search/previews, snapshots, Stop, and Continue.
- Choose Chat/Agent/Plan modes, compare chat models and search providers, run and recover Deep Research reports, manage tool approvals, run verified coding work packets, connect MCP servers/modules, and understand containment limits.
- Operate calendar, CalDAV, email, Library/documents, Notes/reminders, memory, skills, local/hosted images, notifications, and the desktop alarm where supported.
- Choose an email mailbox, compose/reply, save mailbox drafts, understand browser-local recovery and sender fallback, and check ambiguous send results before retrying.
- Configure Compose settings, all source-inventoried environment variables, Settings keys, accounts, API tokens, network binds, storage, backups, updates, rollback, and common API routes.

See [Feature and source index](index.md) for the source file behind each guide. Deployment values live in [Configuration and administration](configuration.md), the complete variable list is in the [environment reference](environment.md), and route groups are in the [HTTP API reference](api.md).

## Limits that remain visible

These are the specific areas where the source or validation does not establish a complete universal workflow:

- **Speech settings:** the source identifies a hidden/incomplete speech Settings card; browser speech, local STT/TTS optional dependencies, and remote endpoints have separate limits. The guide does not invent a click path for a hidden card.
- **Remote calendar/email/provider setup:** the code supports named connection paths, but each external vendor controls OAuth credentials, scopes, server URLs, and network requirements. Follow its exact callback and consent requirements; the guide links the relevant setup docs.
- **Desktop platform checks:** Linux is tested locally. Windows packages run in CI, but Windows desktop runtime testing remains outstanding. The desktop guide does not establish macOS install/update behavior.
- **GPU/model compatibility:** Linux AMD/ROCm, NVIDIA, Vulkan, CPU and zVram paths belong to different features. Model loading depends on its engine and available working memory. A configured or listed model is not proof of successful inference or image generation.
- **Android delivery:** alerts use a polling feed and may be delayed by Doze or stopped by force-stop/reboot. They are not guaranteed real-time; the companion does not run a local model.
- **Backup scope:** full application backup preserves app files/databases, but external Docker named volumes are separate. Back up vector/search/notification service volumes separately when their contents matter. Safe full application backup is documented for Linux Docker; other platforms may not support it.
- **Service effects:** Stop cannot undo completed email, calendar, API, shell, or other external effects. Check status before retrying to avoid duplicates.

## Keep this handbook accurate

When source behavior changes, update the task page, exact UI labels, source links, limits, and recovery steps together. Keep undocumented controls labeled with the precise missing evidence. Commands should remain narrow and read-only until an operation's effect and data impact are described. Do not promote a test on one platform/model into a universal support claim.
