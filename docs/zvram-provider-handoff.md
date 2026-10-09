> Implementation lives in the separate [zVram project](https://github.com/nerdrx/zVram).
> Novum desktop controls call this host bridge; the zVram management app stays separate.
> Relative build paths and Python module names below refer to the zVram checkout.

# Novum Xenium integration handoff

The inference runner and process supervisor live in zVram. Novum adds a narrow
desktop adapter for one on-demand model provider. Ollama, the default model, and model files
remain untouched.
The zVram management GUI/TUI are standalone applications. Do not embed the
management GUI in Novum; the two projects share styling, not their UI lifetime.

## Current bridge

`zvram_model.py` reads the desktop checkout and port from
`~/.config/dev.novum.xenium/config.json`. `discover_models(checkout)` resolves
GGUF blobs from that checkout's existing Ollama manifests. Explicit GGUF paths
also work. Model discovery does not start inference or copy weights.

The existing Ollama process cannot be retroactively wrapped in the zVram Vulkan
layer. This bridge starts a separate Vulkan `llama-server` using the same model
file. Its OpenAI-compatible endpoint binds to `127.0.0.1`, has one inference
slot, and has an explicit context size. It does not expose a LAN service.

The primary desktop flow now starts `llama-server` in **router mode**, without
`--model` or a per-model alias. The adapter generates a private INI preset from
the discovered Ollama GGUF files, preserving their model names and original
paths. No model copies or per-model saved profiles are required. The existing
zVram helper supplies the Vulkan wrapper and optional BP16 settings; router
children inherit its command-line settings and environment.

`--models-autoload --models-max 1` loads the model requested by a chat and
unloads the least recently used model when switching. Presets explicitly disable
startup loading. A private empty llama cache keeps unrelated cached models out
of the provider inventory. First replies and model switches include loading
time; a busy previous request can delay switching. This does not promise that
every discovered model fits the configured memory budgets.

The server must support `--models-preset`, `--models-max`, and
`--models-autoload`; the adapter checks the selected binary's actual help output.
Downloaded models are rediscovered on the next provider start. Stop an older
per-model server if it occupies the selected port. Legacy profile controls are
retained separately for stopping or managing those earlier launches.

Build the server if absent:

```sh
cmake --build build/third-party/llama-vulkan-build --target llama-server -j 4
python3 zvram_model.py list
```

`build_server_command(path, alias, ...)` returns `(argv, environment)` for a
controller to pass directly to `subprocess.Popen`, without shell expansion.
`mode="native"` produces an unwrapped reference command. The default `spill`
mode uses the virtual heap. With zVram 0.4.4 or newer, live VRAM management is
enabled by default; `live_control=False` explicitly selects plain spill without
runtime residency caps. The desktop exposes this choice independently from BP16.
Older installations keep plain spill and show that an update is needed for this
setting. `compressed=True` explicitly opts into experimental
BP16 range paging. The latter accepts `resident_mib`, `cold_mib`,
`clean_cache_mib`, and `headroom_mib`. These are eligible allocation budgets,
not global physical VRAM reservations or cross-process scheduling guarantees.
The default compression profile is experimental and must be validated for each
model, context size, and GPU. Native images and untracked allocations remain
outside the resident limit.

The helper's `command` action prints a command preview and only its zVram
environment settings; it never starts a model. A controller must retain the
complete returned environment, including the GGML Vulkan settings, when
launching. Use the manager for execution and lifetime management.

## Endpoint registration

For the router, **Start provider** launches the server and the desktop connects
it after `/health` is ready and `/v1/models` advertises the generated model
inventory. One `zVram · Local models` endpoint exposes all discovered model IDs
to the chat picker. Registration uses the existing signed-in desktop cookie;
failed registration is visible and can be retried. It never overwrites a
non-zVram endpoint on the same port. Starting the router requires an explicit
user action; no login or boot autostart is installed.

For legacy single-model profiles, after the controller observes a healthy server and `/v1/models` advertises the
requested alias, call `register_endpoint(alias, port)`. Registration uses the
existing local desktop session cookie, accepts Netscape and WebKit cookie
formats, rejects expired/wrong-host cookies, ignores HTTP proxy variables,
and refuses redirects. Cookie values must never be logged.

The helper creates a user-owned `zVram · <alias>` model endpoint through
Novum's existing `/api/model-endpoints` API. Re-registration updates only that
port's existing zVram endpoint. It refuses to overwrite an endpoint belonging
to another provider. Other endpoints and defaults remain unchanged. Login in
the desktop app is required; the helper does not bypass authentication.

## Desktop controls

The provider settings choose port, context, live management, and opt-in BP16 paging. Start once, then
choose models directly in chat; separate Save and Start actions for every
model are unnecessary. Show startup/health/error state and offer an explicit
stop action. Register only after the server is healthy. Keep the
current Ollama endpoint available so users choose either provider per chat.
Do not automatically start large models or unload unrelated Ollama models.

Live VRAM management applies to the next provider launch and changes automatic
paging behavior. BP16 always needs paging, so its checkbox keeps live management
enabled. Existing servers must restart to enable it; running Vulkan devices
cannot gain paging retroactively. An idle router may have no Vulkan device or
control endpoint: the standalone manager controls the loaded model worker's
endpoint once it is created. This setting does not grant process ownership over
external servers.

Model profiles may opt out of zVram's system-wide swap-growth stop with
`ignore_swap_guard`. This requires zVram 0.4.2 or newer; the available-RAM
launch and runtime guards remain enabled.

The active Novum web backend runs inside Docker while zVram and the model
server run on the host. Implement host launch/control through a narrow desktop
adapter with typed, allowlisted model actions, rather than a web endpoint that
executes arbitrary commands. The browser-only deployment can consume an
already-running loopback model provider; it does not gain host process-control
permissions. A future host agent, if needed, should be a user service with an
authenticated local IPC contract, not a privileged GPU daemon.

Typed router verbs: `router_start`, `router_stop`, and `router_register`.
Legacy desktop verbs: discover models, save a validated model profile,
start a named profile, read its health/status, stop that owned profile, and
register its verified provider. Use argv arrays and preserve the manager's
RAM/swap guards. Do not expose arbitrary shell, environment, or PID-signal
arguments to web content. The standalone manager keeps general application
profiles; Novum's adapter only needs its model profiles.

Runtime priority changes may require restarting an owned model server. Label
that behavior clearly and preserve chat history. Show memory limits as zVram
eligible allocation budgets, not reserved physical VRAM.

CPU-only bridge checks: `python3 -m unittest -v test_zvram_model.py`.
