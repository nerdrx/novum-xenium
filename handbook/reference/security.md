# Trust and data boundaries

Novum Xenium combines a self-hosted application with optional hosted model providers and external integrations. Understand each boundary before connecting accounts or enabling tools.

## Inference and external services

Self-hosting the app does not make hosted inference local. The selected provider receives the request data Novum sends, which may include prompt text, attached content, and context. Email, calendar, MCP, and other integrations can read or change data in their connected accounts according to their own scopes.

## Container and workspace

The standard Docker setup keeps application data in a persistent data directory and serves workspace files through the container. Tool permissions are bounded by the configured workspace and available mounts. Full access does not add host mounts or bypass disabled tools. The shell is not equivalent to an operating-system sandbox.

When the optional executor is enabled, Bash and Python commands run in a separate constrained container that mounts only the standard workspace and does not receive app credentials or a Docker socket. Network access remains available. Browser and native file tools continue to use their own app-side paths.

The Docker native-command containment setup requires real private filesystem and PID namespaces. Do not solve a failure by enabling privileged mode or generally unconfined seccomp. See [containment details](https://github.com/nerdrx/novum-xenium/blob/main/docs/native-containment-docker.md).

## Network exposure

Keep authentication enabled and localhost bypass disabled for network-accessible installations. Ports bind to localhost by default in the documented setup. If you deliberately expose the service, configure HTTPS, authentication, firewalling, and any reverse proxy correctly. Secure model-provider endpoints as well; a host server bound to all interfaces may be reachable by other devices.

## Backups and logs

Backups contain private application data and may contain credentials. Logs can reveal endpoint names, errors, paths, or user content. Store both privately and redact before sharing. Do not send complete databases or backups in a bug report.

## Stop, restore, and external effects

Stop cancels owned and tracked processes but cannot undo completed external actions. Workspace snapshots cover only included workspace files and have documented size/count limits. They do not roll back external services, detached processes, or shell effects outside the workspace. Restoring a snapshot can overwrite files; stop concurrent writers and inspect the diff.

## Source and license

Novum Xenium is an independent fork of Odysseus under AGPL-3.0-or-later, with original credits preserved. See the repository's [license and acknowledgments](https://github.com/nerdrx/novum-xenium#where-it-came-from).
