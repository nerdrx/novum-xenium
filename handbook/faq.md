# Frequently asked questions

## Is the model local because Novum is self-hosted?

No. Novum can connect to hosted providers or local model servers. A hosted model receives the request data sent to it. See [Trust and data boundaries](reference/security.md).

## Do I need to download a model before I start?

No. You can connect a configured hosted provider or an already-running local provider. Local model downloads are separate and depend on the runtime and model format.

## Does zVram add VRAM?

No. It can page eligible Vulkan allocations into system memory on supported setups. This can be slow and does not guarantee a model fits.

## Is AMD support based on ROCm?

The documented Linux image-generation route uses Vulkan. The local zVram path is Vulkan-based too. Do not infer a general ROCm path for other features; check the exact feature's source guide.

## Can I use the same chat from desktop, browser, and phone?

The desktop and browser open the same backend workspace. The Android companion connects to that existing server; it does not run a separate local model.

## What does Full access allow?

It stays within the configured workspace/container. It does not mount extra host folders, enable disabled tools, or override account permissions.

## Does Stop undo what the agent already did?

No. Stop cancels owned processes it tracks. It cannot undo completed file writes, external API calls, emails, or detached processes. Inspect the last result before continuing.

## Where is my application data?

The default Compose setup stores app data in `data/`. Workspace files are under `data/agent_workspace/workspace/`. Custom `APP_DATA_DIR` settings change the host data path.

## Can I delete the database to fix startup?

Do not use deletion as a first recovery step. Inspect status and logs, preserve the data, and make a backup before attempting a data repair. See [Startup and loading](troubleshooting/startup.md).

## Does the desktop manager install Docker?

No. It manages an existing Docker Compose checkout and opens its workspace. Install Docker, Git, or WSL separately as needed.

## Are all features supported on Windows and macOS?

No. Support differs by feature. Linux is tested locally; Windows desktop builds run in CI, while Windows runtime testing remains outstanding. The documented Docker Linux Vulkan path does not cover Docker Desktop GPU passthrough on Windows/macOS.

## How do I report a problem?

Include the Novum version, platform, deployment method, exact steps, expected and actual result, and a small redacted error excerpt. Remove credentials, private chat text, and personal URLs.
