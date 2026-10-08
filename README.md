# Novum Xenium

A self-hosted agent workspace. Coding, research, images and longer jobs, with a lightweight desktop app to run the backend.

Built on [Odysseus](https://github.com/odysseus-dev/odysseus) and the NX-Odysseus fork. The original history and AGPL-3.0 license stay with it.

## Desktop app

![Novum Xenium desktop manager](assets/branding/desktop-manager.png)

The Tauri app uses the system webview. It manages an existing Docker Compose installation and opens the same frontend you can use in a browser. No separate desktop copy of chat, tools or memory.

- Start and stop the selected backend, check its health and read logs.
- Open the workspace in its own window.
- Review backend updates, back up persistent data and check recovery if startup fails.
- Install desktop release artifacts through [NX Hub](https://github.com/nerdrx/nx-hub).

The first desktop release adopts an existing checkout; it does not silently install Docker, WSL or Git. Linux is tested locally. Windows builds run in CI; a successful build alone does not establish Windows runtime support. See [desktop setup and update behavior](docs/desktop.md).

```bash
cd desktop
npm ci
npm run dev
```

Requires Rust and the [Tauri system dependencies](https://v2.tauri.app/start/prerequisites/). Backend setup below remains available without the desktop app.

This started with installing Odysseus and using it. Then fixing the things that got in the way: agents losing their tools, chats stopping after one turn, unclear errors, context problems, missing workspace access. It grew into a fork with its own workflow.

The aim is a self-hosted workhorse for coding, research and agent teams. Give it a project, let it use tools, check what it did, and keep going. Local models and hosted providers both work, including a ChatGPT subscription.

[Get started](#get-started) · [What's different](#whats-different) · [What we've tested](#what-weve-tested) · [Workflow guide](docs/nx-workflows.md) · [Change record](FORK-CHANGES.md)

## What's different

The original Odysseus already has chat, agents, MCP, documents, email, notes, tasks, calendar, model comparison, deep research and a gallery. NX builds on that.

- **Working on projects.** A persistent workspace, repository guidance and a compact map, managed Git worktrees, and snapshots you can review and restore. Save the checks a project needs and see whether they actually passed. Docker includes ripgrep and a packaged browser tool that starts without a runtime npm download. Large repos can use a sparse checkout.
- **Keeping longer tasks usable.** Tool definitions count toward the context budget. Large outputs are archived and searchable, with exact chunks available when needed. The context inspector shows where the space goes.
- **Remembering useful things.** Skills load their procedures on demand. Agents can search past chats and open the actual matching messages, with timestamps and links back to the source.
- **Agents working together.** Group chats can keep talking for 20 replies, 100 replies or Until Stop. Shared task boards add a builder, optional read-only reviewers and a human decision on whether the task is done. Coordinated task passes run on the server, so closing the tab does not stop them.
- **Checking the harness.** An offline preflight shows declared model capabilities, configured backends and missing pieces. Run evidence keeps timing, tool outcomes and interruption state without copying prompts, commands or secrets. A small coding evaluation checks actual files, not completion claims.
- **Knowing what's happening.** Waiting and streaming have clearer status messages. Repeated reads and failed retries pause with an explanation, keeping the edits and tool history. Interrupted runs can continue from saved progress after a restart. Queued messages stay with their chat, and task saves can be retried in the same open form without duplicating the job.
- **Choosing how much to approve.** Ask for approval, Approve for me or Full access within the workspace/container. A small judge handles eligible uncertain actions and shows its reason.
- **ChatGPT and images.** Native subscription tool calls, fixes for unsupported request parameters, proper image-provider settings and an optional host Codex image bridge.
- **Finding your chats.** Request-based titles for ordinary and group chats, including older model-name placeholders. Names you set yourself stay untouched.
- **Keeping your setup.** Application-data backups with restore preview, improved emoji rendering, personality names that survive refresh, and the NX default theme. Folder, provider and approval failures offer a retry instead of leaving you guessing.

The [change record](FORK-CHANGES.md) has the details. The [Hermes comparison](docs/hermes-comparison.md) explains the skills, recall and team improvements; Hermes itself isn't a dependency.

## What we've tested

### It worked on NX Warp

We gave the agent a small job in [NX Warp](https://github.com/nerdrx/nx-warp): fix the latency-summary tool crashing on compressed CSV captures.

Using the ChatGPT subscription model `gpt-6.1-sol`, Odysseus cloned a sparse checkout, added a regression, ran it to confirm the failure, fixed the script, passed all six related tests and made the commit.

**[The result is PR #74.](https://github.com/nerdrx/nx-warp/pull/74)** The tests passed again during review, and GitHub's Python CI passed too.

That test also caught another problem in Odysseus: this model wasn't recognized by the context-size lookup, so it kept losing progress under a small input budget. We fixed the lookup, passed 44 context tests, and the agent finished its continuation.

The agent ran through the production loop in a saved-file harness. Review, push and PR creation used the host's existing GitHub login. Private repo access and publishing through the normal chat UI haven't been tested yet. NX Warp also has failures in other CI checks, outside this Python change; the PR records them.

### The other features have checks too

We've used focused regression tests, headless UI checks, isolated Docker starts and bounded live provider/browser tests. Those cover things like retrieving details from archived output, restoring workspace files and permissions, recovering interrupted runs, group tool calls and image-provider discovery.

On October 8, live subscription checks also completed small multi-file coding tasks, a builder/reviewer parser change, public GitHub browsing and exact-detail retrieval from archived output. Image checks fetched the generated PNG and compared its dimensions with the saved metadata. A separate browser check caught and fixed model choices leaking between chats. These are bounded tasks with checked results; they don't establish that every model or project will work equally well.

A later cloud run cloned this repo and fixed unbounded output capture in its coding evaluator in about 81 seconds, with one task approval. An independent offline run passed all 28 related tests before we integrated the patch. An earlier rollback-preparation failure did not repeat; its cause remains unconfirmed.

The [validation record](FORK-CHANGES.md#validation) says what ran and what used simulated replies. The [latest notes](docs/hermes-comparison.md#validation-and-limits) include the coding test and remaining failures. Test runs overlap, so their counts aren't added into one big number.

## Get started

Install Git and Docker Compose, then:

```bash
git clone https://github.com/nerdrx/novum-xenium.git
cd novum-xenium
cp .env.example .env
docker compose up -d --build
```

Open **[localhost:7000](http://localhost:7000)** once the app has started. Use your `ODYSSEUS_ADMIN_PASSWORD` value if you pre-seeded one; otherwise find the temporary password with:

```bash
docker compose logs odysseus
```

Connect a provider in **Settings**, choose **Agent** for tool use, and select your workspace. You don't need to download a local LLM or set up the image bridge to start.

Authentication is on and published ports default to localhost. Application data stays under `data/`. Project files live in `data/agent_workspace/workspace/` on your computer, mounted as `/workspace` inside Docker.

The setup stays the same idea as upstream: clone, copy the environment file, run Compose. See the [setup guide](website/setup.md) for native installs, GPU options, Windows/macOS, HTTPS and configuration.

## Using it

Use local models on your own hardware, or connect a hosted provider when you want cloud inference. The app and workspace remain self-hosted; anything sent to a hosted model goes to that provider.

For images, configure a provider in Settings. The optional [Codex image bridge](docs/codex-image-bridge.md) uses an existing host login and needs a separate setup. It can generate new images and edit an attached image; quality and size settings are guidance.

The [workflow guide](docs/nx-workflows.md) covers project work, approvals, groups, recovery, snapshots, backups and web access.

A few limits matter:

- Full access skips approvals within the current setup. It doesn't mount more host folders or override account permissions and disabled tools. The shell isn't an operating-system sandbox.
- Native file mutation and snapshot restore require safe POSIX file APIs; the standard Docker install has them, including Docker on Windows/macOS. Native platforms lacking those APIs can inspect files and snapshots but cannot run these mutations. Multi-file patches and snapshot restores can be partial after an I/O failure; inspect the reported recovery point or workspace diff.
- Stop cancels owned foreground process groups, background jobs and commands tracked in the persistent tmux pane. The pane keeps its shell state. Deliberately detached or reparented processes may need separate cleanup; Stop cannot undo side effects.
- Snapshots cover included workspace files, up to 2,000 files, 8 MiB per file and 64 MiB total. Stop concurrent file writers before restoring. Snapshots don't undo external services, running processes or shell effects outside the workspace. Use sparse checkouts for large repos.
- Retrieval doesn't enlarge a model's context window or guarantee perfect recall. Requests and output limits are budgeted separately for each provider route.
- Auto-conversation runs in the browser tab. Backups contain private application data and credentials, so keep them private.
- Full backup creation requires safe file APIs and Linux procfs for SQLite snapshots. The standard Docker setup supplies both. A moved or replaced source can abort a backup; retry after file moves stop. Ordinary SQLite writes remain supported through its backup API.

Keep `AUTH_ENABLED=true` for any network-accessible deployment. Keep `LOCALHOST_BYPASS=false` outside local development. More deployment details are in the [security notes](website/setup.md#security-notes).

## Help improve it

Reproducible bugs, fresh-install checks and small fixes are welcome. Show the actual tool or test output, and say when a check used simulated replies. See [CONTRIBUTING.md](CONTRIBUTING.md) and [ROADMAP.md](ROADMAP.md).

## Origin and license

NX Odysseus is an independent fork of [Odysseus](https://github.com/odysseus-dev/odysseus), maintained by [nerdrx](https://github.com/nerdrx). The upstream base is `main` at `934d23c0be29c9721385f34565c0ae2cbd60da04`, with NX changes recorded through October 8, 2026.

It remains **AGPL-3.0-or-later**. The original authors and third-party notices are kept in [ACKNOWLEDGMENTS.md](ACKNOWLEDGMENTS.md); see [LICENSE](LICENSE) for the terms. Keep the license and notices, and provide corresponding source as required when distributing or serving modified versions.

The [upstream demo](https://odysseus-dev.github.io/odysseus/) shows the original product. This repository's change record and workflow guide describe the NX version.
