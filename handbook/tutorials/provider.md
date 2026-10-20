# Tutorial: connect a model provider

This walkthrough adds an endpoint and checks it with a small chat request. A
successful endpoint test or model list proves reachability, not that a model
can finish your real workload.

## Add a local endpoint

1. Open a chat and open the model picker above the message box.
2. Select **+**. Its accessible name is **Add model endpoints**. This opens
   endpoint management.
3. In **Add Local Models (Endpoint)**, choose **LLM**. Enter the provider's
   compatible API base URL. For a host Ollama service in the standard Docker
   setup, use `http://host.docker.internal:11434/v1`. The `localhost` address
   inside the Novum container points back to that container.
4. For a protected local endpoint, open the **More** menu and choose **API
   key**, then enter the key in the revealed optional field. Do not put it in
   chat text.
5. Select **Test**. Read the result. If it succeeds, select **Add**. If it
   fails, correct the URL, endpoint availability, authentication, or container
   network path before adding it.
6. Return to the model picker, select the new model, and send a short prompt.
   Confirm a response arrives from the intended provider.

The same form accepts supported local Ollama, llama.cpp, and vLLM services.
Ollama's **Add Ollama** menu item fills its default endpoint address. It does
not install or start Ollama. **Scan network** searches for reachable model
servers; review each result before adding it.

## Add a hosted API endpoint

1. Open the model picker **+** endpoint manager.
2. In **Add API Models (Endpoint)**, choose the provider or enter its base URL.
   Choose the endpoint kind and model type required by that provider.
3. Enter the provider's API key in the key field. Hosted providers require a
   key unless their documented authentication flow says otherwise. Keep the
   key out of chat, screenshots, and logs.
4. Select **Test** and read the returned status. A failed test does not save an
   endpoint. Resolve the reported URL, authentication, or reachability issue.
5. Select **Add**. The endpoint manager reports whether it found models, found
   none, or added an offline endpoint. Return to the model picker and choose
   the model you intend to use.

Hosted providers receive the prompt and any attachments or context sent for
inference. Check that provider's privacy and retention terms before sending
private data.

## Refresh or diagnose an endpoint

Administrators can open **Settings → Admin → Endpoints**. Under **Added
Models**, **Probe** re-tests saved endpoints; **Clear offline** removes offline
endpoint records. Use **Clear offline** only after confirming that the
endpoint is obsolete: it removes the saved record and does not repair a
provider. In **Add Local Models**, **Test** checks the form's current address;
it does not prove that every listed model can generate.

If the endpoint is reachable but no model appears, confirm that the provider
serves a compatible model-list API. If a model appears but chat fails, check
the exact request error and provider logs. For Docker, test reachability from
the same network as Novum; a host-only `localhost` URL will not work from the
container. Follow [Models and memory](../troubleshooting/models.md) when
loading or inference fails.

## GPU notes

The Docker AMD/ROCm overlay serves only components using a compatible ROCm
runtime; it passes host devices and does not install an inference engine.
Linux Docker image generation and the Linux desktop llama.cpp/zVram text
provider use separate Vulkan paths. Read [Providers and models](../providers.md)
before installing a GPU overlay. The source-backed [AMD Compose overlay](https://github.com/nerdrx/novum-xenium/blob/main/docker/gpu.amd.yml),
[desktop provider notes](https://github.com/nerdrx/novum-xenium/blob/main/docs/desktop.md#local-model-provider-linux),
and [image runtime guide](https://github.com/nerdrx/novum-xenium/blob/main/docs/local-images.md)
describe separate features; none guarantees every model fits or performs well.
