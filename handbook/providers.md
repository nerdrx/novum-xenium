# Providers and models

A provider supplies model inference. Novum Xenium can connect to hosted APIs and local model servers; the self-hosted application does not decide where inference runs. Use only providers and accounts you are permitted to use.

## Add a model endpoint

1. Open a chat and open the model picker.
2. Choose the **+** button (**Add model endpoints**).
3. Add the local server or API endpoint in the management panel. For an OpenAI-compatible service, use its API base URL, model identifier, and credential as required by that endpoint. For local Ollama, the Docker host name `host.docker.internal` is provided; the conventional Ollama API port is `11434`.
4. Save and return to the model picker. Select the endpoint/model and send a short prompt.
5. If no model appears, open **Settings → AI** to inspect saved model choices. If the endpoint is marked offline, check the provider process and network path. If it appears but inference fails, inspect provider logs and the exact request error.

Provider forms differ. Do not reuse a URL from another endpoint type without confirming API compatibility. The model picker is the entry point for adding endpoints; account administrators can manage records through **Settings → Admin → Endpoints**.

Do not paste API keys into chat or public logs. Hosted providers receive request content, attachments, and any context sent with the request. Consult that provider's data and retention terms.

## Model choices during endpoint refresh

Each time you enter Settings → AI, Novum refreshes the endpoint inventory. This refresh stops waiting after 15 seconds, including a stalled response body. If it fails or returns a non-array response, it leaves already displayed endpoint and model selections unchanged. This does not confirm provider health, and Novum does not retry automatically. A valid empty inventory clears the selectors. After the service recovers, leave and re-enter AI to refresh the inventory. Initial endpoint-inventory reads for Default Chat, Utility, Deep Research, and Vision’s fallback options also stop waiting after 15 seconds. Image Generation and Speech to Text use separate per-request loading deadlines described below; this does not bound all settings loading.

During initial loading, Utility, Vision, Deep Research, and Research Search keep fields you have edited instead of replacing them with a late settings response. Their saves send only the changed setting and any dependent model or effort reset. Failed or malformed initial settings reads show a panel-local warning and leave the controls available for editing. Existing save feedback takes precedence over a late load error. Research Search also displays its own save status.

Default Chat loads endpoint inventory, then saved settings. Each request has its own 15-second deadline, including its response body. If saved settings fail before you change a selection, a warning says displayed choices may differ from saved settings; reload after the connection recovers to verify them. Vision loads primary models, endpoint inventory, then saved settings, with a separate 15-second deadline per request. These waits can add up to 45 seconds, but do not cap total panel startup time. Inventory failures do not retry automatically; the saved-settings read still runs. A failed Vision settings read uses its existing warning unless save feedback takes priority.

A saved Vision model missing from the current inventory remains visible with a “saved; not in current list” label. Utility and Deep Research retain the same label when their matching saved endpoint is enabled. Default Chat also shows its saved model instead of silently displaying the first listed model; its saved-only option is disabled. Choose an available model to change Default Chat. Displaying a saved choice does not prove the provider can serve it. Explicit model or endpoint changes keep their existing save behavior, and late initial responses preserve newer selections.

If an initial inventory request fails, leave and re-enter AI after the service recovers. A successful refresh restores the saved endpoint/model only when that endpoint is enabled and you have not changed either control. A newer explicit selection remains authoritative. Recovery does not post settings or restart the provider.

A save that receives no response stops waiting after 15 seconds; Novum does not retry it automatically. Check the save message: keeping an edit visible does not confirm it reached the server. A failed request may still have been saved; reload Novum and check Settings before retrying.

See the pinned [settings loading and saving](https://github.com/nerdrx/novum-xenium/blob/d752cd5d596f561c2585d243842d4b1b24588e07/static/js/settings.js).

## Image and speech settings loading

Image Generation and Speech to Text keep their controls unavailable until saved settings load successfully. Each panel first reads the endpoint inventory, then its saved settings. Each request has its own 15-second deadline, including a stalled response body; together, the two reads can wait up to 30 seconds.

If the optional inventory read fails but saved settings load, the saved choice remains available. This does not confirm provider health. If the saved-settings read fails, returns malformed JSON or a non-object settings response, or times out, Novum keeps the controls unavailable and displays reload guidance. Image settings cannot save guessed model or quality defaults in that state.

After the connection recovers, reload Novum to retry these initial reads. Leaving and re-entering AI refreshes the inventory but does not repeat a failed saved-settings read. There is no automatic retry, provider restart, microphone request, image generation, or transcription from these loading checks.

See the pinned [image settings loader](https://github.com/nerdrx/novum-xenium/blob/ee919f549335be7950371591dc0fdc783a44f239/static/js/settings/imageModels.js) and [speech settings loader](https://github.com/nerdrx/novum-xenium/blob/ee919f549335be7950371591dc0fdc783a44f239/static/js/settings/speech.js).

## Connect an account with sign-in

For **GitHub Copilot** or **ChatGPT Subscription**, choose the account provider
and select **Add**. Follow the displayed sign-in link and code, then wait for
the connection result. ChatGPT accepts an optional account label so multiple
accounts remain distinguishable. Keep sign-in codes out of chat and logs.

Changing the provider or editing the label does not cancel an already started
sign-in. If that flow succeeds, its saved endpoint still appears in **Added
Models**. Its late completion preserves the newer form draft and does not
automatically select that old flow's model. Select the intended saved model
explicitly before sending a prompt.

A failed sign-in names its original provider. If you change providers, use
**Add** for the newly selected provider; a stale **Try again** action will not
restart the old provider behind that selection.

Each sign-in start or poll request stops waiting after 60 seconds, including
a stalled response body. This stops the browser from waiting; the backend
connection may still complete. Check **Added Models** before starting another
sign-in after a timeout.

## Local providers

The README documents Ollama and OpenAI-compatible provider endpoints. In Docker, a host service must be reachable from inside the container; `localhost` inside the container refers to the container itself. The example environment file includes optional endpoint settings and examples. Change a bind address only when you understand who can reach it and have suitable firewall controls.

On Linux, the desktop manager also provides a separate llama.cpp-based text provider. Regular mode uses llama-server. Experimental zVram mode manages eligible Vulkan allocations for supported Linux GPU configurations. It may page data into system memory, which can be slow. This is a bounded memory technique, not extra physical VRAM or a guarantee that any model will fit. The provider uses a separate server; it does not convert a running Ollama process into a zVram-managed process.

The desktop text provider, Cookbook image models, and chat provider selection are different controls. Downloaded model files may be reused only when they match the supported model format and discovery path.

## AMD and ROCm

The Docker AMD overlay is for ROCm-capable model-serving workloads. It passes `/dev/kfd` and `/dev/dri` into the backend container. The host needs ROCm drivers, and the Docker user needs the `video` and `render` groups. The overlay does not bundle ROCm userspace or an inference engine; install a compatible vLLM or llama-cpp-python build through **Cookbook → Dependencies** before serving GPU models. Follow the repository's [AMD overlay instructions](https://github.com/nerdrx/novum-xenium/blob/main/docker/gpu.amd.yml) and [environment examples](https://github.com/nerdrx/novum-xenium/blob/main/.env.example) for `COMPOSE_FILE` and `RENDER_GID`.

Other features use different GPU paths. The Docker image-generation path documented for Linux uses Vulkan. The Linux desktop local text-provider zVram route also uses Vulkan. The AMD ROCm Compose overlay does not convert these Vulkan paths to ROCm. Docker Desktop GPU access on Windows/macOS is not covered by the Linux device overlay.

## Local is not virtual

zVram can page eligible Vulkan allocations to system memory under supported conditions. It cannot create physical VRAM, guarantee a model's working set will fit, or promise acceptable speed after paging. Its budgets describe eligible allocations and do not cap all GPU/system memory. A model that starts can still fail under real workload pressure.

When a local model stays on “loading,” check the provider's status and logs, wait for the first load to finish, and make sure another model request is not occupying the server. If the process exits or reports out-of-memory, follow [Models and memory](troubleshooting/models.md).

See the canonical [desktop provider notes](https://github.com/nerdrx/novum-xenium/blob/main/docs/desktop.md#local-model-provider-linux), [zVram integration handoff](https://github.com/nerdrx/novum-xenium/blob/main/docs/zvram-provider-handoff.md), and [local image runtime](https://github.com/nerdrx/novum-xenium/blob/main/docs/local-images.md).
