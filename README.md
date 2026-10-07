## NX Odysseus

An independent, community-maintained fork of [Odysseus](https://github.com/odysseus-dev/odysseus), maintained by [nerdrx](https://github.com/nerdrx). Based on the upstream `main` branch at `934d23c0be29c9721385f34565c0ae2cbd60da04`.

Modified on October 6, 2026. The original authors, license and third-party notices are preserved. This fork remains **AGPL-3.0-or-later**. See [fork changes](FORK-CHANGES.md) for the changes and validation limits. This is not an official upstream release.

<p align="center">
  <img src="assets/branding/odysseus-wordmark.png" alt="Odysseus" width="238">
</p>

<p align="center">
  A self-hosted AI workspace for chat, agents, research, documents, email, notes, calendar, and local model workflows.
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> ·
  <a href="#what-this-fork-changes">Fork Changes</a> ·
  <a href="website/setup.md">Setup Guide</a> ·
  <a href="CONTRIBUTING.md">Contributing</a> ·
  <a href="ROADMAP.md">Roadmap</a>
</p>

<p align="center">
  <a href="https://repology.org/project/odysseus-ai/versions"><img src="https://repology.org/badge/vertical-allrepos/odysseus-ai.svg" alt="Packaging status"></a>
</p>

<p align="center">
  <img src="assets/branding/odysseus-browser.jpg" alt="Odysseus interface">
</p>

---

## What this fork changes

NX keeps the original Docker quick start and adds these changes on top of upstream:

- **Approval controls:** Ask for approval, Approve for me, or Full access within the workspace/container. Auto handles known public reads immediately and uses a small, tool-free judge for bounded public reads, workspace inspections, and reversible coding edits; its reason appears in the tool output or approval card.
- **Recovery and coding undo:** interrupted runs offer explicit Continue, while coding tools capture bounded workspace snapshots with review diffs and restore controls.
- **Complete application backups:** chats, settings, private app data and workspaces in a validated ZIP, with preview and restart activation. Cached models and external service volumes are preserved separately.
- **Continuous group conversations:** 20 replies, 100 replies, or Until Stop, with a compact composer popover. Participants can use tools, preserve the workspace, and pause for real approval or clarification. Optional task coordination adds a saved shared plan, one builder per task, read-only reviewers, and human completion.
- **Reusable skills and deeper recall:** skill discovery stays small, with procedures and their tools loaded on demand. Learned skills honor your confidence threshold, drafts remain unverified, and usage counts reflect procedure reads. Agents can search past chats, open an exact matching message, and page through its saved text in 4,000-character chunks with source links and timestamps. Existing account and approval boundaries apply. See the [Hermes feature comparison](docs/hermes-comparison.md) for usage and test limits.
- **Longer agent workflows:** native tool schemas count toward the context budget; large outputs become searchable per-chat archives with exact chunk retrieval. Current questions and complete recent tool exchanges survive trimming. The context popup shows estimated prompt components, native schemas, reserved output, trim counts and archived results.
- **ChatGPT subscription tools:** native function calls and follow-up results, unsupported-parameter fixes, and an optional host Codex image-generation bridge with visible success/failure results.
- **Workspace and interface:** persistent `/workspace`, improved emoji rendering, the NX palette/synapse default theme, and personality names preserved after refresh. Chat progress explains waiting versus streaming with elapsed time; failure messages explain the cause and next steps, including after switching chats or reloading.
- **Local model and Docker fixes:** Ollama Qwen request/context compatibility and the dependency build fix used by the Docker installation.

These are changes in this fork, not promises about every provider or GPU. The [change record](FORK-CHANGES.md) lists the upstream base, test evidence, and validation limits; the [image bridge guide](docs/codex-image-bridge.md) covers that optional setup.

## Quick Start

The fork's default branch is `main`. Docker builds the code from this checkout.

```bash
git clone https://github.com/nerdrx/nx-odysseus.git
cd nx-odysseus
cp .env.example .env
docker compose up -d --build
```

Open `http://localhost:7000` when the containers are healthy. The first admin password is printed in `docker compose logs odysseus`.

Native installs, GPU notes, Windows/macOS instructions, HTTPS, and configuration live in the [setup guide](website/setup.md).

Your database, chats, settings, credentials and model caches stay under `data/`. Agent files are available as `/workspace` inside Docker and `data/agent_workspace/workspace/` on your computer. The default setup keeps authentication enabled and published ports on localhost.

Group chats have a circular-arrow button beside Agent/Chat. Open it for **Auto conversation**, **20 / 100 replies / Until Stop**, and **Stop**. Tool approvals wait for your choice before the requesting participant continues.

Tool windows raise when opened or clicked. Popup menus follow the live window stack, including Compare model suggestions and export menus, so they remain above their parent after repeated window use. The Compare scoreboard also opens in front. Compare's 5–300 second timeout also applies to model checks, retries and shuffle replacements. The check explains that a local model may be loading or queued; Skip continues without verifying availability. Closing the check cancels its browser requests, while a provider request already running on the server can continue until its timeout.

The shield button beside Agent/Chat selects approval behavior for your account's next agent turn, including group participants:

- **Ask for approval**: approve each agent write, shell command, or internet call. Reads in the workspace remain available. Automatic URL/transcript and web-search prefetch are deferred to agent tools.
- **Approve for me** (default): automatically read canonical public YouTube/GitHub/DeviantArt profiles and exact HTTPS links supplied by you or returned by search. For uncertain public page reads, a separate tool-free review uses the current model and only your latest trusted request plus the proposed action. An explicit `allow` authorizes only that exact action for the current run; `ask`, invalid output, or timeout shows an approval card. Public-address checks, DNS pinning, and redirect checks remain enforced by the fetcher.
- **Full access**: skip automatic tool approval prompts within the current workspace/container.

These modes do not add host-folder access or override disabled tools, account privileges, plan mode, or filesystem restrictions. Running turns keep their original mode. Only an interactive user can save a mode; API tokens and internal tool calls cannot grant themselves full access. Other user interactions, such as a tool asking for missing information, still appear in Full access.

The lightweight judge adds no model download, service, or dependency. It runs only when the normal Auto rules would ask: at most six distinct candidates per run, one attempt each, eight seconds maximum, and 128 output tokens. It does not receive personas, fetched page content, tool results, or the conversation history. Eligible coding actions are small `write_file` / `edit_file` source or text changes inside the selected workspace, with a required pre-write snapshot; the inspection exception accepts only plain `pwd` and constrained `ls`. Query-bearing or encoded/action-like URLs, arbitrary shell execution, deletions, secret/hidden files, private reads, unknown tools, Ask mode, plan mode and delegated API-token runs cannot use this exception. Edits in incognito do not use the judge because no persistent snapshot is created. Decisions are cached only within the run and their short reasons remain visible after refresh. Classification is a model judgment, not a guarantee that every public GET is harmless.

**Restart recovery:** after a process interruption, open the chat and click **Continue** on its recovery card. The server retains bounded partial text and tool outcomes in owner-scoped checkpoints. Continue is one-use, rechecks the saved workspace/model/endpoint and preserves read-only plan mode. Saved evidence is untrusted context; tools and old approvals are never replayed automatically. In-memory runs still reconnect normally without a restart. Incognito does not store checkpoints.

**Coding undo:** open the workspace picker to create a **Snapshot**, choose one, **Review** the changes, then **Restore**. Agent write/patch/shell/Python tools save one baseline per turn before execution. A stale preview is rejected; restore saves another recovery point first. Snapshots retain the newest 20 per chat/workspace, up to 2,000 files, 2 MiB per file and 20 MiB total. Dependencies, hidden directories, secrets, symlinks and special files are excluded. An oversized workspace must be reduced before protected tools can run. Restore covers included workspace files and permissions; shell actions outside that folder, processes, databases, external services and excluded files are not undone. A mid-restore failure reports the recovery snapshot rather than claiming an atomic rollback. Snapshot files remain in private app data after chat deletion.

**Coordinated teams:** open the group controls and enable **Coordinate tasks**. Enter the shared plan, assign builders/reviewers, and run one work + review pass. Each task has one builder; optional reviewers use enforced read-only plan mode. Results remain **awaiting review** until you **Mark done**. A stopped or refreshed **working** task blocks another pass until explicit **Retry task**; verify prior side effects before retrying. Boards persist on the server. Ordinary Until Stop conversations remain available separately; team passes run in the browser and stop for human verification.

**Context inspector:** click the context ring in the chat header after an agent reply. The last assembled request shows estimates for instructions, native tools, memory/documents, conversation and tool outputs, plus output reserve and trimmed tokens. Archived results are stored separately and consume no prompt tokens until retrieved. Provider tokenization can differ from these estimates.

**Application backups:** Settings → Admin → Backup provides **Download Full Backup**, **Preview Full Restore**, and **Stage Restore and Require Restart**. Archives include chats, settings, memory stores, workspace files and private app credentials/keys; keep them private. SQLite databases are copied through SQLite's backup API. ZIP validation rejects unsafe paths, links and excessive expansion. Restore activates before database initialization on the next Odysseus restart, with interrupted-install rollback/retry handling. Cached models and external Docker service volumes (including ChromaDB vector indexes) are excluded and preserved; rebuild vector indexes when needed. This is a complete application-data backup, not a snapshot of the entire Docker stack or arbitrary host folders. Existing JSON import/export remains available.

ChatGPT subscription chat and native tools use the existing provider connection in Settings. Image generation through a logged-in host Codex CLI is an optional extra; see [its setup](docs/codex-image-bridge.md). It is not required to start the Docker stack.

**Longer agent chats:** native tool definitions now count toward the model's context budget. Large tool results (over 6,000 characters) are indexed in a private, chat-scoped SQLite store; the model receives a short preview and can use `context_search` to retrieve matching excerpts or read exact chunks. Full tool bubbles stay visible. This follows the storage-and-retrieval approach described in [Context Mode](https://github.com/Arikazei/context-mode-app), using Python/SQLite already included in the Docker image. No Context Mode code or extra service is bundled.

**Tools on demand:** ordinary requests to find an online service select web search/fetch instead of unrelated model-download tools or the complete browser bundle. MCP descriptions follow the selected tools, and native schemas are bounded against the actual model window on every provider route. The current question and recent native tool-call structure must survive trimming; a request that cannot fit stops with an explicit context-budget error before reaching the model.

This does not increase the model's context window or guarantee lossless recall: each stored result is capped at 1 MiB (an explicit marker identifies omitted middle content), each chat retains up to 20 MiB of source text, and results expire after 30 days. Deleting a chat removes its archive. Incognito and delegated API-token turns do not create archives. The tool obeys disabled-tool/account policies, derives the chat and owner from the server, and treats retrieved text as untrusted data.

The default theme is **NX**, matching the exported palette and synapse background. Existing saved themes remain selected; **Reset to Default** applies NX. Saved agent rounds retain the personality name, with the actual model available in the label tooltip.

## Features

- **Chat + Agents** — local/API models, tools, MCP, files, shell, skills, and memory.
- **Cookbook** — hardware-aware model recommendations, downloads, and serving.
- **Deep Research** — multi-step web research with source reading and report generation.
- **Compare** — blind side-by-side model testing and synthesis.
- **Documents** — writing-first editor with AI edits, suggestions, Markdown, HTML, CSV, and syntax highlighting.
- **Email** — IMAP/SMTP inbox with triage, tags, summaries, reminders, and reply drafts.
- **Notes, Tasks + Calendar** — reminders, todos, scheduled agent tasks, and CalDAV sync.
- **Extras** — gallery/image editor, themes, uploads, web search, presets, sessions, and 2FA.

## Demo

A full hover-to-play tour lives on the [Odysseus landing page](https://odysseus-dev.github.io/odysseus/). Its source lives under [`website/`](website/).

## Contributing

Help is welcome. The best entry points are fresh-install testing, provider setup bugs, mobile/editor polish, docs, and small focused refactors. See [CONTRIBUTING.md](CONTRIBUTING.md) and [ROADMAP.md](ROADMAP.md).

## Security

Odysseus is a self-hosted workspace with powerful local tools. Keep auth enabled, keep private data out of Git, and do not expose raw model/service ports publicly.

- Keep `AUTH_ENABLED=true` for any network-accessible deployment.
- Keep `LOCALHOST_BYPASS=false` outside local development.

Deployment details are in the [setup guide](website/setup.md#security-notes).

## Star History

<a href="https://star-history.dera.page/#odysseus-dev/odysseus&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://star-history.dera.page/svg?repos=odysseus-dev/odysseus&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://star-history.dera.page/svg?repos=odysseus-dev/odysseus&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://star-history.dera.page/svg?repos=odysseus-dev/odysseus&type=date&legend=top-left" />
 </picture>
</a>

## License

AGPL-3.0-or-later -- see [LICENSE](LICENSE) and [ACKNOWLEDGMENTS.md](ACKNOWLEDGMENTS.md).
