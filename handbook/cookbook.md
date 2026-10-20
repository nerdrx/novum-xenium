# Cookbook: local models

Cookbook is where you find model files, prepare a server configuration, and
track downloads and launches. It does not prove that a model will load or
generate successfully: a catalogue match or hardware scan is only a starting
point. For endpoint setup, see [Providers and models](providers.md); for image
generation, see [Images and audio](media.md).

## Choose where files go

Open **Cookbook → Download**. The server selector applies to the download or
scan beside it. **Local** is the default when no remote server is selected;
choose a saved remote server explicitly when that is where the model should
live. Do not assume a remote cache is copied to the local machine.

Use **Direct Download** to paste a Hugging Face model ID or URL, or an Ollama
model reference such as `qwen2.5:14b`. Or use **Scan / Download** to browse and
filter the catalogue. Its model-type choices include **Standard**, **Vision**,
**Image**, and **Trending**; the advanced controls include engine, quantization,
and context filters. The scan estimates hardware suitability from the selected
server. It does not download, load, or test inference for a model.

## Follow a download

After starting a download, open the **Active** tab to inspect its task status,
progress, and available task actions. On cached model cards, an incomplete or
stalled item offers **Resume download**. Use that action after checking that the
selected server is reachable and has enough disk space. A partial download is
not a usable model, and resuming may still fail if the upstream file or
connection is unavailable.

Use **Delete** only when you intend to remove the cached model files. For GGUF
models, Cookbook may ask which files to delete. Removing a task entry and
deleting cached model files are different operations; check the action label
before confirming. If a download remains stalled, inspect the task error and
server selection before retrying. Avoid repeatedly starting duplicate copies.

## Configure and launch

Open **Launch** to select a cached model and configure a supported serving
engine. The engine choices depend on the model format and selected server. For
the Cookbook GGUF launch path, choose a compatible server and engine;
safetensors formats such as AWQ are for vLLM or SGLang on a compatible CUDA/ROCm
GPU server. Cookbook flags some format/engine mismatches before launch, but a
successful launch is not proof that requests will work under your intended
context size or workload.

Use the model's **Launch** action, then inspect the task under **Active** for
startup errors or a running status. If a port is occupied, choose the offered
stop-and-launch or alternate-port option only after checking which existing
server uses that port. A failed or stopped launch does not mean the model was
deleted. Fix the reported engine, dependency, port, or resource issue and
launch again. Dependencies are managed separately in **Dependencies**.

## Text and image engines are separate

Cookbook text-serving launches and image-generation settings are separate.
Download a supported image model, then select it under **Settings → AI → Image
Generation**. The built-in local stable-diffusion.cpp engine in the Linux Docker
image supports CPU or Vulkan; remote image providers are configured separately.
Optional zVram is a Vulkan memory-management path, not extra physical VRAM. The
AMD ROCm overlay is for compatible model-serving workloads and does not turn the
Vulkan image path into ROCm. Read [Images and audio](media.md) and the
[local image runtime notes](https://github.com/nerdrx/novum-xenium/blob/main/docs/local-images.md)
before changing GPU configuration.

Linux desktop text serving is separate again: regular mode uses llama-server,
while experimental zVram mode manages eligible Vulkan allocations. The
[provider guide](providers.md) describes this boundary. A catalogue entry,
hardware estimate, or server status cannot guarantee fit, speed, or successful
inference. Validate the actual model, context, engine, and GPU combination.

## Recover without losing your setup

- If a model is missing, check the selected server and cache location, then
  refresh the scan. A local list does not include files held only in a remote
  cache.
- If a download is incomplete or stalled, inspect its task and use **Resume
  download** when offered. Keep the partial files unless you have decided to
  discard them.
- If launch fails, read the task's error first. Check the format/engine match,
  required dependencies, port, and available memory before trying again.
- If requests fail after launch, confirm the selected endpoint and model in
  chat and inspect the provider logs. A listed or running model does not prove
  its inference route is healthy.
- For the Linux desktop local text provider, a manual **Stop** leaves it
  stopped until you choose to start it again. Do not enable automatic startup
  as a recovery workaround if you intentionally keep that provider stopped.

For endpoint/catalogue recovery, see [Troubleshooting models and memory](troubleshooting/models.md).
