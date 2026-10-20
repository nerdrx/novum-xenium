# Feature and source index

This index points from user questions to the maintained source documents. The handbook describes common tasks; the linked repository files carry exact implementation and release details.

| Topic | User guide | Source of truth |
| --- | --- | --- |
| Docker setup and product overview | [Getting started](../getting-started.md) | [README](https://github.com/nerdrx/novum-xenium#readme), `.env.example` |
| Desktop manager and Linux provider | [Desktop](../desktop.md) | [`docs/desktop.md`](https://github.com/nerdrx/novum-xenium/blob/main/docs/desktop.md) |
| Local model downloads and launches | [Cookbook and local models](../cookbook.md) | [`static/js/cookbook.js`](https://github.com/nerdrx/novum-xenium/blob/main/static/js/cookbook.js), [`static/js/cookbookServe.js`](https://github.com/nerdrx/novum-xenium/blob/main/static/js/cookbookServe.js) |
| Deep Research reports and background delivery | [Deep Research](../research.md) | [`static/js/research/`](https://github.com/nerdrx/novum-xenium/tree/main/static/js/research), [`routes/research/`](https://github.com/nerdrx/novum-xenium/tree/main/routes/research) |
| Model comparisons | [Compare models](../compare.md) | [`static/js/compare/`](https://github.com/nerdrx/novum-xenium/tree/main/static/js/compare) |
| Chats and project coding | [Chats and workspaces](../chats-workspaces.md) | [`docs/coding-work-packets.md`](https://github.com/nerdrx/novum-xenium/blob/main/docs/coding-work-packets.md), [`docs/nx-workflows.md`](https://github.com/nerdrx/novum-xenium/blob/main/docs/nx-workflows.md) |
| Email drafts, account selection and send recovery | [Email drafts and recovery](../email.md) | [`static/js/document.js`](https://github.com/nerdrx/novum-xenium/blob/main/static/js/document.js), [`specs/email-contacts.md`](https://github.com/nerdrx/novum-xenium/blob/main/specs/email-contacts.md) |
| Calendar, email, Library, Notes, memory, MCP and modules | [Connected services](../features-connected-services.md) | [`specs/`](https://github.com/nerdrx/novum-xenium/tree/main/specs), [`docs/modules.md`](https://github.com/nerdrx/novum-xenium/blob/main/docs/modules.md) |
| Tool containment | [Tools and approvals](../tools-safety.md) | [`docs/native-containment-docker.md`](https://github.com/nerdrx/novum-xenium/blob/main/docs/native-containment-docker.md), [`docs/AGENT_TURN_CONTRACT.md`](https://github.com/nerdrx/novum-xenium/blob/main/docs/AGENT_TURN_CONTRACT.md) |
| Skills and modules | [Documents and memory](../knowledge.md) | [`docs/skills-lifecycle.md`](https://github.com/nerdrx/novum-xenium/blob/main/docs/skills-lifecycle.md), [`docs/modules.md`](https://github.com/nerdrx/novum-xenium/blob/main/docs/modules.md) |
| Android notifications | [Tasks and notifications](../tasks.md) | [`docs/push-notifications.md`](https://github.com/nerdrx/novum-xenium/blob/main/docs/push-notifications.md), [Android README](https://github.com/nerdrx/novum-xenium/blob/main/android/README.md) |
| Local image models and GPU | [Images and audio](../media.md) | [`docs/local-images.md`](https://github.com/nerdrx/novum-xenium/blob/main/docs/local-images.md) |
| zVram-backed local text models | [Providers and models](../providers.md) | [`docs/zvram-provider-handoff.md`](https://github.com/nerdrx/novum-xenium/blob/main/docs/zvram-provider-handoff.md) |
| Deployment variables and Settings keys | [Configuration and administration](configuration.md) | [`.env.example`](https://github.com/nerdrx/novum-xenium/blob/main/.env.example), [`src/settings.py`](https://github.com/nerdrx/novum-xenium/blob/main/src/settings.py) |
| Complete environment variable inventory | [Environment-variable reference](environment.md) | [`scripts/generate_env_reference.py`](https://github.com/nerdrx/novum-xenium/blob/main/scripts/generate_env_reference.py), [`tests/test_env_reference.py`](https://github.com/nerdrx/novum-xenium/blob/main/tests/test_env_reference.py) |
| Accounts, endpoints, tasks, API tokens, backups | [HTTP API reference](api.md) | [`routes/auth_routes.py`](https://github.com/nerdrx/novum-xenium/blob/main/routes/auth_routes.py), [`routes/model_routes.py`](https://github.com/nerdrx/novum-xenium/blob/main/routes/model_routes.py), [`routes/task/task_routes.py`](https://github.com/nerdrx/novum-xenium/blob/main/routes/task/task_routes.py), [`routes/api_token_routes.py`](https://github.com/nerdrx/novum-xenium/blob/main/routes/api_token_routes.py), [`routes/backup_routes.py`](https://github.com/nerdrx/novum-xenium/blob/main/routes/backup_routes.py) |
| Image bridge | [Images and audio](../media.md) | [`docs/codex-image-bridge.md`](https://github.com/nerdrx/novum-xenium/blob/main/docs/codex-image-bridge.md) |

The source documents include engineering context and may contain internal detail. Use the user pages for operation steps and consult source when exact version boundaries matter.
