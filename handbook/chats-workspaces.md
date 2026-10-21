# Chats and workspaces

Chats hold conversation history and provide the context for a run. A project or workspace gives the agent a location for relevant files and repository guidance. Keep the selected workspace narrow enough that the task and file paths are clear.

## Start a focused chat

1. Create a new chat for a distinct task.
2. Select the intended model and mode before sending the request.
3. For work involving files, select the correct project/workspace and state the expected result and relevant paths.
4. Use a small first request to confirm the selected model and tools work.
5. For longer work, read the run status and tool results before continuing. A closed stream or a plausible response alone does not prove a change succeeded.

Chat titles can be generated and refined after a reply. A title that you explicitly set remains yours. Saved chat history is separate from run status cards and other limited evidence views; some transient status does not persist as full history.

## Saved group presets

Starting a group with at least two participants attempts to save its configuration as a reusable preset in the **Group** tab. If the saved list cannot load, Novum skips the write. A preset-save warning does not stop the group chat from becoming ready.

Use a preset's **×** control or right-click confirmation to delete it. After a lost or failed write response, Novum refreshes the saved list before allowing another deletion. If refreshing fails, reopen the **Group** tab before retrying; old chips cannot submit another deletion until the list has recovered. Preset requests have a 15-second timeout, including successful response-body reads.

Make preset changes in one panel at a time. Writes within that panel are serialized; optional autosave can be skipped with a warning while another preset change is pending. See the pinned [group controls](https://github.com/nerdrx/novum-xenium/blob/369613158e7ad63373a0b3bf0883ff9ae9944dda/static/js/group.js) and [group preset persistence](https://github.com/nerdrx/novum-xenium/blob/e433a03bb1b78fe6472836624bd9ae2f9f1cb459/src/preset_manager.py).

## Personas and saved templates

Starting a persona saves the active custom configuration and separately attempts
to save a reusable template. **Persona saved** confirms the custom configuration;
a reusable-template warning means that the separate template save could not be
confirmed. Copy important unsaved edits before refreshing the page and checking
the saved-template list. A lost response can follow an accepted write, so check
the list before retrying rather than assuming nothing changed.
New personas may appear in Group choices while that template save is pending;
availability there does not confirm that a reusable template was saved.
On updated servers, each custom save and its reusable-template attempt finish
in order. Template persistence can still fail independently; its warning does
not undo an accepted custom save.

**Save as Template** saves a reusable entry without starting a model. A failed
disk write leaves the previously saved configuration and templates intact.
Failed deletions show a warning. If deletion cannot be confirmed, copy unsaved
edits, refresh the page, and check the saved-template list before retrying.
If a refresh fails, the displayed entries can be from the last successful load;
wait for the server to recover and refresh again before retrying a change.

If a save finishes while you edit another persona, your newer form stays open.
Custom saves from one panel are sent in order, using the values captured when
you pressed Save. Once a queued save begins checking or writing settings, it
stops waiting after 15 seconds, including reading the response. A timeout does
not prove that the server rejected the write: keep the draft and check saved settings before
retrying. Servers that support conditional saves reject conflicting writes;
the draft stays open for you to review and explicitly save again. With an older
server, an uncertain write blocks further custom saves in that panel. Copy
important edits and reload the page before retrying.
Deleting a saved, active persona also disables that persona. If the same persona
was saved again while deletion was pending, the app keeps the newer settings and
asks you to reload the page before retrying.

Saved templates retain the **Thinking** override: **On**, **Off**, or the model
default. Older templates without an override use the model default. The pinned
[template request contract](https://github.com/nerdrx/novum-xenium/blob/a05e88ec77cd9d0ed88c5fe5fa5d3ffb44adb2aa/routes/preset_routes.py)
and [preset persistence](https://github.com/nerdrx/novum-xenium/blob/a05e88ec77cd9d0ed88c5fe5fa5d3ffb44adb2aa/src/preset_manager.py)
describe these save boundaries.

## Unsent drafts

Ordinary composer text is saved separately from sent chat history and restored
when you return to its chat. Drafts are kept in browser storage with bounded
size/count limits; on storage failure or when a draft exceeds those limits,
Novum warns that it will remain available only while the page stays open.

If authentication is anonymous or temporarily unavailable, a pending new-chat
draft stays in this page's memory. Browser Back to that pending chat restores
its text and selected model metadata in the same page, but this page-only draft
does not survive reload. After authentication verifies the same user, an
eligible non-incognito pending draft can be adopted into that account's draft
storage. Incognito/Nobody drafts remain page-only and are not adopted into
account storage; if the account changes, page-owned drafts are not restored
under the new identity.

Attachments, including voice-recording fallback files, are not included in the
saved plain-text draft. If the app shows a draft-storage warning, keep the page
open and copy important text before navigating or reloading.

For microphone access and recording recovery, see [Chat microphone](media.md#chat-microphone). The pinned [session draft handling](https://github.com/nerdrx/novum-xenium/blob/d5864db488ce762a670e27080bfb357a67e76980/static/js/sessions.js) and [draft storage](https://github.com/nerdrx/novum-xenium/blob/d5864db488ce762a670e27080bfb357a67e76980/static/js/composerDrafts.js) show the implementation for this release.

## Models and context

The model picker groups providers, supports searching model names, and labels availability from provider evidence. An unknown state does not mean the model is ready. Start with a short prompt to confirm the selected route.

After an agent reply, open the context indicator in the chat header to inspect the latest assembled request. It estimates instructions, tools, memory/documents, conversation, tool outputs, output reserve, and trimmed tokens. The estimate can differ from provider tokenization. Long tool results may be archived separately and retrieved by search or exact chunk; they do not consume prompt tokens until retrieved. Retrieval does not increase the model's context window or guarantee lossless recall. See [workflow limits](https://github.com/nerdrx/novum-xenium/blob/main/docs/nx-workflows.md#longer-agent-chats).

## Files and project guidance

Files in the standard Docker workspace persist at `data/agent_workspace/workspace/` on the host and appear as `/workspace` in the app container. Agent file tools and repository shell commands may have different boundaries; select a workspace deliberately.

Each browser tab keeps its own active workspace. Changing a folder in another
tab does not retarget this tab's later chat or group requests. Newly opened
tabs remember the last saved browser preference; open tabs keep their current
selection. After an update, reload all open Novum tabs before relying on this
behavior.

Saved workspace choices are restored after the app verifies the current
account. If verification fails, retry when the connection recovers; if your
account changed, reload before selecting a workspace or sending a message.

Paths entered with `/workspace <path>` are checked by the backend before they
are saved. A pending check must not replace a folder you select or clear later in this tab;
the latest selection takes priority. An invalid path leaves the existing
selection in place.

A fresh browser uses the backend's explicitly configured default when one is
available. Otherwise, choose a folder to set an explicit workspace; the UI
does not assume that a host has a `/workspace` directory. Clearing a saved
selection leaves it cleared in this tab.

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
