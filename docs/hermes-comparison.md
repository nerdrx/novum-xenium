# Hermes-inspired improvements in NX Odysseus

Compared on October 7, 2026 against [Hermes Agent](https://github.com/NousResearch/hermes-agent), its [skills documentation](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills/) and [memory documentation](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory/). This is a feature comparison and a native Odysseus implementation. Hermes is not a runtime dependency, and no Hermes code or bundled skills were imported.

| Capability | Hermes pattern | Existing Odysseus capability | Result in this update |
| --- | --- | --- | --- |
| Reusable procedures | Discover skills from metadata, load procedures and references when needed | SKILL.md registry, references, search and automatic matching; matching also injected procedures into the prompt | Skill discovery now contains bounded metadata. Full procedures enter context only after `manage_skills` view/view_ref. Each discovery index is capped at 4,000 characters; omitted skills remain searchable. |
| Tool loading | Load capabilities when the workflow needs them | Tool selection plus skill-declared requirements | Matching a skill no longer preloads all its declared tool schemas. A successful skill read activates its known, enabled requirements for the next round; schema budgeting preserves those activated tools. Existing disabled-tool policies still apply. |
| Learning from work | Save and maintain reusable lessons | Background skill extraction, manual tests, audit/self-edit/teacher loop | Extraction now honors the account's publication confidence threshold. Invalid/non-finite scores are rejected; valid lower-confidence entries remain drafts. Draft discovery no longer calls those methods authoritative or proven. |
| Usage tracking | Track procedural reuse | Skill use counters | A suggestion no longer counts as a use. A successful agent read of the procedure increments its counter. A read is not proof of execution or success. Existing counters are retained. |
| Recall across chats | Search earlier sessions when needed | Owner-scoped transcript search with nearby context | `search_chats` retains up to three distinct matching messages per chat, with message IDs, timestamps and bounded neighboring excerpts. Chat-title links remain clickable. |
| Personal memory | Persistent curated user facts and recall | Brain memory, pinned facts, retrieval, editing and consolidation | Retained existing implementation; this update does not add a second store or auto-write new user facts. |
| Scheduling | Unattended recurring tasks | Server task scheduler, scheduled AI jobs and event triggers | Retained existing implementation. No second scheduler or background service. |
| Delegation | Isolated subagents | Session delegation and coordinated group task boards | Existing workflows remain; this update does not claim isolated Hermes-style worker environments. |

## Using the improvements

Use Agent mode with Skills enabled in Brain. The assistant sees skill names/descriptions and can open a relevant procedure with `manage_skills` action `view`, then read a reference with `view_ref` when necessary. You can inspect drafts and use the existing skill testing/audit controls in Brain → Skills.

The existing Auto-approve skills setting still controls publication. Confidence must also meet your account's configured threshold, falling back to the global `skill_autosave_min_confidence` value (default 0.85). An explicit zero threshold remains supported, while the existing extraction floor of 0.6 still applies. If preferences cannot be read, the extracted entry stays a draft. Confidence is a model estimate, not a successful test result.

Ask the agent to find a past discussion to use `search_chats`. Results can include several evidence messages from one chat rather than silently discarding all but its first match. IDs and timestamps identify the source; neighboring text is bounded and should not be mistaken for the entire transcript. Owner boundaries remain enforced by the search engine.

No additional provider, login, service, model download or Docker configuration is required. The normal build command remains `docker compose up -d --build`.

## Validation and limits

208 focused checks passed in a network-disabled container with a read-only source mount and temporary data. Coverage includes owner boundaries, on-demand procedure reads and counters, disabled skill tools, bounded discovery, malformed confidence, per-user publication thresholds, multiple transcript matches and native tool activation across fallback rounds. Provider responses in the agent-loop checks are fixtures.

A synthetic saved skill containing a long procedure reduced the skill-related prompt context from 11,710 to 948 characters (91.9%). Both prompts were assembled from the production code against the same fixture; the full procedure remained available by explicit read. This measures context size, not intelligence, model throughput or task success.

The wider foreground-routing suite had eleven failures on the previous commit, reproduced using its original agent-loop and test files. This update fixes its skill-activation/schema-budget failure. Ten unrelated existing failures remain in older error-message and context-budget assertions; the wider suite is not fully green. Those failures are reported separately from the 208 passing focused checks.
