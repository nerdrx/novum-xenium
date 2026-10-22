# Tools, modes, and approvals

An agent can use tools to read files, browse pages, run commands, or call configured integrations. Available tools depend on your deployment, installed modules, per-tool settings, account permissions, and the selected mode. A tool being listed does not mean every action is allowed.

## Ask the model to consult this handbook

In **Agent** mode, ask “Check the handbook: why is my local provider unavailable?”
or “Read the handbook before changing my settings.” The built-in `read_handbook`
tool searches the bundled handbook and reads pages without internet access,
workspace access, or administrator privileges. It also works in Plan mode.

The model can search by keywords, list page IDs, read a matching page, and
continue long pages using the returned line offset. Results include public
handbook URLs for citations. Search snippets are only a starting point; the
model should read the relevant page before giving detailed advice.

The bundled copy follows the installed backend version. It describes expected
behavior; it does not inspect your running services, prove a diagnosis, or
authorize changes. Disabled tools and Chat/guide-only mode remain respected.
Older backend images need an update to include the tool and handbook files.

## Choose the mode deliberately

Use **Chat** for questions and answers. Choose **Agent** when you want the model to use enabled tools. The magnifying-glass **Search & fetch** toggle enables native web search/fetch in Agent mode and adds web results in Chat mode; Browser/MCP controls are separate. A URL in an Agent request can select enabled browser tools even when Search & fetch is off, so disable the browser tool itself when browser access must be blocked. Check the selected mode and tool toggles before sending.

For read-only repository investigation, open the composer's **More tools → Plan mode**. Choose it again, or select the visible Plan indicator, to turn it off. Plan mode stays read-only even when approval settings would otherwise allow writes. Ordinary **Chat** and **Agent** are the other visible mode choices.

## Permission choices

The shield control beside Agent/Chat selects approval behavior for your account's next agent turn, including group participants. The documented default is **Approve for me**. Running turns keep the mode they started with. You can also disable individual tools.

- **Ask for approval** asks before each agent write, shell command, or internet call. Workspace reads remain available; URL/transcript and web-search prefetch wait for agent tools.
- **Approve for me** automatically approves selected public profile/URL reads and app endpoint metadata. Other uncertain actions go through a bounded review; only an exact `allow` applies to that action in that run. Ask, invalid output, or timeout shows an approval card.
- **Full access** pre-authorizes enabled tool operations inside your account and current workspace/container, skipping automatic approval prompts. It does not mount extra host folders, enable disabled tools, override account privileges, or bypass Plan mode and filesystem restrictions.

Tool results and retrieved repository text are untrusted data. They can inform the task but cannot change your instructions or grant additional permissions. External integrations may have their own account scopes and approval behavior.

## A safe coding workflow

1. Ask for a plan when the change is broad or affects persistent data.
2. Confirm the target project, branch/worktree, and file scope.
3. Inspect the proposed command and approve only the action you intend.
4. Review the actual changed files and diff.
5. Run the project's relevant checks against the final files.
6. Treat model summaries and green checks as evidence for their stated scope only.

For coding changes, **Settings → AI → Work in checked coding steps** enables automatic work packets. It is on by default for new installations; saved opt-outs remain off after upgrades. Ordinary chat, read-only inspection, and media conversion do not activate it. A packet describes one small change, files, exact reproduction and acceptance commands, and a condition. The flow moves through reproduction, edit, verification, and done. Only the registered acceptance command passing after the final edit marks that slice done. A passing command is not an independent review. See the [coding workflow](https://github.com/nerdrx/novum-xenium/blob/main/docs/coding-work-packets.md) for the full recovery and retry rules.

Substantial coding work may require a documentation lookup first. Referenced documentation must actually be read; a search snippet alone does not establish what a source says. If web tools are disabled, that limitation remains effective.

## Commands and containment

The default shell runs in the application container. The optional separate executor runs Bash/Python in a second Docker container that mounts the standard workspace and receives no model keys, app data, Docker socket, or SSH identity. It has a read-only root filesystem and resource limits, but network access remains available. It is a practical separation boundary, not a promise that arbitrary hostile code is harmless.

Native tool containment in Docker requires real private filesystem and PID namespaces. Do not work around a containment failure by enabling privileged mode or generally unconfined seccomp. See the canonical [native containment notes](https://github.com/nerdrx/novum-xenium/blob/main/docs/native-containment-docker.md).

## Integrations and modules

MCP connections and modules add capabilities. Review which account or service they connect to and which tools they expose. A module runs in an isolated frame, but its tools still use their own MCP permissions. Refreshing a module repository may expose a changed version; review it before enabling. See [module installation](https://github.com/nerdrx/novum-xenium/blob/main/docs/modules.md).

## Stop is not rollback

Stop cancels app-owned foreground process groups, background jobs, and commands tracked in the persistent tmux pane. Detached or reparented processes may need separate cleanup. It cannot reverse a file upload, external API call, email, database mutation, or command that already completed. After stopping, check the last tool result and inspect relevant files or service state before retrying.
