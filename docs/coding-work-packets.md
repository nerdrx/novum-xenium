# Coding work packets

A coding agent can attach an optional `work_packet` to `todowrite` to describe
one small change. The existing checklist interface still works without it.
The packet contains `objective`, project-relative `files`, an exact single-line
`reproduce_command`, an exact `acceptance_command`, and `acceptance_condition`.
With an explicit workspace, TodoWrite also accepts absolute file paths inside
that workspace and returns canonical relative paths. Paths outside it, including
symlink escapes and traversal components, are rejected. Submitted approval
arguments and command strings are unchanged; normalization grants no access.
An optional `mode` defaults to `change`. Use `verify_existing` for work already
implemented or a verification-only checklist item: a successful baseline moves
directly to verification, while a failed baseline still requires repair. The
acceptance check must actually run and pass; no edit is invented.
These are untrusted task data and grant no tool permissions.

The current run tracks actual tool results through `reproduce`, `edit`,
`verify`, and `done`. A reproduction may fail: its real exit status is the
baseline evidence. Approval requests and blocked or pending calls do not count.
Before reproduction, file edits and unrelated executable actions are blocked.
In checked mode the edit stage exposes file-edit tools; shell and Python
execution resume after an edit, for verification. Shell edits are not accepted
as packet edit evidence.
After a successful file-tool edit (or a passing `verify_existing` baseline),
only a successful exact acceptance command marks the slice done. Later edits or shell actions invalidate that pass.
An unfinished packet cannot be replaced by another checklist write. After an
acceptance command actually runs and fails, the agent may correct only
`acceptance_command` if the command itself was malformed; all other packet
fields, the acceptance condition, and the current milestone stay fixed. It must
then rerun the registered acceptance check. A real behavior failure requires a
source fix and the same acceptance check; weakening assertions or the pass
condition is not a repair.

In checked mode, `run_coding_check {}` runs the registered command for the current
reproduction or verification stage. It accepts no replacement command and is
exposed only when Bash is available. The resolved command passes through the
normal Bash security, approval, and execution path.
Checked mode schedules the registered baseline before the next model action,
and schedules acceptance after a successful edit or a passing `verify_existing`
baseline. These are server-owned checks through the same dispatcher, not model
calls. Their results remain untrusted tool evidence. They consume execution
budgets but do not consume model turns or invent model token usage.
A failed acceptance check returns control to the model for repair. A blocked
check is not automatically repeated; disabled tools, approvals, and forced stops
remain effective. Failed or blocked checks keep the slice unfinished.

The stream emits `coding_work_packet` events with packet, stage, `test_status`,
and `review_status`. A passing command reports `test_status: passed` and
`review_status: not_reviewed`; it never impersonates an independent review or
certifies all requested functionality. The existing completion reviewer still
runs independently when enabled. A checked run emits an explicit completed
terminal event after all slices pass and no pause, budget stop, or teacher
intervention invalidates that conclusion. The terminal reports
`review_status: passed` when independent review passed, or
`review_status: not_reviewed` when that optional reviewer is disabled; consumers
must keep those outcomes distinct. A closed stream by itself is not completion
evidence.

Server checkpoints preserve bounded packet evidence for the exact owner, chat,
and run. Exact tool approval can restore that evidence; interrupted recovery
reopens a previously completed slice for reproduction and testing. Malformed
evidence resets the slice instead of granting a pass. Ordinary checklist storage
does not supply execution evidence. The packet mechanism starts a fresh model
context at each accepted or restored packet: it retains human
instructions and trusted system constraints, drops earlier assistant/tool chatter,
and preserves complete new tool-call/result pairs. Saved conversation history is
unchanged. Compacted-away boundaries fail open to the original context rather
than guessing which history to discard. Relevant skill metadata remains available;
the full skill catalog is replaced by on-demand discovery in packet context.

A run-scoped status card shows the objective, stage, test status, and review status.
Reconnect replay can restore this card; saved history does not yet persist it.
Settings → AI → Work in checked coding steps enables automatic packet selection
for substantive coding tasks. It defaults off, alongside the existing experience.
In this mode a new slice requires the packet in the same checklist call; a plain
checklist is rejected with instructions to supply it. Existing active slices
can still receive status-only checklist updates.
The agent must retain the checklist item names, finish each slice with a passing
check, and select a new packet for the next slice. A checklist cannot skip an
unverified item merely by marking it complete. A passed slice with unfinished
checklist items is reported as an incomplete task, separately from a slice whose
acceptance check has not passed. Arbitrary new turns do not inherit packet
evidence; continuation requires a scoped approval or recovery checkpoint.
