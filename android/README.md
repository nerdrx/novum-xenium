# Novum Xenium for Android

An Android companion for your existing Novum Xenium server. The workspace stays on your server; this app provides a WebView, uploads, file downloads, and an embedded Tailscale connection.

## Connect

1. Install the signed APK from the repository release or NX Hub. Android 8 or newer and an up-to-date Android System WebView are required.
2. Enter your server address, including the port, such as `http://192.168.1.20:7000` or `https://novum.example.ts.net`.
3. Choose **Sign in to Tailscale** and authorize this app's device in your browser. Approve the device in your tailnet if your policy requires it.
4. Sign in to Novum in the workspace.

The connection header hides when the server page appears. On app restart it stays visible for at least two seconds, then hides once connected. Connection errors restore the controls. To change the server while connected, use Android Back at the first workspace page to open Connection settings.

For a LAN address, your router must advertise the relevant subnet route, that route must be approved in Tailscale, and your tailnet policy must permit this device to reach the server. The embedded node accepts subnet routes. The server must listen on a reachable LAN address rather than only `127.0.0.1`.

Tailscale runs inside this app. It does not create an Android VPN service or redirect other apps. The WebView uses a loopback proxy restricted to your configured server's host and port. There is no direct-network fallback when Tailscale is unavailable. External HTTPS links open in your normal browser. Third-party embedded resources are not routed through this proxy.

Connection identity is stored in Android's private app storage, excluded from backups. Closing or reconnecting preserves the identity; clearing app storage removes the local identity. You can also revoke the device in your Tailscale admin console. This app is not a Novum backend or a local model runtime.

## Share and connection recovery

Choose Novum Xenium from Android’s Share menu to stage text, links, or up to ten files (50 MiB total per share). Sign in and open a chat, then tap **Add to chat**. Existing draft text is preserved; sharing never sends the message automatically. Discard dismisses pending shared content.

Use **Check connection** to inspect network availability, Tailscale state, and server reachability through the app’s private proxy. **Retry** reconnects using your saved address and identity. Checks never fall back to a direct LAN connection.

## Build

Use the isolated toolchain to avoid installing Android development tools on your host:

```sh
docker build -t novum-android-build -f android/tools/Dockerfile android/tools
docker run --rm --cpus=4 --memory=8g -e GOMAXPROCS=4 -v "$PWD:/workspace" novum-android-build bash -c './bridge/build.sh && ./gradlew --no-daemon :app:testDebugUnitTest :app:lintDebug :app:assembleRelease'
```

The Go bridge pins Tailscale and its module checksums. The toolchain checks downloaded archives, and the Gradle wrapper checks its distribution checksum. Build output is unsigned until `tools/sign-apk.sh` runs with a dedicated release keystore. Keep that keystore backed up: future updates must use the same signing key.

## Notifications

When enabled, Android checks the authenticated Novum notification feed from a foreground service about once per minute while Android permits network access; deep Doze can defer checks until a maintenance window. Its `specialUse` service type describes this explicitly user-enabled, persistent self-hosted workspace connection and does not bypass Android power restrictions. The persistent Android notification describes the connection; event notifications use generic text and open through the authenticated workspace. The first feed request establishes a cursor without replaying older events. Android notification permission is required. Force-stopping the app, rebooting the device, or the OS stopping its process can stop polling until the app is reopened and the connection is enabled again. No Firebase project or Google messaging configuration is required. See [the notification architecture](../docs/push-notifications.md) for server and device behavior.

The Android workflow tests and builds pull requests without release credentials. Tag builds use `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, and `ANDROID_KEY_PASSWORD` repository secrets, verify the signed APK, and publish it with a SHA-256 sidecar. No signing key belongs in this repository.

## Current limits

- File uploads use Android's document picker. Downloads support direct files from the configured server; browser-generated `blob:` downloads require an original server-file link.
- The connection is active while the app process is alive; Android may stop background processes. Reopening reconnects using the saved identity.
- A successful build or emulator startup does not establish connectivity to your particular router. Real subnet routing depends on your tailnet's routes and access policy.

## Sources and licenses

- [Tailscale tsnet](https://pkg.go.dev/tailscale.com/tsnet)
- [AndroidX WebKit ProxyController](https://developer.android.com/reference/androidx/webkit/ProxyController)
- [Tailscale subnet routers](https://tailscale.com/kb/1019/subnets)

Novum Xenium is AGPL-3.0-or-later. Embedded third-party components retain their own licenses; generated dependency notices are bundled with the app.
