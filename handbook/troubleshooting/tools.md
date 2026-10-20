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

For chat-to-chat messages, list the visible chats and use the exact returned
ID. A `not found` or `could not be loaded` lookup error means that tool attempt
did not send a new message. Check the selected chat and account access before
retrying; a lookup failure does not grant access to another user's chat.

If the host-shell bridge returns a result without `exit_code` or `returncode`,
Novum cannot confirm command completion. Inspect the workspace and bridge
connection before retrying, since the command may already have changed files.
Reconnect the TUI bridge if needed; an empty reply is not a successful result.
A background-job acknowledgement with a `job_id` still needs polling to obtain
the completed result. It does not prove that the command finished successfully.

A malformed file-edit or patch bridge reply does not establish whether changes
were applied. Inspect affected files before retrying; approval does not guarantee
successful completion.

For a constrained project search, give a command such as
`find . -maxdepth 2 -name package.json` and check that the tool result uses it.
A supplied host-shell project search is not replaced with the generic project
inventory; automatic inventory remains available as a recovery fallback.

For repository tests, give an exact command when the target or selector matters,
for example `Run pytest tests/test_parser.py -m 'not integration'`. Check the
reported command and exit status. A full-suite run does not satisfy a request
that excludes integration tests; ask Novum to inspect the project's test
configuration if the correct command is unclear.

For host-shell coding runs, a supplied Node, unittest, or package-manager
test command is not replaced with pytest merely because it uses a different
runner. Pytest interpreter selection preserves the supplied targets,
selectors, timeout, and other call options. If no command is supplied, the
automatic runner probe prefers a package's npm test script over a generic
`tests/` directory, while a root `pyproject.toml` or `pytest.ini` takes priority.
Use `Run all tests`, `Run every test`, or `Run the full test suite` for the full suite
instead of changed-file selection; give the exact command when scope matters.

If the model omits a tool call, automatic test recovery preserves supported
exact test commands, including Node, unittest, and package-manager commands.
A recognized but malformed, compound, or multiline command does not become a
generic suite run. Help and collection requests do not count as running tests.
Requests such as `Run tests, but not all tests` need a precise command or
selector before automatic recovery can choose a suite.

For inspection without execution, use **Plan mode**. A request such as
`Do not run tests; just read main.py` suppresses the automatic test fallback,
but text instructions do not replace read-only permissions. Inspect any
model-proposed command and its approval card before allowing it. A command
printed in a response, a help screen, or test collection alone is not proof
that tests ran successfully.

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
