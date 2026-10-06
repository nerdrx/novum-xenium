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

The shield button beside Agent/Chat selects approval behavior for your account's next agent turn, including group participants:

- **Ask for approval**: approve each agent write, shell command, or internet call. Reads in the workspace remain available. Automatic URL/transcript and web-search prefetch are deferred to agent tools.
- **Approve for me** (default): retain the existing automatic checks and task/chat approval choices when untrusted context makes an action risky.
- **Full access**: skip automatic tool approval prompts within the current workspace/container.

These modes do not add host-folder access or override disabled tools, account privileges, plan mode, or filesystem restrictions. Running turns keep their original mode. Only an interactive user can save a mode; API tokens and internal tool calls cannot grant themselves full access. Other user interactions, such as a tool asking for missing information, still appear in Full access.

ChatGPT subscription chat and native tools use the existing provider connection in Settings. Image generation through a logged-in host Codex CLI is an optional extra; see [its setup](docs/codex-image-bridge.md). It is not required to start the Docker stack.

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
