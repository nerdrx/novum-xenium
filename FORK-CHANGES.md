# NX Odysseus fork changes

Modified by nerdrx on October 6, 2026. Upstream: [odysseus-dev/odysseus](https://github.com/odysseus-dev/odysseus), `main` at `934d23c0be29c9721385f34565c0ae2cbd60da04`.

This derivative remains AGPL-3.0-or-later, with the upstream [LICENSE](LICENSE), [acknowledgments](ACKNOWLEDGMENTS.md), and third-party notices retained. The app links to this fork's public source. If you distribute or deploy a further modified version, offer the source matching that version to its users.

## Included changes

- Approve for me recognizes plain DeviantArt profile reads alongside YouTube and GitHub profiles, including after external search context. Query payloads, extra paths, Ask mode, delegated callers and disabled tools retain their existing checks. The approval and agent-loop regression suite passed 275 checks for this update.
- Agent context budgets include native tool definitions, and trimming preserves the current user question plus complete recent tool exchanges. Large results are stored in a private per-chat SQLite FTS5 index with bounded search/exact chunk retrieval. Archives obey existing tool policies and are removed with their chats; incognito and delegated API-token turns do not store results. This is a native implementation of the storage-and-retrieval pattern, not a distribution of Context Mode.
- NX is the default theme for fresh profiles and reset. Saved personality names remain visible when agent rounds are reconstructed after reload; underlying model provenance stays available.

- Group chats can continue sequentially for 20 replies, 100 replies, or until Stop. A compact popover in the composer contains the settings and running indicator. Auto conversation is opt-in and runs in the browser tab.
- Group turns preserve the selected mode, workspace and tool permissions. Continuations keep the original task. Real approval/question events pause sequential turns and resume the correct participant after a human choice. Stop invalidates pending choices; tool results remain visible during streaming.
- ChatGPT subscription requests omit unsupported generation parameters and support native function schemas, calls, and result history. New connections enable native tools. Document finetune requests still suppress schemas. Reconnect an existing upstream ChatGPT subscription provider once to save its updated native-tool capability.
- The image-generation tool has a native schema and remains available on follow-up agent turns when enabled and connected. Provider errors remain failed tool results; an image-less Codex completion reports that no new file was saved.
- Optional authenticated, loopback-only image bridge uses an existing host Codex login. It includes a portable user-service installer. No account credentials or image files are shipped.
- Workspace default and Docker mount provide a visible, persistent `/workspace` alias. Emoji rendering supports color emoji fonts and validates image URLs.
- Ollama Qwen 3.5 stability and context detection fixes, plus the Real-ESRGAN wheel build correction used by the local Docker installation.

## Installation and data

The normal installation stays `git clone`, `cp .env.example .env`, then `docker compose up -d --build`. No personal source mounts, host-network workaround, GPU identifier or model download is required for the base setup.

`.env`, data, credentials, chats, generated images, local model configurations, logs and personal installation notes are excluded from Git and Docker build context. Existing upstream GPU overlays remain available. Optional image bridge instructions are in [docs/codex-image-bridge.md](docs/codex-image-bridge.md).

## Validation

October 6 context/theme/personality update: 524 focused checks passed. With the local `huihui-qwen3.8:27b-local` model and 43 native tool definitions, a synthetic dense tool-output history reproduced the exact `no user query found in messages` HTTP 500 under the old message-only budget. The schema-aware budget returned HTTP 200 for that input and a further tool round. A separate live test made the model call `context_search`, retrieve an exact value absent from the preview, and answer with that value. These are bounded synthetic checks, not a guarantee of perfect recall in arbitrary conversations.

The original local installation passed focused regression tests for group cancellation/limits, approval routing, native function-call transport/result history, image dispatch/errors, Markdown/emoji handling, and model compatibility. A hidden browser verified the real group controls using simulated replies. Live subscription probes verified function-call schema acceptance and result continuation on `gpt-6.1-sol`.

Fork packaging validation: 215 focused checks passed, with one skipped check. A clean source-context Docker build passed using cached dependency layers; a fresh isolated app reached login and UID 1000 wrote through `/workspace` into temporary persistent data. This PC's unavailable bridge-network module required the build/smoke test to use isolated host/disabled networking. The standard bridge-network Compose configuration and the standalone GPU templates were validated without starting GPU or model downloads.

Those checks do not establish every provider/model combination, desktop-native GUI launching from Docker, or GPU operation on another computer. The Codex image bridge requires a compatible CLI with native image generation enabled and an existing ChatGPT login; it does not edit existing images. Shared agent tools remain subject to the existing permissions and approval controls.
