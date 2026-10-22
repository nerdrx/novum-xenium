# Configuration and operator reference

Novum Xenium has four configuration layers: Docker deployment values in
`.env`, runtime preferences in **Settings**, account and API-token controls in
the admin interface, and the desktop manager's saved checkout configuration.
Use the layer that owns the setting. The deployment example is intentionally
short; it is not a dump of every environment variable read by the code.

## Docker Compose values

Start with [`.env.example`](https://github.com/nerdrx/novum-xenium/blob/main/.env.example).
Copy it to `.env` beside the Compose file, uncomment only the values you need,
and recreate the affected service after changing startup configuration. Keep
`.env`, backups, and credentials private; never commit real keys or passwords.

| Variable | Default / Compose behavior | Purpose and safe-change note |
|---|---|---|
| `APP_BIND`, `APP_PORT` | `127.0.0.1`, `7000` | Host address and port for the web UI; container listens on 7000. Keep loopback unless you intentionally provide protected LAN or proxy access. |
| `AUTH_ENABLED`, `LOCALHOST_BYPASS` | `true`, `false` | Authentication and loopback bypass. Keep authentication enabled and bypass disabled for shared or network-reachable installs. |
| `ODYSSEUS_ADMIN_USER`, `ODYSSEUS_ADMIN_PASSWORD` | `admin`, empty | Optional first-run admin seed. Use a strong private password; changing it later is an account operation, not a Compose edit. |
| `ALLOWED_ORIGINS`, `SECURE_COOKIES` | Localhost origins; cookie follows request scheme | Browser CORS and cookie behavior. Configure exact trusted origins and terminate HTTPS correctly at a proxy before advertising remote access. |
| `APP_DATA_DIR`, `APP_LOGS_DIR` | `./data`, `./logs` | Host bind-mount roots for persistent app data and logs. Move only after stopping services and copying the complete data tree. |
| `DATABASE_URL` | `sqlite:///./data/app.db` | SQLAlchemy database connection. Changing database backend/path needs a compatible migration and a separately verified backup plan. |
| `LLM_HOST`, `LLM_HOSTS` | `localhost`, empty | Local model discovery hosts. In a container, `localhost` is the container; use a reachable host/service name for host-run providers. |
| `OLLAMA_BASE_URL`, `LM_STUDIO_URL`, `RESEARCH_LLM_ENDPOINT` | Empty | Optional provider/service endpoint overrides. Keep endpoints limited to trusted services; use a CA bundle for private TLS roots rather than disabling certificate checks. |
| `OPENAI_API_KEY`, `EMBEDDING_API_KEY`, provider keys | Empty | Secrets for the selected external services. Add only the credentials needed; requests sent to hosted providers leave the machine. |
| `SEARXNG_INSTANCE`, `SEARXNG_GENERAL_ENGINES` | `.env.example`: `http://localhost:8080`, `bing,mwmbl,wiby,wikipedia`; Compose uses `http://searxng:8080` internally | Search backend and default engine list. Compose's service hostname is deliberate; do not replace it with container-local `localhost`. |
| `SEARXNG_SECRET` | Generated on first boot and retained in `searxng-data` when empty | SearXNG cookie/CSRF secret. Preserve the named volume when recreating the service. |
| `CHROMADB_HOST`, `CHROMADB_PORT` | Compose sets `chromadb:8000` | Internal vector-store address. Host-run examples use `localhost:8100`; Compose uses its service network address. |
| `CHROMADB_BIND`, `NTFY_BIND` | `127.0.0.1` | Host-side bind address for the Chroma and ntfy ports. Keep loopback unless you intentionally expose the service and have network controls. |
| `NTFY_BASE_URL` | `http://localhost:8091` | URL the app uses for the bundled ntfy service. Match it to a deliberate reachable host address if changing `NTFY_BIND`. |
| `PUID`, `PGID` | `1000`, `1000` | Linux container user/group IDs for bind-mount ownership. Set to the host user's numeric IDs if files become inaccessible. |
| `CLEANUP_INTERVAL_HOURS` | `24` | Period for routine cleanup jobs. |
| `ODYSSEUS_INPROCESS_POLLERS`, `ODYSSEUS_INPROCESS_TASKS` | `1`, `1` | In-process email pollers and scheduled-task runner. Set to `0` only when an external scheduler/driver is configured; avoid two workers claiming the same schedule. |
| `ODYSSEUS_TOOL_APPROVAL_GATE` | `1` | After external content enters an agent run, gates tools that can execute code, change state, or cause outside effects. Keep enabled. Do not disable it to work around a pending or blocked tool. |
| `ODYSSEUS_WORKSPACE_DEFAULT` | Empty | Optional default workspace visible to the backend. In Compose, `/workspace` maps to the persisted agent workspace. |
| `ODYSSEUS_HOST_WORKSPACE_DIR`, `ODYSSEUS_HOST_WORKSPACE_MOUNT` | Disabled; opt-in overlay | Exposes a host directory to the container for agent file work. This is writable high-trust access; mount only the intended directory and choose a narrow path. |
| `ODYSSEUS_ENABLE_HOST_DOCKER`, `DOCKER_GID` | Disabled; no socket mount | Opt-in host Docker-daemon access using `docker/host-docker.yml`. A Docker socket can control the host; only enable for intentional local management and pair it with the overlay. |
| `COMPOSE_FILE` | Base `docker-compose.yml` | Optional overlays merge left to right. Use one matching GPU overlay; host-workspace, host-network, and Docker-socket overlays are separate capabilities. |
| `ODYSSEUS_HOST_NETWORK_SEARXNG_INSTANCE`, `ODYSSEUS_HOST_NETWORK_CHROMADB_HOST`, `ODYSSEUS_HOST_NETWORK_CHROMADB_PORT` | Unset; host-network overlay only | Addresses for bundled services when the app shares the Linux host network. Port publishing is disabled in host-network mode. |
| `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT_URI` | Empty | Gmail OAuth web-client credentials and optional exact callback URI. Configure the matching callback in Google Cloud; keep the secret private. |
| `OAUTH_REDIRECT_BASE_URL` | Derived as `http://localhost:$APP_PORT` | Public origin used by remote MCP OAuth callbacks. Set the externally reachable HTTPS origin behind a proxy or when the Docker host port differs from 7000. Google MCP uses a loopback callback and should not use a public override. |

The example also lists optional embedding, FastEmbed, upload-limit, script-host,
and provider settings. The [complete environment-variable reference](environment.md)
lists the broader `ODYSSEUS_*` inventory, including internal/development
switches; most operators should leave those at their defaults.

### GPU and network overlays

The base Compose stack is CPU-only. For Linux Docker, the image-generation
Vulkan overlay is `docker/gpu.vulkan.yml`; it passes `/dev/dri` and a render
group. `docker/gpu.amd.yml` is a separate AMD/ROCm device overlay for features
that use that runtime. The NVIDIA overlay requires NVIDIA Container Toolkit.
These overlays expose host devices; they do not install GPU userspace libraries
inside the slim image. Docker Desktop on Windows/macOS does not provide the
documented host Vulkan passthrough path. Use the exact feature guide before
choosing an overlay; GPU support is feature-specific.

## Settings inside the application

The **Settings** interface stores runtime preferences under the app data
directory (`settings.json` and `features.json`). It is separate from `.env`.
The central defaults are defined in `src/settings.py`; the controls are grouped
by the Settings navigation in `static/js/settings/registry.js`.

| Settings group | Exact panel labels | Typical controls |
|---|---|---|
| Models & AI | **Add Models**, **Added Models**, **AI Defaults**, **Search** | Provider endpoints; default/task/utility/vision/image/research routes; fallback chains; search provider, SafeSearch and research limits. |
| Communications | **Integrations**, **Modules**, **Email**, **Reminders** | MCP and external integrations, module repositories, mailbox connections, reminder delivery channels. |
| Experience | **Appearance**, **Shortcuts** | Theme, interface density, appearance preferences and keyboard bindings. |
| Account | **Usage**, **Account** | Usage history, password, and sign-out controls. |
| Administration | **Agent Tools**, **Users**, **System** | Admin-only tool permissions, users, service state and system controls. |

The panel names come from the Settings navigation registry. Individual options
inside a panel can vary with the configured provider, enabled feature, and
account permissions. For the source-defined settings keys and defaults, see
[Settings key catalog](#settings-key-catalog).

Settings saves are handled through the app's admin-gated settings route. Admin
settings changes are shared app configuration; user preferences and provider
credentials may have their own ownership and storage behavior. Do not edit JSON
files while the app is writing them.

### Settings key catalog

These are the keys in the source-defined default settings object. They are
grouped here by purpose; the Settings screen presents user-facing labels.
Keys marked as legacy remain for compatibility and are not active routing
controls.

| Area | Keys |
|---|---|
| Model routing | `default_endpoint_id`, `default_model`, `task_endpoint_id`, `task_model`, `utility_endpoint_id`, `utility_model`, `utility_model_fallbacks`, `utility_reasoning_effort`, `research_endpoint_id`, `research_model`, `research_search_provider`, `teacher_model`, `teacher_enabled`, `teacher_tier2_enabled`, `share_defaults_with_users` |
| Vision and image generation | `vision_enabled`, `vision_model`, `vision_model_fallbacks`, `image_gen_enabled`, `image_model`, `image_quality` |
| Speech | `tts_enabled`, `tts_provider`, `tts_model`, `tts_voice`, `tts_speed`, `stt_enabled`, `stt_provider`, `stt_model`, `stt_language` |
| Search and research | `search_provider`, `search_fallback_chain`, `search_url`, `search_result_count`, `search_safesearch`, `brave_api_key`, `google_pse_key`, `google_pse_cx`, `tavily_api_key`, `serper_api_key`, `research_max_tokens`, `research_extraction_timeout_seconds`, `research_planning_timeout_seconds`, `research_query_timeout_seconds`, `research_extraction_concurrency`, `research_run_timeout_seconds` |
| Agent behavior | `agent_max_tool_calls`, `agent_max_rounds`, `agent_input_token_budget`, `agent_input_token_hard_max`, `agent_stream_timeout_seconds`, `agent_coding_grounding`, `agent_verifier_subagent`, `agent_milestone_workflow`, `auto_compact_threshold_percent`, `agent_email_confirm` |
| Documents and email writing | `document_writing_style`, `email_writing_style` |
| Tools and skills | `tool_path_extra_roots`, `skill_autosave_min_confidence`, `skill_max_injected` |
| Reminders and alerts | `app_public_url`, `reminder_channel`, `reminder_llm_synthesis`, `reminder_llm_persona`, `reminder_ntfy_topic`, `reminder_email_to`, `reminder_webhook_integration_id`, `reminder_webhook_payload_template`, `urgent_email_prompt` |
| Interface and compatibility | `keybinds`, `default_model_fallbacks` (legacy; retained for compatibility, not used for routing) |

The **Shortcuts** panel loads and validates saved key bindings before it enables
editing or Reset. The settings request, including reading its response body, has
a 15-second deadline. If loading fails or returns an invalid settings shape,
the panel shows a reload message and leaves the saved bindings untouched. A
missing or empty legacy `keybinds` map remains usable with the default bindings;
when a valid map is loaded, custom and unrecognized entries are retained when
you save a rebind. Starting another rebind, leaving Shortcuts, or closing
Settings cancels key capture without saving its preview.

A successful save activates its submitted bindings; an older successful reply
does not replace a newer accepted save. A rejected save leaves the pending
choice editable and reports failure instead of claiming success. Restore the
connection or admin access before retrying. After a timeout or disconnect,
reload and check the bindings first: the server may already have saved them.

See the pinned [shortcut settings implementation](https://github.com/nerdrx/novum-xenium/blob/6672098835bcaa507d1e1fde954be7f9f61c4099/static/js/settings.js).

Settings values can be sensitive, especially provider keys, webhook payloads,
email destinations, and tool path roots. Use the app's Settings controls and
admin permissions; do not manually edit `settings.json` during service
operation. The canonical defaults and retired-key boundary are in
[`src/settings.py`](https://github.com/nerdrx/novum-xenium/blob/main/src/settings.py).

## Accounts, admin access, and API tokens

On first run, create the initial administrator in the setup screen or seed it
with the optional Compose admin variables. Signup is controlled by the admin;
accounts can be promoted or managed through the user administration controls.
Use a unique password and enable the available account protections. Disabling
`AUTH_ENABLED` removes the normal login boundary and is suitable only when a
trusted upstream proxy is deliberately providing that boundary.

API tokens are managed in the admin **API Tokens** controls. Source routes are
`GET /api/tokens`, `GET /api/tokens/profiles`, `POST /api/tokens`,
`PATCH /api/tokens/{token_id}`, and `DELETE /api/tokens/{token_id}`. Listing,
creation, modification, and deletion require admin access; a created token is
shown once, so copy it directly into the intended private client and revoke it
if it is exposed. Choose the narrowest available profile/scopes. Do not put
tokens in repository files, chat transcripts, or screenshots.

## Data and workspace paths

| Path / variable | What lives there | Change guidance |
|---|---|---|
| `APP_DATA_DIR` | Compose host-side root mounted at `/app/data` | Default is `./data`. Stop the stack, copy the entire directory, update `.env`, then start and verify before removing any old copy. |
| `ODYSSEUS_DATA_DIR` | Native/direct-run app data root | Defaults to the app's normal data directory. The standard Compose file instead sets the container mount and does not pass this override through. |
| `data/agent_workspace/workspace` → `/workspace` | Persistent agent workspace in the standard Compose setup | User files and project work are stored here. Host-workspace overlays add access to an explicitly mounted host tree. |
| `APP_LOGS_DIR` | Compose host-side application logs mounted at `/app/logs` | Default `./logs`; preserve logs when diagnosing a failed update. |
| `searxng-data`, `chromadb-data`, `ntfy-cache` | Named Compose volumes for bundled services | These are outside the app data bind mount and excluded from the full-backup ZIP. Back them up separately with a volume-aware Docker procedure if their contents matter. The ZIP does not include model caches, logs, or external volumes. |
| `ODYSSEUS_WORKSPACE_HOST_ROOT`, `ODYSSEUS_WORKSPACE_CONTAINER_ROOT` | Host/container path translation for an opted-in workspace mapping | Keep the pair consistent with the actual Compose mount. The container root defaults to `/workspace`. |

`ODYSSEUS_DATA_DIR` contains application data. Treat the whole directory and
any backup as sensitive. The full-backup ZIP contains eligible application
data files and a consistent SQLite snapshot, while excluding runtime caches,
logs, model files and service-owned directories. It does not include
`searxng-data`, `chromadb-data`, or `ntfy-cache`; those Docker volumes remain
where they are during restore. A complete Compose disaster-recovery plan must
back up those named volumes separately when their data matters.

## Back up, update, and recover

### Before routine changes

1. Confirm the backend checkout, Compose project, and data root.
2. Use the manager's full-backup action and verify the resulting archive exists
   in a private destination, or stop Compose and copy the complete configured
   data tree.
3. If relying on bundled search/vector/notification services, back up their
   named volumes as well. Do not remove the original data during backup.

Backups may contain credentials, chats, and documents. The admin-only backup
routes are `GET /api/backup/full` to export, `POST /api/backup/preview` to
validate and summarize an archive without changing live data, and
`POST /api/backup/restore` to stage it. Restore requires stopping and starting
the app to activate staged files. The ZIP excludes caches, model data, logs,
and external Docker volumes. Back up the named Compose volumes separately
with the appropriate Docker volume procedure; do not assume the ZIP includes
them. The archive is sensitive. Safe full-backup support is limited by
platform file APIs; the backend reports when the operation is unavailable.

### Desktop-managed backend update

1. Select the intended saved checkout and Compose project in the desktop
   manager. It adopts a trusted existing checkout; it does not install Docker,
   Git, or the backend for you.
2. Check for updates. The manager fetches `origin`, requires a clean checkout,
   and offers only a fast-forward update. Divergent/local edits require manual
   Git review.
3. Apply the update. The manager requires an already-built old image, snapshots
   configured persistent bind mounts into a private backup directory, keeps a
   rollback image tag, switches source, builds, starts, and checks local health.
4. If the new backend fails its health check, the manager attempts to restore
   the prior source, image, and bind-mount data, then checks the old backend.
   Keep the reported backup path and logs until the new version is confirmed.

The update flow refuses to proceed when Compose data mounts change across the
update. It snapshots configured bind mounts; named external volumes are not
included in that manager snapshot. Back up important named volumes separately.
The manager requires Docker Compose and Git on the desktop user's PATH. Linux
and Windows desktop packages are documented; macOS runtime/update behavior is
not established by the current desktop guide. Replacing the desktop app package
is separate from updating the backend checkout; quit the running desktop app
from its tray menu before reopening a replaced build.

### Manual Compose recovery

For the standard local `./data` setup, stop services cleanly, copy the complete
data directory to a private backup location, and start services again. For a
custom `APP_DATA_DIR`, external database, or named volumes, use the matching
storage-specific backup procedure. Before restoring, stop the backend and
confirm the exact checkout and data destination: restore replaces data and can
discard changes made after the backup. Never restore files over active writers.

## Source pointers

- [`.env.example`](https://github.com/nerdrx/novum-xenium/blob/main/.env.example): deployment examples and safety comments.
- [`docker-compose.yml`](https://github.com/nerdrx/novum-xenium/blob/main/docker-compose.yml), [`docker/gpu.vulkan.yml`](https://github.com/nerdrx/novum-xenium/blob/main/docker/gpu.vulkan.yml), and [`docker/gpu.amd.yml`](https://github.com/nerdrx/novum-xenium/blob/main/docker/gpu.amd.yml): defaults, mounts, ports, and device overlays.
- [`src/settings.py`](https://github.com/nerdrx/novum-xenium/blob/main/src/settings.py), [`static/js/settings/registry.js`](https://github.com/nerdrx/novum-xenium/blob/main/static/js/settings/registry.js), and `routes/auth_routes.py`: runtime defaults and Settings access.
- [`routes/api_token_routes.py`](https://github.com/nerdrx/novum-xenium/blob/main/routes/api_token_routes.py), [`routes/backup_routes.py`](https://github.com/nerdrx/novum-xenium/blob/main/routes/backup_routes.py), [`src/constants.py`](https://github.com/nerdrx/novum-xenium/blob/main/src/constants.py): API routes, data root, and backup behavior.
- [`docs/desktop.md`](https://github.com/nerdrx/novum-xenium/blob/main/docs/desktop.md) and `desktop/src-tauri/src/lib.rs`: manager adoption, update, backup, and rollback behavior.
