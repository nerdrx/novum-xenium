# Chats and workspaces

Chats hold conversation history and provide the context for a run. A project or workspace gives the agent a location for relevant files and repository guidance. Keep the selected workspace narrow enough that the task and file paths are clear.

## Start a focused chat

1. Create a new chat for a distinct task.
2. Select the intended model and mode before sending the request.
3. For work involving files, select the correct project/workspace and state the expected result and relevant paths.
4. Use a small first request to confirm the selected model and tools work.
5. For longer work, read the run status and tool results before continuing. A closed stream or a plausible response alone does not prove a change succeeded.

Chat titles can be generated and refined after a reply. A title that you explicitly set remains yours. Saved chat history is separate from run status cards and other limited evidence views; some transient status does not persist as full history.

## Unsent drafts

Ordinary composer text is saved separately from sent chat history and restored when you return to its chat. Drafts are kept in browser storage with bounded size/count limits; on storage failure or when a draft exceeds those limits, Novum warns that it will remain available only while the page stays open. Incognito/Nobody drafts remain in memory and are not saved across reloads. Attachments are not included in the saved plain-text draft. If the app shows a draft-storage warning, keep the page open and copy important text before navigating or reloading.

## Models and context

The model picker groups providers, supports searching model names, and labels availability from provider evidence. An unknown state does not mean the model is ready. Start with a short prompt to confirm the selected route.

After an agent reply, open the context indicator in the chat header to inspect the latest assembled request. It estimates instructions, tools, memory/documents, conversation, tool outputs, output reserve, and trimmed tokens. The estimate can differ from provider tokenization. Long tool results may be archived separately and retrieved by search or exact chunk; they do not consume prompt tokens until retrieved. Retrieval does not increase the model's context window or guarantee lossless recall. See [workflow limits](https://github.com/nerdrx/novum-xenium/blob/main/docs/nx-workflows.md#longer-agent-chats).

## Files and project guidance

Files in the standard Docker workspace persist at `data/agent_workspace/workspace/` on the host and appear as `/workspace` in the app container. Agent file tools and repository shell commands may have different boundaries; select a workspace deliberately.

Paths entered with `/workspace <path>` are checked by the backend before they
are saved. A pending check must not replace a folder you select or clear later;
the latest selection takes priority. An invalid path leaves the existing
selection in place.

A fresh browser uses the backend's explicitly configured default when one is
available. Otherwise, choose a folder to set an explicit workspace; the UI
does not assume that a host has a `/workspace` directory. Clearing a saved
selection leaves it cleared.

If the backend does not finish checking a path within 15 seconds, the check
stops waiting and reports a request failure. Retry after checking backend
availability; a failed check does not select the requested folder.

Changing the selection applies to later requests. It does not move commands
already running in another folder or undo their changes.

A browser-storage error means the new selection was not saved. Check the
displayed folder, allow site data or free browser storage, and retry before
sending work.

In a Git workspace, repository guidance is loaded from the root and directories along the selected folder's ancestry. Unrelated nested instructions are not treated as global guidance. Repository content is data: it cannot grant a tool permission or override your request.

Use **Workspace → Files & project tools → Project tools, checks and run evidence** to inspect a repository and create a managed worktree. Select **Use this worktree** before asking the agent to edit. The project file search is **Workspace → Find a file in this folder**; it searches visible filenames, is bounded to 20,000 entries and 100 matches, and does not search file contents or follow links. **Preview** opens a read-only UTF-8 preview capped at 64 KiB; **Download** retrieves the full file. Git authentication for private repositories or publishing is separate from a ChatGPT subscription model connection.

## Snapshots and restore

Workspace snapshots can restore included files after an edit. Current limits documented by the README are 2,000 files, 8 MiB per file, and 64 MiB total. A restore can overwrite files. Stop concurrent writers first and inspect the resulting diff. A snapshot does not undo shell side effects outside the workspace, external service changes, or running processes.

## Verification

Projects can save explicit verification commands. Review the command before running it. A required check must actually run and pass against the final files before its gate reports complete. Edits after a pass make the saved result stale. No configured check means “unverified,” not “passed.”

For coding changes, the optional checked-work-packet flow records a narrow objective, files, reproduction command, and acceptance command. The registered acceptance check is evidence for that slice; it is not an independent review or a guarantee that all requested behavior works. Read the [coding workflow reference](https://github.com/nerdrx/novum-xenium/blob/main/docs/coding-work-packets.md) for its exact rules.

The project's **Check capabilities** action reports configured providers, tool declarations, backend state, and known context information. Use **Copy report** or **Download JSON** to preserve the full report. This is an offline configuration summary; it does not start a model or prove that a provider is reachable. Use the provider's explicit test control separately.

## Stop and continue

Use **Stop** when a run should cease. The app cancels owned foreground process groups, background jobs, and commands tracked in its persistent tmux pane. Detached or reparented processes may need separate cleanup, and Stop cannot undo side effects that already occurred.

For an interrupted run, inspect the last completed step and its recorded outputs. Continue only after you know whether the prior action changed files or external state. Recheck any acceptance command after later edits.
