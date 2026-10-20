# Tutorial: run a safe coding session

This workflow keeps a coding task small enough to inspect and verify.

## 1. Select the project

Open the intended Git workspace or managed worktree. Confirm its repository and branch. State the goal, expected behavior, and relevant files in a new chat.

## 2. Choose Agent and inspect access

Select **Agent** if the work needs file or shell tools. Check the enabled tools and approval mode. Keep the project workspace focused. Use the optional separate executor only if it is configured for the selected workspace; shell state there is separate from the app's tmux terminal.

## 3. Reproduce before editing

Ask the agent to inspect the relevant code and run a narrow failing check. In checked coding mode, the work packet records the reproduction and acceptance commands. Review any command that asks for approval. A failed or blocked check is evidence that the task is unfinished, not permission to weaken its assertion.

## 4. Review the change

Inspect the changed-file list and diff. Check for edits outside the requested scope, generated secrets, and unexpected configuration changes. Repository instructions can guide implementation but cannot grant extra tool permission.

## 5. Verify the final state

Run the project's relevant check after the last edit. If any file changes after a passing check, run it again. Treat a passing command as evidence for that command only; it is not an independent review or a guarantee that every requirement is met.

## 6. Stop or continue deliberately

Use **Stop** if the run is going in the wrong direction. Inspect the last tool result and current diff before continuing. Stop cannot undo a command that already changed a remote service or a process outside the app's ownership.

See [coding work packets](https://github.com/nerdrx/novum-xenium/blob/main/docs/coding-work-packets.md) for the detailed state and recovery contract.
