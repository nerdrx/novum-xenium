# NX Odysseus workflow guide

[Back to the main page](../README.md) · [Installation](../website/setup.md) · [Validation record](../FORK-CHANGES.md)

This guide covers the NX controls and their operating boundaries. The main page introduces the product; this page keeps the detailed behavior available for day-to-day use.

## Working on a repository

Open **Workspace → Project tools, checks and run evidence**. Inspect the repository, create a managed worktree and select **Use this worktree**. Describe a bounded change, then review the diff and actual test output before publishing. Dirty or ignored work is preserved when removing a worktree.

The standard Docker workspace is `/workspace` inside the container and `data/agent_workspace/workspace/` on the host. File tools stay within the selected folder; the shell starts there but is not an operating-system sandbox. Native writes use pinned POSIX directory descriptors and preserve existing mode, owner/group and supported user/ACL metadata. They fail if those safety APIs or metadata preservation are unavailable; Docker uses Linux, including Docker on Windows/macOS. Multi-file patches validate first but remain non-atomic on later I/O failure: inspect the workspace diff when warned. Agent writes and shell tools require a bounded snapshot, so use a sparse source checkout when a repository contains large benchmark captures or generated artifacts.

The ChatGPT subscription connection authenticates model inference. Git authentication must be configured separately for private repositories or publishing. The [NX Warp coding test](https://github.com/nerdrx/nx-warp/pull/74) used the production agent loop for editing, testing and committing, with host-side review, push and PR creation. It does not establish private authentication or publishing through the normal chat UI.

## Group conversations

Group chats have a circular-arrow button beside Agent/Chat. Open it for **Auto conversation**, **20 / 100 replies / Until Stop**, and **Stop**. Tool approvals wait for your choice before the requesting participant continues.

## Windows and model comparison

Tool windows raise when opened or clicked. Popup menus follow the live window stack, including Compare model suggestions and export menus, so they remain above their parent after repeated window use. The Compare scoreboard also opens in front. Compare's 5–300 second timeout also applies to model checks, retries and shuffle replacements. The check explains that a local model may be loading or queued; Skip continues without verifying availability. Closing the check cancels its browser requests, while a provider request already running on the server can continue until its timeout.

## Approval modes

The shield button beside Agent/Chat selects approval behavior for your account's next agent turn, including group participants:

- **Ask for approval**: approve each agent write, shell command, or internet call. Reads in the workspace remain available. Automatic URL/transcript and web-search prefetch are deferred to agent tools.
- **Approve for me** (default): automatically read canonical public YouTube/GitHub/DeviantArt profiles and exact HTTPS links supplied by you or returned by search. For uncertain public page reads, a separate tool-free review uses the current model and only your latest trusted request plus the proposed action. An explicit `allow` authorizes only that exact action for the current run; `ask`, invalid output, or timeout shows an approval card. Public-address checks, DNS pinning, and redirect checks remain enforced by the fetcher.
- **Full access**: skip automatic tool approval prompts within the current workspace/container.

These modes do not add host-folder access or override disabled tools, account privileges, plan mode, or filesystem restrictions. Running turns keep their original mode. Only an interactive user can save a mode; API tokens and internal tool calls cannot grant themselves full access. Other user interactions, such as a tool asking for missing information, still appear in Full access.

The lightweight judge adds no model download, service, or dependency. It runs only when the normal Auto rules would ask: at most six distinct candidates per run, one attempt each, eight seconds maximum, and 128 output tokens. It does not receive personas, fetched page content, tool results, or the conversation history. Eligible coding actions are small `write_file` / `edit_file` source or text changes inside the selected workspace, with a required pre-write snapshot; the inspection exception accepts only plain `pwd` and constrained `ls`. Query-bearing or encoded/action-like URLs, arbitrary shell execution, deletions, secret/hidden files, private reads, unknown tools, Ask mode, plan mode and delegated API-token runs cannot use this exception. Edits in incognito do not use the judge because no persistent snapshot is created. Decisions are cached only within the run and their short reasons remain visible after refresh. Classification is a model judgment, not a guarantee that every public GET is harmless.

## When an agent goes in circles

Repeated unchanged reads, plans and failed retries can pause an agent turn before it uses all its rounds. The guard checks individual tool results across rounds; adding narration or rearranging the calls does not reset it. Three rounds containing repeats within the last eight monitored rounds trigger the pause, with history bounded to 64 signatures. File reads distinguish offsets, normalize paths and ignore limit changes when the returned page is identical.

Changed results and successful edits reset the counter. Background-job polling, approval cards and questions are excluded. The pause explains which tools repeated and how often, and stays in the saved reply after refresh. It does not roll back edits, replay tools or automatically switch to a teacher model. Review the latest output and send a different next step to continue. Group auto-conversation also stops at these pauses; task boards keep incomplete work open instead of treating a partial reply as a finished assignment.

This is a bounded repetition check, not a judgment of whether every action is useful. It cannot detect a hung tool before that tool returns, and successful shell commands or unknown read-only MCP tools still rely on the existing exact-call backstop and round limit.

## Restart recovery

after a process interruption, open the chat and click **Continue** on its recovery card. The server retains bounded partial text and tool outcomes in owner-scoped checkpoints. Continue is one-use, rechecks the saved workspace/model/endpoint and preserves read-only plan mode. Saved evidence is untrusted context; tools and old approvals are never replayed automatically. In-memory runs still reconnect normally without a restart. Stop also works when pressed before the detached run starts. Incognito does not store checkpoints. Stop tracks commands in the persistent tmux pane and terminates their owned descendants while preserving shell state. Deliberately detached or reparented processes may need separate cleanup. Inspect remaining writers before restoring files.

## Coding undo

open the workspace picker to **Create snapshot**, choose one, **Review changes**, then **Restore files**. The list belongs to the active workspace shown beneath it. Selecting another snapshot clears the old review; review that selection before restoring. Failed folder and snapshot loads offer a retry. Agent write/patch/shell/Python tools save one baseline per turn before execution. A stale preview is rejected; restore saves another recovery point first. Snapshots retain the newest 20 per chat/workspace, up to 2,000 files, 8 MiB per file and 64 MiB total. Dependencies, hidden directories, secrets, symlinks and special files are excluded. An oversized workspace must be reduced before protected tools can run. Review shows both text and executable-permission changes. Restore covers included workspace files and permissions; shell actions outside that folder, processes, databases, external services and excluded files are not undone. On POSIX, restore pins directories and refuses symlink/hardlink traversal; platforms without the required descriptor-relative APIs cannot restore snapshots (Docker runs on Linux). Traversal errors fail the snapshot or preview instead of silently omitting unreadable directories. Concurrent external writers can still change regular files during restore; stop them first. A mid-restore failure reports the recovery snapshot rather than claiming an atomic rollback. Snapshot files remain in private app data after chat deletion.

## Coordinated teams

open the group controls and enable **Coordinate tasks**. Enter the shared plan, assign builders/reviewers, and run one work + review pass. Each task has one builder; optional reviewers use enforced read-only plan mode. Results remain **awaiting review** until you **Mark done**. A stopped or refreshed **working** task blocks another pass until explicit **Retry task**; verify prior side effects before retrying. Boards persist on the server. Ordinary Until Stop conversations remain available separately; coordinated task passes run on the server and stop for human verification. Closing the tab does not cancel them. A process restart marks unfinished passes interrupted; inspect the saved work before explicitly retrying.

## Context inspector

click the context ring in the chat header after an agent reply. The last assembled request shows estimates for instructions, native tools, memory/documents, conversation and tool outputs, plus output reserve and trimmed tokens. Archived results are stored separately and consume no prompt tokens until retrieved. The displayed output reserve matches the limit sent to the selected provider route. Small windows can reduce that limit to keep the assembled request within budget. Provider tokenization can differ from these estimates.

## Application backups

Settings → Admin → Backup provides **Download Full Backup**, **Preview Full Restore**, and **Stage Restore and Require Restart**. Archives include chats, settings, memory stores, workspace files and private app credentials/keys; keep them private. SQLite databases are copied through SQLite's backup API, including committed WAL data. Backup creation pins regular source files and directories. A separate SQLite helper verifies the actual database and WAL/SHM file identities before copying and holds its read transaction through the backup. Excluded model/cache directories are pruned before traversal; existing size/file-count limits apply during creation. Each database snapshot has a three-minute deadline. Backup remains non-atomic against arbitrary concurrent filesystem mutation. It requires safe POSIX APIs and Linux procfs for database snapshots; Docker supplies both. File moves can abort a backup, so stop them and retry when prompted. ZIP validation rejects unsafe paths, links and excessive expansion. Restore activates before database initialization on the next Odysseus restart, with interrupted-install rollback/retry handling. Cached models and external Docker service volumes (including ChromaDB vector indexes) are excluded and preserved; rebuild vector indexes when needed. This is a complete application-data backup, not a snapshot of the entire Docker stack or arbitrary host folders. Existing JSON import/export remains available.

ChatGPT subscription chat and native tools use the existing provider connection in Settings. Image generation through a logged-in host Codex CLI is an optional extra; see [its setup](codex-image-bridge.md). It is not required to start the Docker stack.

## Longer agent chats

native tool definitions now count toward the model's context budget. Large tool results (over 6,000 characters) are indexed in a private, chat-scoped SQLite store; the model receives a short preview and can use `context_search` to retrieve matching excerpts or read exact chunks. Full tool bubbles stay visible. This follows the storage-and-retrieval approach described in [Context Mode](https://github.com/Arikazei/context-mode-app), using Python/SQLite already included in the Docker image. No Context Mode code or extra service is bundled.

## Tools on demand

ordinary requests to find an online service select web search/fetch instead of unrelated model-download tools or the complete browser bundle. MCP descriptions follow the selected tools, and native schemas are bounded against the actual model window on every provider route. The current question and recent native tool-call structure must survive trimming; a request that cannot fit stops with an explicit context-budget error before reaching the model.

## Web access controls

the magnifying-glass toggle enables **Search & fetch** in Agent mode and adds web results in Chat mode. Turning it off blocks the native search and page-fetch tools. Browser MCP access is separate: an Agent request containing a URL selects enabled browser entry points even when search is off or retrieval misses them. Browser permissions, disabled tools and approval rules still apply; turning the browser off blocks all its MCP actions.

This does not increase the model's context window or guarantee lossless recall: each stored result is capped at 1 MiB (an explicit marker identifies omitted middle content), each chat retains up to 20 MiB of source text, and results expire after 30 days. Deleting a chat removes its archive. Incognito and delegated API-token turns do not create archives. The tool obeys disabled-tool/account policies, derives the chat and owner from the server, and treats retrieved text as untrusted data.

The default theme is **NX**, matching the exported palette and synapse background. Existing saved themes remain selected; **Reset to Default** applies NX. Saved agent rounds retain the personality name, with the actual model available in the label tooltip.

## Chat titles

Ordinary and group chats use the first request as an immediate title. Older model/time placeholders show a request-based title when available; their stored names are not bulk rewritten. Naming calls can refine generated titles after a reply. A title you explicitly set is kept, even if it equals a model name or `Chat`.

## Project guidance and checks

Agent turns in a Git workspace receive bounded repository guidance, build/test hints and a compact file map. Root instructions and instructions along the selected folder's ancestry apply; unrelated nested rules are not loaded as global rules. Repository text cannot grant permissions or override your request. The map is a starting point, not a replacement for inspecting source.

Verification commands are explicit argv arrays you review and save for the repository. A required check must pass before the verification gate says complete. Checks can run manually against a managed worktree; automatic checks after agent edits are opt-in. Saved results are tied to the worktree's commit and dirty content, so changing files makes previous results stale. A check that changes the worktree cannot certify that changed state; rerun against the final files. Timeouts and Stop terminate registered verifier processes. No checks configured means unverified, not passed.

## Separate shell execution

The default shell still runs in the application container. For a separate execution container, set a random `ODYSSEUS_EXECUTOR_TOKEN` of at least 32 characters in `.env`, then use:

```sh
docker compose -f docker-compose.yml -f docker.executor.yml up -d --build
```

The worker mounts only the standard `/workspace` code folder. It receives no model keys, application data, Docker socket or SSH identity. Its root filesystem is read-only, privileges are dropped, and process, memory and CPU limits apply. Bash and Python commands run there; native file tools and browser tools remain in the app. Shell state is not shared with the application's tmux terminal. Network access remains available for package downloads. The container is a practical separation boundary, not a claim that arbitrary hostile code is harmless.

Select a workspace inside `/workspace`; a different mount requires matching `ODYSSEUS_EXECUTOR_ROOT` and worker volume configuration. A missing worker fails the command without retrying it inside the app. Existing host-network installation overrides need an explicit reachable worker URL; the optional file above targets the normal Docker network.

## Preflight, run evidence and coding evaluations

**Check capabilities** reports configured providers, tool declarations, backend state and known context information. The report uses readable sections instead of a tool-inventory JSON dump; the complete JSON remains available through Copy report and Download JSON. Unknown stays unknown; registry context values are advisory. This offline check does not start models or prove provider reachability. Existing explicit provider tests remain available in Settings.

**Run evidence** shows recent run status, elapsed time, tool names and exit codes. It retains up to 20 runs per chat and 256 metadata events per run. Prompts, commands, tool output, endpoint URLs and credentials are not copied into this metadata log. Full content remains in the chat's existing history and recovery storage. Deleting the chat deletes its evidence.

The small same-model coding evaluation in `scripts/harness_eval.py` checks repair, implementation and a change across multiple files. Use a disposable app and a shared fixture workspace. Supply a browser cookie through `NX_EVAL_COOKIE` when authentication is enabled, select one model/endpoint, and run:

```sh
python scripts/harness_eval.py --workspace-root /path/to/fixtures \
  --app-workspace-root /workspace/fixtures --model MODEL --endpoint-id ENDPOINT_ID
```

The report requires real tool calls, a completed stream and independent file assertions. A stopped run, approval question, exhausted budget, failed project verification or failed file test fails the task. Each case has a 600-second stream budget; change it with `--case-timeout SECONDS`. Heartbeats do not renew that budget. A verification timeout or unavailable evidence endpoint is recorded as incomplete work rather than aborting the entire report. These small tasks are a regression baseline, not a general coding leaderboard.

Group Team also offers **Isolate task worktrees** for an admin or single-user Git workspace. Each task starts from the selected repository HEAD; its builder and reviewer share that task checkout. Uncommitted source changes are not copied. Task paths survive retries and server restarts. Inspect and merge the resulting work yourself; no automatic merge runs.
