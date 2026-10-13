---
name: visual-verification
description: Verify GUI, UI, frontend, website, CSS, and theme changes in a real rendered interface, including behavior and accessibility.
version: 1.0.8
category: design
tags: [gui, ui, design, interface, frontend, website, css, theme]
requires_toolsets: [read_file]
status: published
source: taught
---

## When to Use
After implementing or changing a graphical interface, and before claiming it is usable or follows a design guide.

## Procedure
1. Discover the existing app's startup and test commands from its manifests and documentation. Use search_tools to discover available browser navigation, console, DOM, and screenshot tools rather than guessing tool names. Use those tools or a headless browser. For a native app, use a headless display or gamescope when available. The standard Docker image provides xvfb-run for an isolated X display; check its availability and use the actual native application rather than replacing it with static HTML to avoid a display error. Choose a free test port and stop only processes you started; do not disturb user services.
2. Check syntax/build results, then launch the actual interface. Capture page errors and failed requests. A missing script, unresolved asset, or syntax error is a failure even if HTML renders.
3. Inspect computed background, foreground, font, spacing, borders, and control geometry. Check that CSS variables resolve, text is readable, important controls fit their containers, and the viewport has no unintended horizontal overflow.
4. Render at the normal desktop size and a smaller supported window size. Check scrolling, titlebars, dialogs, menus, form labels, and focus outlines. Test the requested theme; do not infer it from a filename or screenshot caption.
5. Use the main controls with a small real input. Verify the resulting file, server response, or saved state through an independent observation. Check failure and cancellation behavior. Printed claims, file listings, fake progress, and a successful build alone do not prove the user action works.
6. Inspect the screenshot when image viewing is available. If the model cannot view images, inspect DOM and computed styles and provide the screenshot for human review; report that visual inspection remains unverified. Never pretend an unseen screenshot was reviewed.
7. Critique the actual rendered screen: does the first visual emphasis identify the main task, is the reading order clear, and can required inputs and the primary action be found without unnecessary scrolling? Compare spacing, typography, icon treatment, and repeated controls with the design guide. Record concrete observed defects and corrections rather than saying the screen looks modern.
8. Repair the highest-impact issue, then immediately rerun that failed path before investigating another suspected cause. A failure report from before your edit describes the old build; it does not prove the same error still occurs. Use the new run's actual error or output to choose the next repair. State the tested behavior and remaining limitations clearly. Share the real application screenshot when possible, with its tested viewport and any unverified interactions; do not replace it with an AI-generated mockup.

## Pitfalls
- Clicking a mocked handler and treating its alert as a successful operation.
- Turning syntax or file-existence checks into a claim of functional correctness.
- Assuming a screenshot proves keyboard access, cancellation, or responsive layout.
- Calling a disabled feature complete because instructions for enabling it were written.

## Native Launch Evidence

Read the manifest before selecting a startup command. An Electron executable is a native binary, not a JavaScript file to pass to `node`; use the installed project-local executable or its actual npm script. Check a headless display is available before launch.

Keep container testing separate from production app configuration. Do not weaken sandboxing, context isolation, Node integration, or enable webviews to work around a test launch failure. Electron documents `--no-sandbox` as testing-only: if an isolated container requires it, pass it only to that test process, with a fresh profile and private display. Do not add it to shipped source or startup defaults, and do not change system ownership or setuid permissions just to run the test.

Record the real launch stderr and verify the owned process has a rendered window or a working automation target. A printed `App started`, an exit code hidden by `|| true`, or an unsuccessful background launch is not evidence. Keep failure output intact, consult the matching framework documentation, and retest the same path after a repair. Preserve existing IPC handlers when changing one native operation; run the previously working checks again after replacing a main-process file.

Reference: [Electron command-line switches](https://www.electronjs.org/docs/latest/api/command-line-switches).

For a Linux Electron workspace, first discover `native_preview` and use it when
available; it runs through the active workspace's authorized Bash execution,
with the same cancellation, timeout, and sandbox. Pass `project_path` relative
to the active workspace (use `.` for its root), and optionally pass an existing
project-relative `test_script`, `timeout` (15–45 seconds), and `no_sandbox`
(only when isolated launch errors require it). If the typed tool is unavailable
in direct-container mode, the equivalent workspace-bound helper is:
`node /app/scripts/electron_preview.mjs --workspace-bound --workspace "$PWD"`.
The helper requires a
workspace-local `node_modules/electron`, runs the real manifest entry under a
private Xvfb display and fresh profile, and saves desktop/compact screenshots,
DOM/style measurements, and runtime diagnostics in a unique run directory under
`.odysseus-preview/`, which it creates a local Git ignore rule for without
overwriting an existing rule. Its fresh browser profile lives in a private OS temporary
directory and is removed after a normal run.
The two sizes use renderer viewport emulation; actual native BrowserWindow bounds
remain unverified.
Set `--test-script relative/path.mjs` only for an existing workspace test module
that exports a default or named `run` function; it receives Playwright's
`{ app: { pid, executablePath, exitCode }, page, context,
artifacts: { outputDir, desktopPath, compactPath } }`. The artifacts fields are
output paths, not input fixtures. Resolve an existing project fixture relative
to the test module with `new URL("../fixture.ext", import.meta.url)` and
`fileURLToPath`, or create a small valid fixture before the run. Throw or use
`node:assert/strict` when the expected result is absent; returning
`{ completion: false }` does not fail the test. It can
exercise renderer interactions and any IPC bridge exposed to the renderer; it
does not receive Electron main-process evaluation access. A missing test script
means behavior was not exercised. Use `--timeout 15..45` (default 35) to stay
within the Bash tool's cancellation window. Electron, Xvfb, and the helper stay
in that invocation's owned process group, while an internal timeout reaps only
its child tree. A hard cancellation may leave only the private temporary profile
for OS cleanup. If observed sandbox startup errors require it, retry with
`--no-sandbox` for this isolated test only; the helper uses a private display and
profile and does not change app defaults. It refuses root-owned workspaces and
confines artifact output and test-script paths to the selected workspace.
Inspect the report and screenshots; if you cannot view the images, say visual
inspection remains unverified.

## Repository Delivery
Before changing `.gitignore`, read and preserve its existing rules; merge new patterns instead of replacing the file. Before committing, inspect the staged paths and diff summary, and remove unintended caches, dependencies, build outputs, or large binaries from the index.

If generated files are already in an unpushed commit, first preserve uncommitted work in a verified file backup or patch and keep a backup ref for the original commits; then correct only the unpushed history. Deleting files in a later commit does not remove their earlier blobs. Do not delete the project as a Git repair shortcut unless the user explicitly requests removal. Read the exact Git error and address that failure; a failed push is not a reason to delete local work or rewrite shared/published history.

## Verification
- No blocking parse, page, startup, or request errors remain in the tested flow.
- Actual inputs and observed outputs prove the main requested behavior.
- Rendered colors and geometry match the requested reference at the tested sizes.
- Keyboard focus is visible, controls have names, and states remain readable.
- The report distinguishes rendered, inspected, exercised, and unverified behavior.
