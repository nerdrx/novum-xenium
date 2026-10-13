# Milestone workflow implementation and evaluation

Audit date: 2026-10-13. This records the optional checked coding workflow and its
validation boundaries. It does not certify general model reliability or completion
of the original full-featured FFmpeg application. No new tests or live trials were
run for this document.

## Requirement coverage

| Requirement | Implementation | Focused regression coverage | Recorded live evidence and limit |
| --- | --- | --- | --- |
| Compact repository context | `src/repository_context.py`, integrated by `src/project_workflows.py`: bounded file/symbol map, private/generated paths excluded, untrusted context | `tests/test_repository_context.py`, `tests/test_repository_prompt.py` | Small workspace trials below exercise coding integration; they do not establish large-repository navigation quality. |
| On-demand skills | `src/agent_loop.py`: skill index, `manage_skills` reads, bounded references; fresh packet context replaces full catalog with discovery | `tests/test_agent_design_skills.py`, `tests/test_agent_coding_grounding.py`, `tests/test_coding_grounding_resume.py` | [Approval recovery](evaluations/coding-grounding-resume-20261013.json) follows research recovery changes. Source/skill success is never inferred from a skipped lookup. |
| Fresh reproduce/edit/test work packets | `src/coding_work_packet.py`, `src/agent_loop.py`: scoped packet, fresh model context, real baseline, file edit, exact acceptance; deterministic registered checks; phase schemas match dispatch policy | `tests/test_coding_work_packet.py`, `tests/test_agent_coding_work_packet.py`, `tests/test_todowrite_work_packet.py` | [Phase-schema trial](evaluations/coding-phase-schemas-20261013.json) completed both milestones and external acceptance. Earlier output-correct but internally incomplete runs remain recorded. |
| Distinct completion reviewer | `src/agent_loop.py::_run_verifier_subagent`, `src/completion_verification.py`: separate same-model request and strict verdict; unavailable evidence cannot pass | `tests/test_completion_verification.py`, `tests/test_agent_project_verification.py`, `tests/test_agent_coding_work_packet.py` | Phase-schema trial passed the review gate. A test pass alone stays `not_reviewed` when the optional reviewer is disabled; separate context is not a guarantee of independent correctness. |
| Targeted research | `src/coding_grounding.py`: bounded local/documentation lookup, successful source evidence, relevant skills, explicit uncertainty fallback; exact approval restoration binds owner/chat/origin/workspace | `tests/test_coding_grounding.py`, `tests/test_agent_coding_grounding.py`, `tests/test_coding_grounding_resume.py` | [Targeted research trial](evaluations/coding-targeted-research-20261013.json) fetched official Python documentation and repaired `urlencode` sequence handling (`doseq`). It was a separate same-model trial, not an Aider comparison or causal proof of learning; reviewer disabled. Controlled comparisons disable web for both agents. |
| Existing default experience retained | `agent_milestone_workflow` defaults off; packet/check/status integration remains optional; existing permissions, approval, execution budgets and history apply | `tests/test_agent_coding_work_packet.py`, `tests/test_coding_work_packet_ui_js.py` | Trial workflow settings were restored. See [packet behavior](coding-work-packets.md) for recovery and UI limits. |
| Fair same-model comparison | `scripts/coding_agent_comparison.py` and bundled Novum/Aider adapters: separate identical fixtures, declared shared endpoint/settings, fixed external checks | `tests/test_coding_agent_comparison.py`, `tests/test_coding_comparison_aider.py`, `tests/test_coding_comparison_novum.py` | Phase-schema trial used `qwen3.5:9b`; both passed the small multifile fixture. Agent prompts/context/edit protocols differ. |

The phase-schema change's recorded focused run passed **72 tests** across
`test_agent_coding_work_packet.py`, `test_agent_coding_grounding.py`, and
`test_coding_grounding_resume.py` in a disposable container. Other test paths
above identify coverage, not newly claimed executions or a fresh full-suite run.
The executed command was:

```sh
rtk docker run --rm --network none -e ODYSSEUS_RUN_CHECKPOINTS_DB=/tmp/test-run-checkpoints.db -v /run/media/nerdrx/Lex/novum-xenium:/workspace:ro -w /workspace --entrypoint python odysseus-local-odysseus -m pytest -q -p no:cacheprovider --basetemp=/tmp/nx-phase-schemas3 tests/test_agent_coding_work_packet.py tests/test_agent_coding_grounding.py tests/test_coding_grounding_resume.py
```

## Outcome evidence

- [Phase-schema comparison](evaluations/coding-phase-schemas-20261013.json):
  Novum completed its internal milestones, test and review gates, and fixed external
  acceptance; Aider also passed. This Aider-first trial took 112.072 seconds for
  Novum and 6.525 seconds for Aider. It supports working completion in one small
  trial, not improved speed or a reliable success rate.
- [Earlier registered-check comparisons](evaluations/coding-registered-checks-comparison-20261013.json):
  both orders passed external acceptance, but one Novum run lacked internal
  completion. Older raw reports leave intervention fields null/unrecorded; that
  is not evidence of zero intervention.
- [Fixed GUI evaluation](evaluations/coding-fixed-gui-check-20261013.json):
  autonomous same-model repair failed. Model edits repaired an import and a
  button identifier, but the output filename contract remained wrong. Preserved
  pre-run test bytes also failed the separate headless check. No operator app
  edits supplied a passing implementation.
- [Assisted GUI follow-up](evaluations/coding-assisted-contract-20261013.json):
  one operator diagnostic intervention guided IPC-field inspection; the model
  produced a valid 5.000-second video. The unchanged external test still failed
  because Start remained disabled, and the run timed out. This is assisted partial
  conversion, not autonomous GUI completion or a controlled Aider comparison.

The [second assisted recovery trial](evaluations/coding-assisted-recovery-20261013.json)
passed the preserved external GUI test: actual 5.000-second H.264/AAC output,
no page errors, and Start restored. The model run itself timed out at 300 seconds;
no internal completion or independent review pass is claimed for that run. Two
operator diagnostic interventions were used across the assisted sequence; no
operator edited application code. This proves one conversion interaction, not
progress reporting, cancellation, repeat conversions, attractive design, or the
original full-featured application. Intermediate test edits remain instruction
violations even when final test bytes are restored.

## Runtime and delivery boundary

Canonical changes live in `/run/media/nerdrx/Lex/novum-xenium`; the customized
runtime remains `/run/media/nerdrx/Lex/Odysseus`. The recorded phase-schema
Python deployment is `6d59181`; its documentation followed in `1657b5d` and
subsequent evidence commits. Deployment used runtime backups and in-place updates,
with two all-idle checks covering 103 chats before backend restart, as recorded in
[the comparison notes](coding-agent-comparison.md). Trial settings were restored;
user chats were preserved. This audit did not restart services or inspect live chats.

The requested platform mechanisms are implemented and the bounded comparison is
recorded. Autonomous GUI completion remains unproven; the assisted conversion pass does
not establish dependable general app generation or prove another framework
feature is required. Preserve this
separation when reporting completion, pushing new evidence, or deciding further work.

## Final helper verification

The preview status correction (`85e1707`) passed 11 Node tests and a real
headless run against the same preserved checker. It now reports
`rendered; workspace test completed`; the test and output remain separate from
agent completion and review. Image `37cd19b69d33` includes the correction. The
standalone helper was updated without a backend restart. The live report is
recorded under `preview_status_recheck` in the assisted recovery evidence.

## Simpler defaults and realistic comparison

Coding now defaults to one concrete change and one real test. Inspection, editing,
and testing share one checklist item; separate milestones are reserved for distinct
outcomes. This applies to checked coding (`d32ae63`, 72 focused tests) and ordinary
coding (`4d9694b`, 41 focused tests). The Aider evaluation adapter can explicitly
run an operator-supplied test command with automatic feedback (`1520b36`, 10 tests).

The [real GUI comparison](evaluations/coding-real-gui-comparison-20261013.json)
used separate byte-identical broken copies, qwen3.5:9b, the same task/source-file
list, and an independently preserved GUI checker. Neither received diagnostic
coaching or operator application edits. Aider ran first with automatic test feedback,
then Novum with checked coding enabled; settings were restored afterward.

- Aider: 439.264 seconds; produced a video but failed Start-button recovery after
  three edit/test attempts. Adapter exit zero did not mean acceptance passed.
- Novum: 102.657 seconds, 11 model rounds; inspected files then asked whether to
  proceed with already-authorized analysis. Adapter reported incomplete; the
  external conversion check timed out. This was not a token/time-budget exhaustion.
- Protected test/input files matched their original hashes at the end. This does
  not prove there were no temporary edits. Internal prompts and editing protocols
  differ; one case/order is not a general benchmark.

Aider made more progress here, but neither completed the task autonomously. This
does not justify adding a second production coding backend yet. Retain the simpler
defaults and the fixed acceptance test; do not count retries or prompted recovery
as an autonomous success. No generated application source was manually repaired.

The ordinary-coding default was deployed with two authenticated all-idle checks
covering 101 chats, a runtime backup, and an in-place update preserving customized
files. The running source matches canonical `4d9694b`; the app returned HTTP 200
after restart. The checked-mode default was already deployed before this trial.

## Inspection-stop audit and repair scope

The Novum checkpoint confirms the research gate opened after one successful read
of each required skill. Later source reads succeeded; no edit or test was attempted.
The final question requested permission to inspect a test script it had already
read. This is not evidence of a stuck gate, exhausted budget, or missing tools.

One unnecessary preparation requirement was corrected: when a repair explicitly
says not to change styling, the built-in design/verification pair requires only
visual verification. Skill suggestions remain available, and an explicit request
for `ui-design` retains both procedures. This narrowly recognizes the supported
English no-styling phrases; it is not a general semantic scope classifier.
72 focused grounding, resume, integration, and design tests passed. This change
reduces preparation overhead; it does not demonstrate recovery from the model's
inspection loop or successful autonomous GUI repair.

## Clarification guidance follow-up

`088a600` aligned the catalog, native schema, and prompt descriptions for `ask_user`.
They now explicitly distinguish genuinely missing information from permission to
inspect files, run checks, or continue already-authorized work. Dedicated approvals
remain unchanged. Ten focused tests passed. Three runtime files were backed up and
updated after two all-idle checks covering 100 chats. Runtime source parity was
confirmed; image `77a47decc2c8` includes the change.

The [fresh same-model trial](evaluations/coding-clarification-guidance-20261013.json)
used the original task, broken baseline, and preserved GUI checker. It ended
incomplete after 43.538 seconds: the model identified likely bugs but asked whether
to test first or repair directly. It made no edits and executed no test. The external
check failed. No operator coaching or application edits occurred; settings were
restored. Thus this guidance alignment did not solve the redundant-question failure
in the observed run. Do not present the passing guidance tests as model success.

## Effective workflow state and bounded execution

Startup telemetry now records requested and effective checked-mode state before
a packet exists; the comparison adapter retains these booleans. The initial
implementation passed 53 tests plus 10 subtests, but the live route filtered out
the event. The route forwarding allowlist and route-level regression test were
corrected afterward. This is an evidence fix, not a model-behavior change.

The [diagnostic GUI run](evaluations/coding-workflow-state-20261013.json) confirmed
checked mode through its saved enabled packet. The model registered a work item,
edited the application, and produced a video without operator coaching. It failed
the final Start-recovery assertion and reached the 600-second limit. Only the owned
QA run was stopped. Protected test/input hashes matched; the original setting was
restored. No autonomous completion is claimed. The differing progress in these
single runs is not evidence that telemetry made the model better.

## Focused recovery of the remaining button defect

The [focused follow-up](evaluations/coding-focused-recovery-20261013.json) copied
the latest model-produced application, preserving its successful conversion work.
The same qwen3.5:9b model received the known failing assertion, a diagnosis-first
request, and a two-attempt limit. This is assisted recovery, not an autonomous
retest of the original broad task. No operator edited application code.

The model registered a packet and attempted repairs, but the independent GUI check
still failed Start recovery. The operator stopped only this QA run after repeated
failures, at about 163 seconds. The two-attempt instruction was not a hard cap:
three post-edit checks had completed before the observation and stop. Protected
test/input hashes matched and the original workflow setting was restored.

Startup `coding_workflow` events now reached the adapter with requested=true and
enabled=true, verifying the route forwarding fix live. The focused repair itself
failed; no repeated-success or broader reliability claim is supported. Further
identical retries without a new diagnosis would not provide useful evidence.

## Enforced acceptance retry boundary

Checked coding now stops after two consecutive failed registered acceptance checks
after an edit. Initial reproduction failures, blocked calls, and approval requests
do not consume this allowance. A successful acceptance check resets the counter;
editing or revising a packet does not. The saved counter survives checkpoint
restoration. This does not limit arbitrary inspection calls or replace other
execution/approval boundaries.

The server stops queued later tool calls in the same batch, preserves work and
evidence, and emits `coding_acceptance_retry_limit` instead of completion.
79 focused tracker/integration tests passed, including a batch containing a failed
check followed by a third edit. Restored exhausted-state behavior and tracker
checkpoint roundtrip were tested separately; this is not an end-to-end approval
database recovery test. Deployment used backups and two all-idle checks covering
101 chats. Image `4359161e5a64` includes the change.

The [same-model live follow-up](evaluations/coding-enforced-retry-20261013.json)
retained the existing application and registered one failed acceptance check.
Its 300-second harness deadline arrived before a second failure, so the live run
did not exercise the retry-stop branch. The external GUI check still failed.
The focused automated tests establish the boundary; this trial does not establish
autonomous repair success. Original settings were restored and protected hashes
matched. No generated application source was manually repaired.

### Explicit stopped-run continuation and live retry boundary

Stopped runs now support the existing explicit checkpoint Continue path. Recovery remains owner/session scoped, one-shot, and never automatically replays tools or approvals. The UI describes saved progress rather than implying every recoverable run crashed. All 53 checkpoint and recovery-route tests pass, including preserved counters of one and two failed checks.

The stopped qwen3.5:9b GUI evaluation was continued in the same session/workspace. Its saved counter of one survived recovery and a fresh task-scoped approval. The model reran the registered check; it failed with `Start must recover after completion`, raising the counter to two. The run emitted `coding_acceptance_retry_limit` and stopped. The independent headless GUI check also failed; protected checker, wrapper, and fixture hashes were unchanged. No operator app edits or additional diagnostic coaching occurred. This validates the live retry boundary, not model repair success. Repeated checks count even without an intervening edit.

Evidence: `docs/evaluations/coding-stopped-resume-20261013.json`.

### Causal debugging prompt probe and runtime control evidence

The same qwen3.5:9b model received a bounded repair prompt requiring every control-state assignment and asynchronous caller/completion order to be traced before editing. Starting from the preserved failed app, it still produced one failed acceptance check and reached the 300-second harness deadline. The external GUI check failed at the same Start recovery assertion; protected files were unchanged. This coached probe does not establish an improvement. Evidence: `docs/evaluations/coding-causal-diagnosis-20261013.json`.

The preview helper now records a bounded, passive control timeline during workspace tests: initial disabled states, clicks, and disabled/aria-disabled mutations. It does not patch application setters or modify application source. Same-batch mutation order is reconstructed from old values; timestamps indicate observation, not exact write time. Failure output leads with the assertion and a compact recent timeline; the detailed local report retains up to 40 entries. No input values or visible text are collected by this additional recorder. A live isolated GUI conversion captured Start becoming disabled and the unchanged failure; 12 helper tests passed. Evidence: `docs/evaluations/gui-control-timeline-20261013.json`. This validates diagnostics, not model repair capability.

The matched follow-up used byte-identical starting files, fixture, wrapper, checker, and task prompt with the same qwen3.5:9b model. With the new helper diagnostics, the model completed in 286.557 seconds; its registered acceptance check and the independent fixed GUI check both passed. The failed-check counter reset after the successful check. Protected final hashes matched. No operator app edits or mid-run diagnostic coaching were supplied; the harness approved one exact task-scoped card. This is a verified success on one bounded GUI repair, not proof the diagnostic change caused the success or that full application development is reliable. Evidence: `docs/evaluations/coding-control-evidence-20261013.json`.

#### Follow-up correction: passing Start check masked a regression

Independent source review and a new completion-contract test invalidated the repair as a whole: the model removed the successful settlement of the main-process promise. The completion event and video still occurred, but the renderer's awaited invoke remained pending after five seconds. The prior two GUI passes remain accurate results for their limited assertions; they do not establish a sound repair. The broader acceptance case must cover promise settlement, failure, cancellation, and repeat use before this app is accepted.

### Broader flow acceptance and a second task

The new full-flow checker (`fixtures/ffmpeg-full-flow.mjs`) rejects unresolved success/failure invokes, disabled Cancel while busy, unhandled UI errors, and failure to repeat conversion after cancellation. It leaves application source untouched, uses real FFmpeg and GUI interactions, and returns failure when any phase fails or cannot safely run. The original generated app fails this stronger contract.

A same-model repair corrected successful and failed request settlement. Independent tests confirmed both, together with the short GUI conversion and basic error controls. Cancellation still failed and repeat conversion was skipped because cancellation was unconfirmed. A subsequent focused cancellation slice exhausted two failed checks, but the independent check confirmed cancellation request settlement and repeat conversion now pass. GUI busy-state controls and unhandled progress/error exceptions still fail. Neither run is a complete app repair; no operator app edits were supplied. Evidence: `coding-full-flow-20261013.json` and `coding-cancel-recovery-20261013.json`.

The separate stdlib progress-parser task (`fixtures/progress-parser`) also failed: the same model described a solution but ended by asking whether to implement the explicitly authorized function. The starter remained unimplemented; all protected test/wrapper hashes matched. Evidence: `coding-progress-parser-20261013.json`. These results do not establish reliable independent coding. The scheduled task remains paused.

A final focused busy-control/buffer-scope slice also exhausted two failed checks. Its independent full-flow run reached the helper's 45-second deadline, so it is not accepted and later phases are unverified. All candidate workspaces remain separate; no candidate application was deployed as a completed product. The earlier cancellation candidate remains evidence of partial progress (six passing phases), not a fully working app. See `coding-final-controls-20261013.json`.

### Diverse small-task evaluation

Three isolated tasks used the same qwen3.5:9b model with the coding workflow enabled. Every starter failed its baseline. The model alone edited solution.py, and independent checks used the original test files outside its workspace. SQLite batch rollback passed five tests in 79.885 seconds; list chunking passed eight tests in 37.736 seconds. Both produced changed source and retained protected test/runner hashes. These are two bounded implementation successes, not evidence of reliable full-app development.

The CSV/Decimal aggregation task stopped after 21.748 seconds with no source edit. The checkpoint shows a successful read of solution.py immediately before asking the user for its path. This is unnecessary clarification despite available evidence, not demonstrated missing tools. No answer or coaching was supplied to rescue the trial. The adapter originally reported generic incomplete status; preserve that raw observation alongside the checkpoint diagnosis. Settings were restored and scheduling remains paused.

Reproducible starters/tests are in `evaluations/fixtures/diverse`; full evidence is `evaluations/coding-diverse-tasks-20261013.json`.

The comparison adapter now reports unresolved clarification as `waiting_user` (non-success exit 2), with redacted event metadata. It does not answer the question or treat it as tool approval. All 17 adapter tests pass, including approval followed by clarification and resolved-card handling. This fixes evaluation reporting; it does not fix the model's unnecessary question or retroactively pass the CSV trial.

### False research gates on small standard-library functions

Two new same-model tasks (bounded retries and stable topological ordering) stopped without edits. Runtime tool logs showed only reading/planning tools, with no registered check action. The substantive-task classifier mistakenly treated “standard library” as dependency integration and the parameter name in `stable_toposort(dependencies)` as a prose dependency request. The research gate consequently withheld the baseline check and editing tools. These failures cannot be attributed solely to the model. Pre-fix evidence: `evaluations/coding-diverse-round2-before-20261013.json`.

Classification now ignores standard-library wording as a dependency cue and simple adjacent function parameter lists, while retaining callable names and surrounding prose. App/GUI requests and actual external library/framework integration still require research. All 34 grounding tests pass; the full original three affected task prompts no longer trigger the gate. Deployment preserved runtime backups and confirmed all 111 chats idle before restart; canonical, runtime, live container and rebuilt image source match. Image: `7139e425c98d`.
