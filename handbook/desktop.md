# Desktop manager

The Tauri desktop application manages an existing Docker Compose checkout and opens the same backend used by browser clients. Chat, files, memory, and tools remain in the backend; the desktop app is a manager and client, not a second data store.

## Install and open

Download a desktop release from [Novum Xenium Releases](https://github.com/nerdrx/novum-xenium/releases) or install through [NX Hub](https://github.com/nerdrx/nx-hub). Point the manager at an existing Compose checkout, then start the backend and open its workspace. The manager does not install Docker, Git, WSL, or a backend checkout for you.

Linux is tested locally. Windows desktop builds run in CI, but Windows runtime behavior still needs direct validation. The Android companion connects to the server; it does not run local models.

## Everyday controls

The manager can check backend health, show logs, review available updates, back up application data, and help recover a failed startup. Closing the manager window may keep the app in the system tray; use its tray controls to reopen or exit.

Desktop notifications are optional and off by default. Enable them in workspace **Settings** while the desktop app is running. The local Linux audio alarm uses the desktop host bridge and a user-session timer; it needs the computer and audio session to remain available. It is not a phone alarm or a wake-from-shutdown service.

## Updates and recovery

Container updates and desktop application updates are separate. Before changing persistent state, the manager stops the selected backend, prepares a backup, and reports the result. Backups contain private application data; store them somewhere you control. Review [Back up before an update](tutorials/backup-update.md) for the recovery sequence.

The manager only operates on recognized Compose files in the selected checkout. If the health check fails, read the manager's recent logs and follow [Startup and loading](troubleshooting/startup.md). Preserve the checkout and data while diagnosing; do not remove volumes as a first response.

## Local text provider (Linux)

The manager can provide a local llama.cpp-based text endpoint on Linux. **Regular** runs plain `llama-server`; **zVram** enables the experimental zVram memory-management path. Existing Ollama models may be discovered and reused from their files; starting this provider does not retroactively wrap or replace Ollama. The desktop can connect the endpoint to chat after the provider reports ready.

The provider starts when you choose **Start provider**. **Stop provider** also turns off launch-on-open and automatic recovery. Re-enable the launch-on-open setting before closing Novum if you want the provider to start with a later desktop session. Model loading and switching take time, and not every discovered model is guaranteed to fit. zVram manages eligible Vulkan allocations; it does not add physical VRAM or reserve all system memory. See [Providers and models](providers.md) and the [zVram integration notes](https://github.com/nerdrx/novum-xenium/blob/main/docs/zvram-provider-handoff.md).

Other desktop controls manage the backend image engine. It can use CPU or supported Vulkan paths, and may offer zVram on Linux x86_64. This image-generation engine is separate from the text model provider. See [Images and audio](media.md) and the [source image runtime guide](https://github.com/nerdrx/novum-xenium/blob/main/docs/local-images.md).

## Platform notes

- Embedded desktop and browser clients use the same workspace and saved data.
- Linux native controls can manage host-local provider processes. A browser-only client does not gain host process control.
- Android requires Android 8 or later and a current Android System WebView. It connects to an existing server and does not run a local model.
- The desktop app uses the system webview. An optional Chromium app window is available on Linux when Chrome or Chromium is installed.

For release-specific details see [docs/desktop.md](https://github.com/nerdrx/novum-xenium/blob/main/docs/desktop.md) and the [Android companion README](https://github.com/nerdrx/novum-xenium/blob/main/android/README.md).
