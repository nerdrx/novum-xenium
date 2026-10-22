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

## Dependency audit findings

The Python dependency audit is advisory: a passing workflow can still contain a failed `pip-audit` job. Read that job's findings before calling security checks clear. The separate pull-request dependency-review job is currently restricted to the upstream repository and is skipped in this fork. See the [workflow conditions](https://github.com/nerdrx/novum-xenium/blob/main/.github/workflows/dependency-review.yml).

The dependency set reviewed on 2026-10-22 uses Pillow 12.3.0 and FastEmbed
0.9.0. The Pillow advisories below are fixed in 13.0.0, while FastEmbed 0.9.0
requires `pillow<13`. This is an unresolved dependency conflict, not a clean
security result. Vulnerability databases can differ while records synchronize;
read the raw findings from the exact build, rather than treating this inventory
as a count of its audit output. The reviewed advisory inventory is:

- [CVE-2026-112895](https://github.com/python-pillow/Pillow/security/advisories/GHSA-p4wg-p73j-c528)
- [CVE-2026-112400](https://github.com/python-pillow/Pillow/security/advisories/GHSA-65qm-jvmh-6pqg)
- [CVE-2026-112397](https://github.com/python-pillow/Pillow/security/advisories/GHSA-58r4-6rv3-gfh8)
- [CVE-2026-112896](https://github.com/python-pillow/Pillow/security/advisories/GHSA-pchr-8j38-3x4p)
- [CVE-2026-112897](https://github.com/python-pillow/Pillow/security/advisories/GHSA-q45j-58j2-45rg)
- [CVE-2026-112395](https://github.com/python-pillow/Pillow/security/advisories/GHSA-462x-pgg6-55fp)
- [CVE-2026-112404](https://github.com/python-pillow/Pillow/security/advisories/GHSA-c6hw-5grf-ff96)
- [CVE-2026-112899](https://github.com/python-pillow/Pillow/security/advisories/GHSA-vx6w-vv9f-6gvg)
- [CVE-2026-112402](https://github.com/python-pillow/Pillow/security/advisories/GHSA-7mwm-ghpf-9vrm)
- [CVE-2026-112900](https://github.com/python-pillow/Pillow/security/advisories/GHSA-w889-685w-c8fh)
- [CVE-2026-112893](https://github.com/python-pillow/Pillow/security/advisories/GHSA-j4m9-6w36-pw47)
- [CVE-2026-112390](https://github.com/python-pillow/Pillow/security/advisories/GHSA-22hg-r758-rrw9)
- [CVE-2026-112392](https://github.com/python-pillow/Pillow/security/advisories/GHSA-27h8-gf7j-v5hc)
- [CVE-2026-112405](https://github.com/python-pillow/Pillow/security/advisories/GHSA-cp9v-662q-vvx9)
- [CVE-2026-112891](https://github.com/python-pillow/Pillow/security/advisories/GHSA-fc9g-5qg7-mf45)
- [CVE-2026-112391](https://github.com/python-pillow/Pillow/security/advisories/GHSA-254f-3936-288h)
- [CVE-2026-112401](https://github.com/python-pillow/Pillow/security/advisories/GHSA-74r2-7ff9-mjj2)
- [CVE-2026-112901](https://github.com/python-pillow/Pillow/security/advisories/GHSA-xgh8-jp6q-p5x8)

- [CVE-2026-112393](https://github.com/python-pillow/Pillow/security/advisories/GHSA-332p-7hrc-92wf)
- [CVE-2026-112394](https://github.com/python-pillow/Pillow/security/advisories/GHSA-4558-3h8r-v8xp)
- [CVE-2026-112396](https://github.com/python-pillow/Pillow/security/advisories/GHSA-4rr5-89j8-mwwm)
- [CVE-2026-112399](https://github.com/python-pillow/Pillow/security/advisories/GHSA-5xm2-6676-qcp9)
- [CVE-2026-112403](https://github.com/python-pillow/Pillow/security/advisories/GHSA-8g5g-8vmr-9782)
- [CVE-2026-112406](https://github.com/python-pillow/Pillow/security/advisories/GHSA-f2g6-542v-9j58)
- [CVE-2026-112892](https://github.com/python-pillow/Pillow/security/advisories/GHSA-gg2r-wvfm-q9rx)
- [CVE-2026-112894](https://github.com/python-pillow/Pillow/security/advisories/GHSA-jg86-v3jv-hrpm)
- [CVE-2026-112898](https://github.com/python-pillow/Pillow/security/advisories/GHSA-rfgq-q3w2-pmv2)
- [CVE-2026-112902](https://github.com/python-pillow/Pillow/security/advisories/GHSA-xvh5-g6gv-559v)

Check [FastEmbed's released metadata](https://pypi.org/pypi/fastembed/0.9.0/json)
and [Pillow's security release notes](https://pillow.readthedocs.io/en/stable/releasenotes/13.0.0.html)
for updates.

Novum excludes the XBM decoder from
gallery inputs, chat image metadata and thumbnails, media inspection, image-edit
sources, and inline tool-result image packing. This narrows the input path for the
[XBM header-parser denial of service advisory](https://github.com/python-pillow/Pillow/security/advisories/GHSA-xgh8-jp6q-p5x8).
It does not patch Pillow; existing TIFF decoding and its reported risks remain.
See the pinned [decoder helper](https://github.com/nerdrx/novum-xenium/blob/90c8198c4b46ea43faa12b2eb76f5366faf85bc8/src/safe_image_open.py)
and [gallery validation](https://github.com/nerdrx/novum-xenium/blob/b178357088ec920083e040291abf5a76cab76b1a/routes/gallery/gallery_routes.py).

The shared opener also excludes the standalone IPTC decoder, including explicit
requests for that format. This narrows the request-image decode path associated
with [CVE-2026-112405](https://github.com/python-pillow/Pillow/security/advisories/GHSA-cp9v-662q-vvx9).
It does not remove IPTC metadata from JPEG files or patch general `Image.merge`
behavior. The helper also excludes the legacy MSP decoder from default and
explicit format lists for [CVE-2026-112892](https://github.com/python-pillow/Pillow/security/advisories/GHSA-gg2r-wvfm-q9rx).
MSP input through that helper is no longer supported; normal PNG, JPEG, GIF,
WebP, BMP, TIFF, and ICO behavior is retained. Direct Pillow calls outside the
helper remain outside this guard. These are scoped application guards; the
dependency findings remain unresolved.

GIF support remains enabled. The shared opener does not mitigate
[CVE-2026-112401](https://github.com/python-pillow/Pillow/security/advisories/GHSA-74r2-7ff9-mjj2):
GIF comment parsing during `Image.open()` can consume excessive CPU before pixel
checks run. The existing upload caps still admit files large enough to trigger
this issue. Avoid untrusted GIF inputs until a compatible fixed dependency is
available; the XBM, IPTC, and MSP guards do not make general image decoding safe.

Animated PNG inputs also retain the
[CVE-2026-112399 allocation risk](https://github.com/python-pillow/Pillow/security/advisories/GHSA-5xm2-6676-qcp9):
the decoder can allocate its declared canvas before the dimension bomb check
runs. APNG can use an ordinary `.png` filename. Avoid untrusted GIF and animated
PNG inputs while this dependency conflict remains unresolved; byte and pixel
caps do not establish safe decoding.

The reviewed EPS change cwd-prefixes relative filesystem paths passed to the
helper, preventing relative `-` or `@` names from being parsed as Ghostscript
arguments in maintained path-based callsites. This is not filesystem
containment, a sandbox, or a Pillow patch. Caller-supplied file-like objects
with attacker-controlled `.name` values remain outside this guard, as do direct
Pillow calls outside the reviewed helper callsites. It does not resolve the
full EPS advisory or the other Pillow audit items.

Do not force that upgrade with `--no-deps`, suppress the findings, or remove core embeddings to make an installation appear successful. When a compatible FastEmbed release is available, use normal dependency resolution in a clean build, inspect the installed versions, rerun the audit, and verify image handling and embedding integration before replacing a working installation. Preserve backups and record any remaining findings.

## Backups and logs

Backups contain private application data and may contain credentials. Logs can reveal endpoint names, errors, paths, or user content. Store both privately and redact before sharing. Do not send complete databases or backups in a bug report.

## Stop, restore, and external effects

Stop cancels owned and tracked processes but cannot undo completed external actions. Workspace snapshots cover only included workspace files and have documented size/count limits. They do not roll back external services, detached processes, or shell effects outside the workspace. Restoring a snapshot can overwrite files; stop concurrent writers and inspect the diff.

## Source and license

Novum Xenium is an independent fork of Odysseus under AGPL-3.0-or-later, with original credits preserved. See the repository's [license and acknowledgments](https://github.com/nerdrx/novum-xenium#where-it-came-from).
