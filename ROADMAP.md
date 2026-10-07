# Where NX Odysseus goes next

The point is to finish useful work without making you babysit the harness.
More features help only when their controls, tools and recovery paths work.
Small tested fixes come first; a new subsystem needs a concrete use case.

## Coding work that finishes

- Keep the tools needed for the current request available within its actual context budget. If the request cannot fit, say which limit blocked it before calling the model.
- Test longer repository tasks through the normal chat routes: inspect, edit, run checks, recover after interruption, review the diff and continue.
- Expand the coding evaluation beyond its three small Python tasks. Keep independent file assertions and record approvals, pauses and failures separately from stream completion.
- Make project checks and worktrees easy to configure. Keep completion tied to reviewed checks rather than an assistant saying “done.”
- Test private repository authentication and publishing with separately configured credentials. A model subscription does not provide GitHub authentication.

## A UI that explains itself

- Clear status for provider calls, queued work, tools, approvals, failed checks and reconnects.
- Native keyboard controls, predictable focus, usable narrow layouts, and popups above the window that opened them.
- Check complete user flows instead of isolated buttons: create a chat, select a provider/workspace, approve a task, inspect its output and find it again.
- Keep error details useful without exposing credentials. Retry should preserve the request and stay in the correct chat.

## Setup and recovery

- Keep the default Docker setup to clone, copy the environment example and run Compose.
- Reduce runtime downloads and unnecessary first-start network work. Optional service failures should be diagnosable without blocking unrelated work.
- Test fresh data, updates, actual restart recovery and moved backups in temporary installations.
- Verify Windows/macOS Docker and native install paths on those platforms. Linux checks alone do not establish cross-platform support.
- Preserve workspace snapshots, ownership boundaries and fail-closed restores. Stop must report its actual cleanup limits.

## Context, recall and skills

- Load procedures and tool schemas when needed. Make capability reports distinguish configured, connected and actually tested.
- Retain source references when summarizing old work; open exact archived chunks or chat messages when the details matter.
- Test long current requests, tool exchanges, large outputs and fallback providers together. Retrieval does not enlarge the model's context window.
- Keep fetched pages, repository instructions, skills and historical text marked as untrusted context.

## Integrations and local models

- Test provider login, refresh, discovery, cancellation and reconnect paths independently from model quality.
- Make image, browser, search, email and notification setup states visible and accurate.
- Improve Cookbook download/serve errors and hardware fit using actual backend constraints. Test hardware-specific claims on that hardware.
- Measure speculative decoding by successful task time and tool correctness, not token speed alone.

## Help wanted

A useful report has the request, selected provider/model, relevant settings,
what happened, and the tool or error output with private information removed.
Say whether a check used real provider replies or fixtures.

The [change record](FORK-CHANGES.md) documents shipped work and its validation.
The [workflow guide](docs/nx-workflows.md) covers current controls and limits.
