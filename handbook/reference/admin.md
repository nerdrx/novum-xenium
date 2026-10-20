# Runtime overview

Use this page for everyday service checks. For every deployment variable,
Settings key, account route, and backup boundary, see
[Configuration and administration](configuration.md).

## Check service state

From the selected repository checkout, run these read-only checks:

```sh
docker compose ps
docker compose logs --tail=150 odysseus
```

`ps` shows whether Compose services are running. The log command shows recent
application output. Check the first relevant error and compare it with the
service state before changing configuration. Logs may contain secrets or
private request data; redact them before sharing.

The Compose app normally binds to `127.0.0.1:7000`. Authentication is enabled
and localhost bypass is disabled by default. A protected health route or a
running container confirms app readiness only; it does not prove that a model
provider, GPU path, scheduled action, or generated result works.

## Start, stop, and restart

Use `docker compose stop` to stop services while keeping their containers and
data. Use `docker compose start` to resume them. Use `docker compose up -d`
after changing a runtime override or after a clean stop. Use
`docker compose up -d --build` only when you intend to rebuild the app image.
Check `docker compose ps` afterward.

Do not use `docker compose down -v` as a troubleshooting shortcut. Removing
volumes can destroy persistent service data. Do not delete the app database
to clear a startup error.

## Data and backups

Default app data lives in `./data`; logs live in `./logs`; the persistent agent
workspace is `./data/agent_workspace/workspace`, mounted as `/workspace` in the
app container. The full-backup ZIP covers eligible app data but excludes
caches, logs, model files, and external Compose volumes. Back up named service
volumes separately when their contents matter. See [Back up before an update](../tutorials/backup-update.md)
and the [backup inventory](configuration.md#data-and-workspace-paths).

## Feature-specific status

Model endpoint discovery, inference, image generation, speech, remote tools,
and Android alerts have different dependencies and permissions. Diagnose each
from its feature page instead of treating general app health as proof:

- [Providers and models](../providers.md)
- [Images and audio](../media.md)
- [Connected services](../features-connected-services.md)
- [Tools, modes, and approvals](../tools-safety.md)
- [Startup troubleshooting](../troubleshooting/startup.md)

## Update boundaries

The desktop manager updates a selected backend checkout; replacing the
desktop application package is separate. Backend updates require a clean
checkout and fast-forward path. The manager snapshots configured bind mounts,
but does not snapshot external named Docker volumes. Read the update procedure
and verify its backup destination before applying an update. Windows runtime
and macOS update behavior are not established by the current desktop guide.
