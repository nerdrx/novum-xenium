# Workspace and agent task controls

- **Agent tasks** replaces the existing Subagents panel. It combines delegated tasks and recent runs, with search and Running / Waiting / Failed / Finished filters. Open chat reviews a stopped or waiting task; Resume stream reattaches only when the server still owns an active run. Refresh the repository in Modules and update Subagents to 1.1.0, then enable the reviewed `subagents` and `runs` permissions.
- **Workspace > Find a file in this folder** searches visible filenames and downloads results. Search is bounded to 20,000 entries and 100 matches. It does not read file contents or follow links. These controls require an interactive administrator session.
- **Workspace > Project tools > Project preferences** saves a preferred model, chat mode, tool guidance and project instructions. Starting a project chat preserves the chosen workspace and refuses to discard a draft. Guidance is advisory; it does not grant tools or change approvals. Existing verification checks are preserved.

Existing diff/Undo controls and Gallery search are retained.

Validation: focused module, project-workflow and workspace-search tests, plus headless browser checks of the actual task panel, project panel and mobile workspace drawer. Browser fixtures verify UI behavior independently from live model generation.
