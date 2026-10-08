# Novum Xenium desktop

The desktop app manages a local Docker Compose installation and opens the same workspace served to browser users. It uses Tauri 2 and the operating system's webview. The Python backend and existing Odysseus data formats remain compatible.

## First release

This release adopts an existing trusted checkout. It does not install Docker, WSL, Git or a backend automatically. Start with the Docker instructions in the main README, then select that checkout in the desktop manager. No account credentials are copied into the desktop frontend.

For an existing installation on this PC, the checkout is `/run/media/nerdrx/Lex/Odysseus`, Compose project `odysseus-local`, port `7000`. These are installation-specific values, not portable defaults. Select `novum-xenium` for a fresh backend when using its matching Compose project name.

The manager includes only the checkout's `docker-compose.yml` and recognized optional `docker.local.yml` / `docker.host-local.yml` overlays. It operates on the project you save. It does not stop every container on the machine.

## Linux

Install the AppImage through NX Hub, or download it and its SHA-256 sidecar from Releases. NX Hub extracts AppImages, so its install does not require FUSE. Docker with the Compose plugin and Git must be available to the desktop user's PATH.

The current desktop release uses the host WebKitGTK runtime. If launching a portable build manually, install WebKitGTK 4.1 using your distribution's package manager when needed.

## Windows

Use the Windows portable ZIP through NX Hub. It contains the executable and license notices. Docker Desktop must use Linux containers, normally with WSL 2. Git and Microsoft Edge WebView2 are required. Windows build checks run in CI; Windows installation, sleep/resume, folder mounts and Docker recovery still need a real Windows acceptance pass before runtime support is claimed.

The Linux-only host Codex image bridge service installer is separate. The Windows desktop binary does not install a systemd service or assume Linux host networking works there.

## Container updates

Update checks fetch the selected checkout's origin and compare commits. Dirty or diverged source trees are not overwritten. An update needs an identified fast-forward target and a backupable Compose configuration.

Before changing persistent state, the manager stops the selected backend, snapshots configured data and saves the old source/image state. It then builds and starts the new backend and waits for local health. A failed startup triggers rollback of source, saved images and data. The result reports whether recovery passed; a failure is not presented as a successful update.

Backups contain private application data. Keep them on storage you control. The app leaves recovery archives available rather than deleting them after an update. Review long-running agent tasks before starting an update; this first release does not automatically schedule updates around active tasks.

App updates and backend updates are separate. NX Hub manages the desktop package; the desktop manager handles the selected backend. Closing the desktop window does not delete persistent data or automatically stop Docker services.

## Native boundary

Only the bundled manager window can invoke container-management commands. The workbench window loads a loopback HTTP URL and has no native management permissions. The desktop application does not expose a shell-execution API to model responses or remote pages.

The selected checkout is trusted local code: Docker Compose can build images and mount files according to its configuration. Select your own installation, not an unreviewed repository supplied by a chat message.

## Development

```bash
cd desktop
npm ci
npm run dev
npm test
cd src-tauri
cargo test --locked
```

See the official Tauri prerequisites for Linux system packages and the Windows C++ toolchain. `npm run build -- --bundles appimage` builds the Linux package. `npm run build -- --no-bundle` produces the Windows executable for the release ZIP on a Windows runner.

## Native smoke check

`desktop/tests/native_smoke.py` uses Python's standard library and a running `tauri-driver` installation. It writes configuration only to a temporary directory, reads status/logs from an existing healthy backend, opens the workbench, and verifies that the workbench cannot invoke native management commands. It does not start, stop or update the backend.

On Linux with Gamescope and WebKitWebDriver installed:

```bash
gamescope --backend headless --expose-wayland -W 1100 -H 760 -- env GDK_BACKEND=wayland \
  python desktop/tests/native_smoke.py \
  --application desktop/src-tauri/target/debug/novum-xenium-desktop \
  --checkout /path/to/checkout --project your-compose-project
```

Pass `--backend-port` for a non-default port and `--driver` if `tauri-driver` is outside PATH. This requires a debug desktop build and does not need a visible window.
