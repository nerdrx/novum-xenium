# NX Odysseus workflow guide

[Back to the main page](../README.md) · [Installation](../website/setup.md) · [Validation record](../FORK-CHANGES.md)

This guide covers the NX controls and their operating boundaries. The main page introduces the product; this page keeps the detailed behavior available for day-to-day use.

## Working on a repository

Use a separate checkout inside your selected workspace, describe a bounded change, and ask the agent to inspect, edit and run the relevant tests. Review the diff and actual test output before publishing.

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

after a process interruption, open the chat and click **Continue** on its recovery card. The server retains bounded partial text and tool outcomes in owner-scoped checkpoints. Continue is one-use, rechecks the saved workspace/model/endpoint and preserves read-only plan mode. Saved evidence is untrusted context; tools and old approvals are never replayed automatically. In-memory runs still reconnect normally without a restart. Stop also works when pressed before the detached run starts. Incognito does not store checkpoints.

## Coding undo

open the workspace picker to create a **Snapshot**, choose one, **Review** the changes, then **Restore**. Agent write/patch/shell/Python tools save one baseline per turn before execution. A stale preview is rejected; restore saves another recovery point first. Snapshots retain the newest 20 per chat/workspace, up to 2,000 files, 8 MiB per file and 64 MiB total. Dependencies, hidden directories, secrets, symlinks and special files are excluded. An oversized workspace must be reduced before protected tools can run. Review shows both text and executable-permission changes. Restore covers included workspace files and permissions; shell actions outside that folder, processes, databases, external services and excluded files are not undone. On POSIX, restore pins directories and refuses symlink/hardlink traversal; platforms without the required descriptor-relative APIs cannot restore snapshots (Docker runs on Linux). Traversal errors fail the snapshot or preview instead of silently omitting unreadable directories. Concurrent external writers can still change regular files during restore; stop them first. A mid-restore failure reports the recovery snapshot rather than claiming an atomic rollback. Snapshot files remain in private app data after chat deletion.

## Coordinated teams

open the group controls and enable **Coordinate tasks**. Enter the shared plan, assign builders/reviewers, and run one work + review pass. Each task has one builder; optional reviewers use enforced read-only plan mode. Results remain **awaiting review** until you **Mark done**. A stopped or refreshed **working** task blocks another pass until explicit **Retry task**; verify prior side effects before retrying. Boards persist on the server. Ordinary Until Stop conversations remain available separately; team passes run in the browser and stop for human verification.

## Context inspector

click the context ring in the chat header after an agent reply. The last assembled request shows estimates for instructions, native tools, memory/documents, conversation and tool outputs, plus output reserve and trimmed tokens. Archived results are stored separately and consume no prompt tokens until retrieved. The displayed output reserve matches the limit sent to the selected provider route. Small windows can reduce that limit to keep the assembled request within budget. Provider tokenization can differ from these estimates.

## Application backups

Settings → Admin → Backup provides **Download Full Backup**, **Preview Full Restore**, and **Stage Restore and Require Restart**. Archives include chats, settings, memory stores, workspace files and private app credentials/keys; keep them private. SQLite databases are copied through SQLite's backup API. ZIP validation rejects unsafe paths, links and excessive expansion. Restore activates before database initialization on the next Odysseus restart, with interrupted-install rollback/retry handling. Cached models and external Docker service volumes (including ChromaDB vector indexes) are excluded and preserved; rebuild vector indexes when needed. This is a complete application-data backup, not a snapshot of the entire Docker stack or arbitrary host folders. Existing JSON import/export remains available.

ChatGPT subscription chat and native tools use the existing provider connection in Settings. Image generation through a logged-in host Codex CLI is an optional extra; see [its setup](codex-image-bridge.md). It is not required to start the Docker stack.

## Longer agent chats

native tool definitions now count toward the model's context budget. Large tool results (over 6,000 characters) are indexed in a private, chat-scoped SQLite store; the model receives a short preview and can use `context_search` to retrieve matching excerpts or read exact chunks. Full tool bubbles stay visible. This follows the storage-and-retrieval approach described in [Context Mode](https://github.com/Arikazei/context-mode-app), using Python/SQLite already included in the Docker image. No Context Mode code or extra service is bundled.

## Tools on demand

ordinary requests to find an online service select web search/fetch instead of unrelated model-download tools or the complete browser bundle. MCP descriptions follow the selected tools, and native schemas are bounded against the actual model window on every provider route. The current question and recent native tool-call structure must survive trimming; a request that cannot fit stops with an explicit context-budget error before reaching the model.

## Web access controls

the magnifying-glass toggle enables **Search & fetch** in Agent mode and adds web results in Chat mode. Turning it off blocks the native search and page-fetch tools. Browser MCP access is separate: an Agent request containing a URL selects enabled browser entry points even when search is off or retrieval misses them. Browser permissions, disabled tools and approval rules still apply; turning the browser off blocks all its MCP actions.

This does not increase the model's context window or guarantee lossless recall: each stored result is capped at 1 MiB (an explicit marker identifies omitted middle content), each chat retains up to 20 MiB of source text, and results expire after 30 days. Deleting a chat removes its archive. Incognito and delegated API-token turns do not create archives. The tool obeys disabled-tool/account policies, derives the chat and owner from the server, and treats retrieved text as untrusted data.

The default theme is **NX**, matching the exported palette and synapse background. Existing saved themes remain selected; **Reset to Default** applies NX. Saved agent rounds retain the personality name, with the actual model available in the label tooltip.
