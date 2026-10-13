---
name: ui-design
description: Design and build usable GUI, app, frontend, website, and CSS interfaces from the user's actual brand reference.
version: 1.0.5
category: design
tags: [gui, ui, design, interface, frontend, website, css, theme]
requires_toolsets: [read_file]
status: published
source: taught
---

## When to Use
Build or restyle a graphical application, website, dashboard, or form. Use alongside the visual-verification skill.

## Procedure
1. Read the user's referenced design guide and inspect the existing interface before choosing colors or layout. If browsing is disabled, use local documentation. Never claim to follow a guide you could not read; report that constraint.
2. Identify the main user action and the information needed to perform it. Put that workflow on the first screen. Keep secondary settings nearby; omit promotional hero sections and redundant About cards from working utilities.
3. Extract a small token set: background, foreground, muted text, accent, panel, border, spacing, type scale, corners, and focus ring. Define tokens in one place, then reuse them. Match the guide's current version, including later amendments; do not rely on remembered branding.
4. Define the page's background and foreground in CSS before JavaScript runs. Ensure variables are defined and inherit through the actual document. A script error must not turn a dark interface into white text on a white page.
5. Use one clear primary action, consistent control heights and spacing, readable labels, and restrained emphasis. Prefer existing components and monochrome SVG icons over decorative emoji or new icon libraries. Keep the main controls visible in the supported desktop viewport: use a compact grid for related input, output, and options instead of stacking full-width cards. Put small status values in one row; collapse verbose logs until needed. Leave a short, useful empty state instead of filling the log with an advertised feature list. A browser output destination is a filename or download action, not a file picker that asks the user to select an existing file.
6. Connect controls to real operations through the actual runtime boundary. Browser and renderer code cannot launch local processes directly; use a documented backend or native bridge. Preserve file paths and argument boundaries, track the real operation for cancellation, and validate the output. A progress animation or success message must reflect actual work; disable unavailable actions and explain why. Include usable empty, loading, error, disabled, hover, and keyboard-focus states.
7. Before writing the full interface, sketch the screen's reading order in a few lines: main action, required inputs, options, result, and secondary settings. Choose one layout that fits that workflow; do not add a card for every field. Start with a working vertical slice and render it before expanding the feature set.
8. Review the rendered screen with visual-verification. Ask what draws the eye in the first two seconds, whether that is the user's main task, and whether the next action is obvious. Check hierarchy, density, consistency, and accessibility against the reference. Name each concrete issue, its effect on the user, and the smallest correction. Fix the highest-impact issue and render again.
9. Keep documentation proportional to the working feature set. Promotional images and mockups are optional presentation assets, never substitutes for a screenshot of the running application. Finish and verify the requested workflow before spending time on promotional material.

## Runtime Boundary Check
For desktop or native features, first inspect the actual framework, version, entry points, and runtime security settings; consult that version's official docs before choosing APIs.
For a new application, check the chosen framework's currently supported release and installation requirements in its official documentation or package registry before pinning a version; do not choose an old release from memory. For an existing project, respect its pinned runtime unless an upgrade is needed and validated.
Keep the entry point's module format consistent with its manifest and extension. In CommonJS, `require`, `__dirname`, and `__filename` are already supplied by the module wrapper: do not redeclare them or add `import.meta.url`. Check preload loading separately; do not disable isolation to repair a module-format error. See [Node's module wrapper](https://nodejs.org/api/modules.html#the-module-wrapper) and [Electron's module loading rules](https://www.electronjs.org/docs/latest/tutorial/esm).
In Electron, renderer code follows web rules; with `nodeIntegration: false`, do not call `require`, `child_process`, or filesystem APIs there. Never fall back to renderer Node APIs when isolation blocks them.
If the app needs a native operation, verify a narrow existing preload bridge; otherwise add a minimal `contextBridge` API and validated IPC handler in the main process, then test that bridge before building the full UI.
For process launch, use the supported main-process API with executable and argument array kept separate; preserve cancellation, errors, and completion status.
For a new output destination, use the native save dialog and write to its returned path; use an open dialog only when the user must choose an existing input.
For other frameworks, follow their documented equivalent boundary and file-dialog APIs; if the required bridge is unavailable, report the blocker instead of inventing a renderer workaround.

References: [Electron process model](https://www.electronjs.org/docs/latest/tutorial/process-model), [Electron IPC](https://www.electronjs.org/docs/latest/tutorial/ipc), [Electron context isolation](https://www.electronjs.org/docs/latest/tutorial/context-isolation), [Electron dialog](https://www.electronjs.org/docs/latest/api/dialog), [Node.js child_process.spawn](https://nodejs.org/download/release/latest-jod/docs/api/child_process.html#child_processspawncommand-args-options).

## Pitfalls
- Copying an attractive color palette without checking the actual background, contrast, layout, and control states.
- Inventing unsupported brand rules or mixing dark and light tokens within one window.
- Treating a terminal menu as a requested GUI, or a screenshot as proof that operations work.
- Letting decorative effects compete with the task or animate when reduced motion is requested.

## Verification
- The main workflow works with a real input and produces an observable result.
- The referenced design guide was actually read, or its absence is clearly reported.
- A rendered interface and computed styles agree with the chosen tokens, including before JavaScript initializes.
- Keyboard controls, focus, labels, resize behavior, and error states are checked.

## NX References
When the user requests NX styling, read https://github.com/nerdrx/nx-hub/blob/main/docs/DESIGN.md. The current guide distinguishes flagship dark NX from NX Clear; choose the appropriate ground and follow the relevant section. Dark NX uses true-black ground, violet actions, subordinate cyan signals, system fonts, small angular corners, an 8px spacing rhythm, and opaque structural surfaces. Treat this paragraph as a pointer to the guide, not a complete or permanently current specification.
