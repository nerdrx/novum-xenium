# Troubleshooting models and memory

Separate endpoint discovery from actual inference. A saved provider, green
probe, or visible model name does not prove that model generation will work.

## Endpoint or model is missing

1. Open **Settings → Admin → Endpoints** and review **Added Models**.
2. Select **Probe** to re-test saved endpoints. Read each endpoint's reported
   status before changing it.
3. Open the model picker and select its refresh control. If still absent,
   confirm the endpoint serves a compatible model-list API and that its model
   has not been disabled or filtered.
4. For a new local endpoint, use the [provider tutorial](../tutorials/provider.md).
   In Docker, a provider running on the host is not reachable as `localhost`
   from inside the app container. Use `host.docker.internal` or a Compose
   service name when that address matches your setup.

Current builds stop a model-catalog refresh after 30 seconds, including a
stalled response body. A failed refresh keeps the last catalog and clears the
loading state; retry the refresh after checking the provider connection. A
cached list can therefore remain visible while its provider is offline.

**Clear offline** removes saved offline endpoint records. Use it only after
confirming the record is obsolete. It does not repair the provider or retry
inference.

## Endpoint appears offline

Check the provider process on the machine where it runs. Confirm the base URL,
port, API compatibility, and authentication from Novum's network namespace.
For Docker, inspect service status and recent app logs:

```sh
docker compose ps
docker compose logs --tail=150 odysseus
```

If the address is correct but the provider is on a different host, ensure its
listener and firewall allow only the intended connection. Do not bind it to
all interfaces as a discovery workaround.

## Model appears but request fails

Record the provider, model ID, time, and exact visible error. Check provider
logs and resource status. A model list can work even when the inference route,
model format, account quota, or GPU runtime is wrong. Confirm which provider
was selected in the chat before retrying.

For a local Ollama server hosted outside Docker, the usual host address is
`http://host.docker.internal:11434/v1`. The `host.docker.internal` alias is
added by the standard Compose file. Other host/container platforms may need a
different reachable address.

## Request or session stays loading

Wait for one status change, then inspect the provider and session before
sending again. Current builds bound session-list and body loading to 15
seconds; on timeout, they preserve the current draft/list and allow manual
retry. The stream watchdog probes the affected session after inactivity; it
does not replay the request. Older installed builds may not contain these
recovery changes. Check the installed version and the current
[chat implementation](https://github.com/nerdrx/novum-xenium/blob/main/static/js/chat.js).

## Out of memory or load failure

Stop the failed request once and read the provider error. Check both system
RAM and GPU memory, including other active workloads. Use the provider's
normal controls to unload work you no longer need. Reduce the selected model
or context through the control that owns that setting, then retry once.

On Linux desktop, regular llama.cpp mode uses `llama-server`; the separate
experimental zVram mode manages eligible Vulkan allocations. zVram can page
eligible allocations into system memory, which can be slow. It does not create
physical VRAM or reserve all host memory. A listed or previously loaded model
is not guaranteed to fit under every workload. Keep a manually stopped local
provider stopped until you choose to start it again; a manual Stop is not a
crash-recovery request. See [Providers and models](../providers.md).

## Local image generation fails

Check whether the selected image model downloaded completely and is supported
by its configured engine. The Linux Docker Vulkan path needs the documented
GPU overlay, host drivers, `/dev/dri` access, and render-group configuration;
the CPU engine is a separate fallback. The Linux AMD ROCm overlay does not
turn the Vulkan image engine into a ROCm engine. Docker Desktop GPU passthrough
is not documented for this path. See the source-backed [local image runtime
guide](https://github.com/nerdrx/novum-xenium/blob/main/docs/local-images.md).

## What to include in a useful report

Include Novum version, deployment method, platform, provider/engine, model ID,
whether this is a first load or model switch, the exact error, and whether
another model or image job was active. Remove API keys, private endpoint
credentials, chat content, and private addresses before sharing logs.
