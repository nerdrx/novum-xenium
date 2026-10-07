# Optional Codex subscription image bridge

This extra runs on the Docker host with an already installed, logged-in Codex CLI. The normal Docker installation does not need it. Python 3 and the standard library are sufficient for the bridge.

The CLI must support `codex exec --json` and the native `image_generation` feature. Availability depends on your CLI version and account. The bridge uses the existing login, clears API-key environment variables for its worker, and does not copy credentials into Odysseus. Provider usage limits and image rules still apply.

## Start on the host

From the trusted fork checkout, on Linux with a systemd user session:

```bash
python3 scripts/install_codex_image_bridge.py
systemctl --user daemon-reload
systemctl --user enable --now odysseus-codex-images
```

The installer creates a private token at `data/credentials/codex-image-bridge.token`, preserves any existing token, and installs a user service. Review the token locally; never commit or share it. On a host without systemd, run the installer to create the token, then start `python3 scripts/codex_image_bridge.py` directly.

The installer remembers the Codex executable found on your terminal's PATH. To override it, or if none was found, create `~/.config/odysseus/codex-images.env` containing `CODEX_CLI=/absolute/path/to/codex`. For a nonstandard native image cache, set `CODEX_IMAGE_ROOT=/absolute/path/to/generated_images` there too. Restart the bridge after changing these settings.

The server binds only `127.0.0.1:8111`, checks its bearer token, and produces at most one new PNG per request. It reads only the native image cache belonging to that CLI run. Failed or image-less runs remain failures; it does not claim an earlier Gallery image is a new result.

## Connect from Docker

A bridge bound to host loopback is intentionally unreachable from a normal Docker bridge network. On Linux, use the opt-in image overlay:

```bash
docker compose -f docker-compose.yml -f docker/codex-images.yml up -d --build
```

This overlay gives only the Odysseus service host networking so it can reach the loopback bridge. It explicitly binds the app to localhost and uses the bundled services' existing loopback ports. It does not mount the Codex home or Docker socket. It is Linux-only; the default Docker flow is unchanged.

In Odysseus Settings, add an image provider with:

- Base URL: `http://127.0.0.1:8111/v1`
- API key: the local bridge token
- Model: `chatgpt-image-codex`

Open **Settings → AI → Image Generation**. The **Model** picker lists `chatgpt-image-codex` together with its configured provider name; select it and enable image generation. The backend description identifies the Codex subscription bridge. Enabled image-only providers and recognized image models on mixed providers appear here; ordinary ChatGPT text models do not become image backends automatically. Provider names disambiguate duplicate model IDs. Saved models that are unavailable remain visible instead of being silently cleared by a quality/toggle change. Reopening the AI panel refreshes provider choices.

**Auto-detect** uses the configured endpoint credentials to discover image models, including the authenticated bridge. This does not install a bridge or transfer Codex credentials into Odysseus. Model discovery can fail while the service is offline; a saved model is configuration, not a live connection check.

Quality and size are visual guidance for the Codex bridge, not guaranteed rendering controls or per-image prices. Generated images are stored by Odysseus in its persistent Gallery. The bridge generates new images only.

## Stop or inspect

```bash
journalctl --user -u odysseus-codex-images --no-pager -n 30
systemctl --user disable --now odysseus-codex-images
```
