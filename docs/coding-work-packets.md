# Coding work packets

A coding agent can attach an optional `work_packet` to `todowrite` to describe
one small change. The existing checklist interface still works without it.
The packet contains `objective`, project-relative `files`, an exact single-line
`reproduce_command`, an exact `acceptance_command`, and `acceptance_condition`.
These are untrusted task data and grant no tool permissions.

The current run tracks actual tool results through `reproduce`, `edit`,
`verify`, and `done`. A reproduction may fail: its real exit status is the
baseline evidence. Approval requests and blocked or pending calls do not count.
Before reproduction, file edits and unrelated executable actions are blocked.
After a successful file-tool edit, only a successful exact acceptance command
marks the slice done. Later edits or shell actions invalidate that pass.
An unfinished packet cannot be replaced by another checklist write.

The stream emits `coding_work_packet` events with packet, stage, `test_status`,
and `review_status`. A passing command reports `test_status: passed` and
`review_status: not_reviewed`; it never impersonates an independent review or
certifies all requested functionality. The existing completion reviewer still
runs independently when enabled.

Evidence is currently local to one agent run. Checklist storage deliberately
does not persist executable commands or restore prior test passes. The packet
mechanism starts a fresh model context at each accepted packet: it retains human
instructions and trusted system constraints, drops earlier assistant/tool chatter,
and preserves complete new tool-call/result pairs. Saved conversation history is
unchanged. Compacted-away boundaries fail open to the original context rather
than guessing which history to discard. Relevant skill metadata remains available;
the full skill catalog is replaced by on-demand discovery in packet context.

A run-scoped status card shows the objective, stage, test status, and review status.
Reconnect replay can restore this card; saved history does not yet persist it.
Automatic milestone scheduling and cross-run packet continuation remain work.
