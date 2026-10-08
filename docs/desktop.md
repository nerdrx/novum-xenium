# Novum Xenium desktop

The desktop app manages a local Docker Compose installation and opens the same workspace served to browser users. It uses Tauri 2 and the operating system's webview. The Python backend and existing Odysseus data formats remain compatible.

## First release

This release adopts an existing trusted checkout. It does not install Docker, WSL, Git or a backend automatically. Start with the Docker instructions in the main README, then select that checkout in the desktop manager. No account credentials are copied into the desktop frontend.

For an existing installation on this PC, the checkout is `/run/media/nerdrx/Lex/Odysseus`, Compose project `odysseus-local`, port `7000`. These are installation-specific values, not portable defaults. Select `novum-xenium` for a fresh backend when using its matching Compose project name.

The manager includes only the checkout's `docker-compose.yml` and recognized optional `docker.local.yml` / `docker.host-local.yml` overlays. It operates on the project you save. It does not stop every container on the machine.

## Linux

Install the AppImage through NX Hub, or download it and its SHA-256 sidecar from Releases. NX Hub extracts AppImages, so its install does not require FUSE. Docker with the Compose plugin and Git must be available to the desktop user's PATH.

The current desktop release uses the host WebKitGTK runtime. If launching a portable build manually, install WebKitGTK 4.1 using your distribution's package manager when needed. Linux tray support also needs an AppIndicator library and a desktop tray host, such as KDE Plasma's StatusNotifierWatcher. Without a tray host, windows close normally instead of disappearing into an unavailable tray. See the [Tauri Linux prerequisites](https://v2.tauri.app/start/prerequisites/#linux) for distribution package names.

## Windows

Use the Windows portable ZIP through NX Hub. It contains the executable and license notices. Docker Desktop must use Linux containers, normally with WSL 2. Git and Microsoft Edge WebView2 are required. Windows build checks run in CI; Windows installation, sleep/resume, folder mounts and Docker recovery still need a real Windows acceptance pass before runtime support is claimed.

The Linux-only host Codex image bridge service installer is separate. The Windows desktop binary does not install a systemd service or assume Linux host networking works there.

## Container updates

Update checks fetch the selected checkout's origin and compare commits. Dirty or diverged source trees are not overwritten. An update needs an identified fast-forward target and a backupable Compose configuration.

Before changing persistent state, the manager stops the selected backend, snapshots configured data and saves the old source/image state. It then builds and starts the new backend and waits for local health. A failed startup triggers rollback of source, saved images and data. The result reports whether recovery passed; a failure is not presented as a successful update.

Backups contain private application data. Keep them on storage you control. The app leaves recovery archives available rather than deleting them after an update. Review long-running agent tasks before starting an update; this first release does not automatically schedule updates around active tasks.

App updates and backend updates are separate. NX Hub manages the desktop package; the desktop manager handles the selected backend. When a system tray is available, closing the manager or workspace hides that window. Open it again from the Novum Xenium tray menu; the existing workspace stays loaded. The tray also provides an explicit Quit command. If a backend operation is active, Quit displays a notice and exits after that operation finishes; it does not interrupt the update. Quitting the desktop app leaves Docker services running. Launching the app again restores the existing instance instead of creating duplicate tray icons.

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

`desktop/tests/native_smoke.py` uses Python's standard library and a running `tauri-driver` installation. It writes configuration only to temporary directories, reads status/logs from an existing healthy backend, opens the workbench, and verifies that the workbench cannot invoke native management commands. It does not start, stop or update the backend.

On Linux with Gamescope and WebKitWebDriver installed:

```bash
gamescope --backend headless --expose-wayland -W 1100 -H 760 -- env GDK_BACKEND=wayland \
  python desktop/tests/native_smoke.py \
  --application desktop/src-tauri/target/debug/novum-xenium-desktop \
  --checkout /path/to/checkout --project your-compose-project
```

Pass `--backend-port` for a non-default port and `--driver` if `tauri-driver` is outside PATH. This requires a debug desktop build and does not need a visible window.

Optional `--tray-host none` and `--tray-host fake` modes also test graceful window close under an isolated `dbus-run-session`; they never use the user's session bus or data directories. The fake-host mode checks hide/restore for both windows, same-window workspace reuse, single-instance handoff, tray Quit, and close behavior after the watcher disappears. These modes additionally need `dbus-python`, GLib introspection bindings, `python3-xlib`, and `xdotool` on Linux.

Both desktop windows support Ctrl+/Ctrl− (Command+/Command− on macOS) to zoom the whole page, and Ctrl+0 to reset. Ctrl+mouse wheel also zooms. Zoom stays within 75–200% and is independent for each window.

On Linux, the app disables WebKit's `PreferPageRenderingUpdatesNear60FPS` preference when the host runtime exposes it. This lets the engine target higher refresh rates; actual frame pacing still depends on WebKit, the display server and the compositor. Older runtimes keep their defaults.

The workspace supports Ctrl+R (Command+R on macOS) and F5 to reload its current page. The tray menu also offers Reload workspace. Reloading leaves Docker running but can interrupt a page response; closing to the tray preserves the page instead.

## Workbench window controls

Copy files in your file manager, focus the chat composer and press Ctrl+V (or Shift+Insert) to attach them. Linux uses a native clipboard fallback because WebKitGTK suppresses local file entries. Files remain in the attachment strip until you send. The fallback accepts up to 10 regular local files and 50 MB combined; folders are not attached. Text and screenshot paste keep their usual behavior. Other platforms use the webview's standard clipboard file support.

Linux and Windows manager and workspace windows use the same compact title bar matched to the NX theme. Minimize, maximize/restore and close work through window-only controls; the workspace does not gain backend-management permissions. Double-click the title area to maximize. Right-click it to restore your system title bar if needed. macOS keeps its native frame.

After replacing an installed desktop build, use **Quit** in the tray menu and reopen the app. Closing its window can leave the previous process running in the tray.

## Images, links and downloads

Open image in new window and ordinary external HTTP(S) links open your system browser. The browser has its own login cookies: a private image served by the local backend may require signing in there separately. Embedded `blob:` and `data:` image addresses stay inside the workspace; save those images instead.

Save image as and workspace download buttons use a native Save dialog. Cancel leaves the download unsaved. Linux needs a functioning desktop file-chooser portal (GTK or KDE), with Zenity as the fallback. Copy image writes PNG pixels to the system clipboard; Copy image address writes the URL. Generated images also have a Copy image toolbar button. The desktop image menu replaces WebKit’s stock image menu and keeps these two actions separate, without granting container-management IPC permissions.

Some WebKitGTK versions retain a failed-download flag after cancellation. If a later download produces a file but the engine still reports failure, the app asks you to check the saved file rather than claiming either verified success or definite failure.

On Linux, WebKit blob downloads use a MIME-based suggested name (for example `image.png`) when the browser does not provide a filename. The Save dialog lets you rename it. Blob download cancellation is tracked per download, so cancelling does not mark a later saved blob as failed.

Validation: an isolated Linux KWin/WebKit session verified an actual PNG OS-clipboard roundtrip, exact-byte blob saves, cancellation followed by a successful retry, and HTTP(S) default-browser dispatch. The test used controlled replies from a private file-chooser portal and an opener stub; it verifies native integration without claiming manual dialog interaction, direct native context-menu selection, or Windows runtime coverage.

## Desktop notifications

Settings → Communications → Reminders has a desktop-notifications switch and a test button in the desktop app. It starts off and is saved on this device. Existing background-response, research, task and reminder alerts use system notifications when enabled; in-app notices keep working when it is off. The app must remain running. OS notification settings and Do Not Disturb can suppress alerts.

Notifications use a small native route restricted to the configured local backend, with bounded text and a one-per-second limit. The workbench still has no container-management IPC access. Notification clicks do not currently navigate to the related chat. Linux delivery was checked against a private D-Bus notification service; Windows runtime behavior is not yet verified.
