# Native tool containment in Docker

The October 16 Odysseus base requires a real private filesystem and PID
namespace for native Bash/Python commands. An installed bubblewrap binary
alone does not establish that boundary.

The Novum image installs bubblewrap. The bundled Compose files retain a
seccomp allow-list derived from Moby profiles commit
`6fe7deb1b9fb7c0397a4593480d7d22b9ee8caef` and add only `clone`, `unshare`,
`mount`, `umount2` and `pivot_root`. They do not add host capabilities,
SYS_ADMIN, a Docker socket, or privileged mode. `no-new-privileges` stays on.
The application drops to its configured PUID/PGID before serving requests.

`systempaths=unconfined` is necessary for the nested private `/proc` mount:
Docker's masked proc submounts otherwise make the kernel reject it. This
changes the outer container boundary; it is paired with the unprivileged
application and the per-command private filesystem/PID namespace. The profile
still denies other syscalls by default. Explicitly disabled tools remain
disabled; this configuration is not request authorization.

The runtime probes actual namespace creation and fails closed if unavailable.
Hosts with additional AppArmor/SELinux or user-namespace restrictions may need
a host-admin policy adjustment. Do not work around failures with privileged
mode or a generally unconfined seccomp profile. Linux Docker validation is
recorded in the integration evidence; other hosts require their own probe.

Source: <https://github.com/moby/profiles/blob/6fe7deb1b9fb7c0397a4593480d7d22b9ee8caef/seccomp/default.json>.
The Moby profile is licensed under Apache-2.0; see the adjacent attribution.
