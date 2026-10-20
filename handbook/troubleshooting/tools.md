# Troubleshooting tools and stopped runs

Check the selected mode, enabled tools, account role, and connection status
before changing configuration. A tool may be intentionally unavailable.

## A tool is missing

1. Choose **Agent** mode. **Chat** answers without the agent tool workflow.
2. Check the tool's switch in the composer and the tool's state in Settings.
3. Check required access: MCP tools require an administrator-configured,
   connected server and are restricted to admin users. Modules and connected
   services have separate permissions.
4. Check whether the feature is supported in this platform. Host process
   controls require the native desktop bridge; a browser client cannot control
   local host processes.
5. If it remains absent, note the platform, selected mode, and tool name. Do
   not turn off containment or approvals to make it appear.

For read-only repository inspection, choose **More tools → Plan mode**. Plan
mode stays read-only regardless of approval settings.

## Approval is pending or a tool is blocked

Read the exact operation, target, and command in the approval card. Approve
only an action that matches your intent and workspace. Decline anything you
do not recognize; ask for a narrower explanation or action. The
`ODYSSEUS_TOOL_APPROVAL_GATE` setting is enabled by default and should stay
enabled. A pending approval is a safety boundary, not a service failure.

An **Access denied** result from the task manager concerns access to that
target; it does not mean the task tool is missing. Confirm the signed-in
account and intended task. Novum's automatic recovery must not repeat that
denied operation or replace its explanation with a missing-tool correction.

If an MCP server shows disconnected or `needs_auth`, open **Settings →
Integrations → MCP**, reconnect or complete authorization, then retry once.
Startup times out an individual MCP server after 20 seconds; other servers
continue. Check server status and logs before changing transport settings.

## A command failed

### The model returned an invalid tool request

A missing tool argument is different from a denied permission. Novum rejects
the invalid batch before running any of its calls and gives the model up to
two correction attempts. For an offered tool with a missing required field,
the retry names that field, such as `read_file` requiring `path`. It does not
enable a disabled tool or approve an action. Read-only requests should not be
turned into file-writing work to repair an invalid read call.

If correction still fails, inspect the last completed result before retrying
the task. Earlier rounds may already have changed files or external services;
the rejected batch itself was not executed.

### A tool ran and returned an error

Read its exit status and output. Confirm the active shell boundary: the main
application container, optional separate executor, and native desktop bridge
have different filesystems and environment. A file visible to one may not be
available to another. Inspect the target path before repeating the command.
Do not add broader permissions just to bypass an unexplained error.

A valid batch can succeed partly before a later tool returns an error.
Inspect each result before retrying; completed actions are not rolled back.

If the failure says containment is unavailable, the Docker runtime could not
create required private filesystem or PID namespaces. Check supported host
security policy and use the documented setup. Do not enable privileged mode
or unconfined seccomp as a workaround. See [native Docker containment](https://github.com/nerdrx/novum-xenium/blob/main/docs/native-containment-docker.md).

## A session or run appears stuck

1. Check whether the app is waiting for an approval card or external service.
2. Read the last completed tool result and the session status.
3. For a slow saved-session list or body load, current builds stop waiting
   after 15 seconds while preserving the draft/list and offer a manual retry.
   Retry once after checking the network and backend state.
4. For a running agent, use **Stop** once and wait for the status to update.
   Stop cancels app-owned foreground process groups, background jobs, and
   tracked persistent tmux commands. It cannot undo completed file writes,
   email, uploads, API calls, or database changes; detached processes may
   outlive it.
5. Before **Continue**, inspect changed files, external state, and the last
   completed action. Re-run acceptance checks after any later edit.

Current chat streaming checks the specific session after inactivity; this is
diagnostic and does not send the prompt again. Older builds may not include
these timeouts. See the current [chat implementation](https://github.com/nerdrx/novum-xenium/blob/main/static/js/chat.js).

## The run paused or scheduled work did not happen

Open the task's recent run record. Resolve the displayed permission request,
connection failure, or schedule delay before retrying. Check whether the
external action already succeeded; repeated email or API actions can create
duplicates. Correct the original task rather than making a copy. See [Tasks
and notifications](../tasks.md).
