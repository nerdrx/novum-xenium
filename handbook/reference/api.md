# HTTP API reference

This is a task-oriented index of the administrative and service routes an
operator is most likely to inspect. Routes may require a signed-in browser
session, administrator privileges, or a scoped API token. Use the exact access
method that the route documents; do not place session cookies or bearer tokens
in URLs, chat messages, or shell history.

The API has no versioned compatibility guarantee in these route names. Check
the installed build's source before automating against them. The UI is the
recommended path for routine account, endpoint, and backup operations.

## Readiness and version

| Method and path | Meaning | Access and limits |
|---|---|---|
| `GET /api/health` | Liveness response with `status` and timestamp | Does not prove database integrity, provider inference, or model output. |
| `GET /api/ready` | Readiness and integrity result; returns HTTP 200 when ready and 503 otherwise | Protected when app authentication is enabled. Readiness does not test model generation. |
| `GET /api/version` | App version, build, and source commit | Use it to identify the build when reporting an issue. |

## Sign-in and accounts

All routes below use the `/api/auth` prefix. `/setup` creates the first admin
when no account exists; `/signup` works only when an admin enabled signup;
`/login` creates a session cookie; `/logout` revokes it; `/status` reports the
current session; `/policy` returns public auth policy. `/change-password`
requires an authenticated user. The `/2fa/setup`, `/2fa/confirm`,
`/2fa/disable`, and `/2fa/status` routes manage the signed-in user's
two-factor authentication.

Admin account routes are `GET /api/auth/users`, `POST /api/auth/users`,
`PUT /api/auth/users/{username}/password`,
`PUT /api/auth/users/{username}/privileges`,
`PUT /api/auth/users/{username}/rename`,
`PUT /api/auth/users/{username}/admin`, and
`DELETE /api/auth/users`. `PUT /api/auth/open-signup` changes registration
policy. These routes require the administrator session; do not expose them
through a proxy without preserving the app's authentication boundary.
The password-reset route accepts only existing **non-admin** target accounts.
It is not a forgotten-password or admin-recovery endpoint.

`GET /api/auth/settings` returns app settings. Non-admin responses scrub secret
values; `POST /api/auth/settings` and `POST /api/auth/features` are
admin-managed writes. Use **Settings** instead of editing the JSON files while
the application is running. See [Settings keys](configuration.md#settings-key-catalog).

Source: [`routes/auth_routes.py`](https://github.com/nerdrx/novum-xenium/blob/main/routes/auth_routes.py).

## Model endpoint management

The main routes are `GET /api/model-endpoints` to list endpoints,
`POST /api/model-endpoints` to add one,
`POST /api/model-endpoints/test` to test a proposed connection,
`GET /api/model-endpoints/{ep_id}/probe` to probe one endpoint,
`GET /api/model-endpoints/{ep_id}/models` to list its models,
`PATCH /api/model-endpoints/{ep_id}/models` to update model entries,
`GET /api/model-endpoints/{ep_id}/catalog-search` to search supported remote
catalogs, `GET /api/model-endpoints/{ep_id}/dependents` to inspect references,
`PATCH /api/model-endpoints/{ep_id}` to edit endpoint metadata, and
`DELETE /api/model-endpoints/{ep_id}` to remove an endpoint.

`GET /api/model-endpoints/probe-local` checks local discovery. `GET
/api/model-endpoints` and a successful `/models` response establish discovery,
not successful inference. Use the model picker and endpoint-management screen
for ordinary setup. Removing an endpoint can affect settings that refer to
it; inspect dependents first.

Source: [`routes/model_routes.py`](https://github.com/nerdrx/novum-xenium/blob/main/routes/model_routes.py) and [provider walkthrough](../tutorials/provider.md).

## Other feature route families

These route families back the corresponding app screens. Most are owner-scoped
or permission-checked; a route prefix does not imply that a token can access
every operation. Check the source router for each method and required scope.

| Feature | Route family | Source and user guide |
|---|---|---|
| Calendar and CalDAV | `/api/calendar/*` | [`routes/calendar_routes.py`](https://github.com/nerdrx/novum-xenium/blob/main/routes/calendar_routes.py); [Calendar guide](../features-connected-services.md#calendar) |
| Notes and reminders | `/api/notes/*` | [`routes/note/note_routes.py`](https://github.com/nerdrx/novum-xenium/blob/main/routes/note/note_routes.py); [Notes guide](../features-connected-services.md#notes-and-reminders) |
| Mail and accounts | `/api/email/*` | [`routes/email/email_routes.py`](https://github.com/nerdrx/novum-xenium/blob/main/routes/email/email_routes.py); [Email guide](../features-connected-services.md#email) |
| Contacts/CardDAV | `/api/contacts/*` | [`routes/contacts/contacts_routes.py`](https://github.com/nerdrx/novum-xenium/blob/main/routes/contacts/contacts_routes.py) |
| Library documents and versions | `/api/document*`, `/api/documents*` | [`routes/document/document_routes.py`](https://github.com/nerdrx/novum-xenium/blob/main/routes/document/document_routes.py); [Documents and Library](../features-connected-services.md#documents-and-library) |
| Personal documents and retrieval | `/api/personal/*`, `/api/embeddings/*` | [`routes/personal_routes.py`](https://github.com/nerdrx/novum-xenium/blob/main/routes/personal_routes.py), [`routes/embedding_routes.py`](https://github.com/nerdrx/novum-xenium/blob/main/routes/embedding_routes.py); [Documents and Library](../features-connected-services.md#documents-and-library) |
| Memory and skills | `/api/memory/*`, `/api/skills/*` | [`routes/memory/memory_routes.py`](https://github.com/nerdrx/novum-xenium/blob/main/routes/memory/memory_routes.py), [`routes/skills_routes.py`](https://github.com/nerdrx/novum-xenium/blob/main/routes/skills_routes.py); [Memory and skills](../features-connected-services.md#knowledge-memory-and-chat-recall) |
| MCP and modules | `/api/mcp/*`, `/api/modules/*` | [`routes/mcp/mcp_routes.py`](https://github.com/nerdrx/novum-xenium/blob/main/routes/mcp/mcp_routes.py), [`routes/module_routes.py`](https://github.com/nerdrx/novum-xenium/blob/main/routes/module_routes.py); [MCP and modules](../features-connected-services.md#mcp-servers-and-tools) |
| Workspaces and project workflows | `/api/workspace/*`, `/api/project-workflows/*` | [`routes/workspace_routes.py`](https://github.com/nerdrx/novum-xenium/blob/main/routes/workspace_routes.py), [`routes/project_routes.py`](https://github.com/nerdrx/novum-xenium/blob/main/routes/project_routes.py); [Chats and workspaces](../chats-workspaces.md) |
| Image, speech and integrations | `/api/gallery/*`, `/api/stt/*`, `/api/tts/*`, `/api/auth/integrations/*` | [Gallery routes](https://github.com/nerdrx/novum-xenium/tree/main/routes/gallery), [`routes/stt_routes.py`](https://github.com/nerdrx/novum-xenium/blob/main/routes/stt_routes.py), [`routes/tts_routes.py`](https://github.com/nerdrx/novum-xenium/blob/main/routes/tts_routes.py), [`routes/auth_routes.py`](https://github.com/nerdrx/novum-xenium/blob/main/routes/auth_routes.py); [Images and audio](../media.md) |

Use the API only when the UI or an authorized integration requires it. The
route families above are an index, not a substitute for checking the exact
HTTP method, payload, owner rules, authentication, and required token scope for
an operation.

## Scheduled tasks

The task collection uses `/api/tasks`. `GET /api/tasks` lists tasks;
`POST /api/tasks` creates one; `GET /api/tasks/{task_id}` and
`PUT /api/tasks/{task_id}` read and update one; `DELETE /api/tasks/{task_id}`
removes one. Task operation routes include `POST /{task_id}/pause`,
`POST /{task_id}/resume`, `POST /{task_id}/run`, and
`POST /{task_id}/stop`. `GET /api/tasks/runs/recent` and
`GET /api/tasks/{task_id}/runs` return run history. See [Tasks and notifications](../tasks.md)
for the UI and duplicate-safe recovery workflow. Action task creation is
restricted by task type and administrator privilege.

Source: [`routes/task/task_routes.py`](https://github.com/nerdrx/novum-xenium/blob/main/routes/task/task_routes.py).

## API tokens

The admin API Token screen uses `GET /api/tokens` to list token metadata,
`GET /api/tokens/profiles` to inspect allowed profiles/scopes,
`POST /api/tokens` to create, `PATCH /api/tokens/{token_id}` to rename or
change scopes, and `DELETE /api/tokens/{token_id}` to revoke. These routes
require admin access. A newly created raw token is shown once; copy it directly
to the intended private client. Deleting or rotating a token can interrupt
clients using it.

Current profiles are `chat`, `codex_todos`, `codex_documents`, and
`codex_email_drafts`. Available scopes include `chat`, `todos:read`,
`todos:write`, `documents:read`, `documents:write`, `email:read`,
`email:draft`, `email:send`, `calendar:read`, `calendar:write`,
`memory:read`, `memory:write`, `cookbook:read`, and `cookbook:launch`.
Choose the narrowest profile/scopes that match the client. Read/write scopes
are paired where required by the route.

Source: [`routes/api_token_routes.py`](https://github.com/nerdrx/novum-xenium/blob/main/routes/api_token_routes.py).

## Full backup and restore

| Method and path | Operation | Important boundary |
|---|---|---|
| `GET /api/backup/full` | Download a sensitive app-data ZIP | Requires an interactive admin browser session. Excludes model/cache files, logs, and external Docker volumes. |
| `POST /api/backup/preview` | Validate and summarize an uploaded ZIP | Does not modify live data. Requires an admin browser session. |
| `POST /api/backup/restore` | Validate and stage an uploaded ZIP | Changes become active after the app is stopped and started. Confirm target and backup first. |
| `GET /api/export` | Download JSON data export | Admin route; this is not the full application ZIP. |
| `POST /api/import` | Import/merge JSON data | Admin route; read source and impact before use. |

The full ZIP does not include external Compose volumes such as ChromaDB,
SearXNG, or ntfy data. See the [backup guide](../tutorials/backup-update.md)
and [backup scope](configuration.md#data-and-workspace-paths).

Source: [`routes/backup_routes.py`](https://github.com/nerdrx/novum-xenium/blob/main/routes/backup_routes.py) and [`src/full_backup.py`](https://github.com/nerdrx/novum-xenium/blob/main/src/full_backup.py).
