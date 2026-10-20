# Images and audio

Image generation, image editing, speech/audio, and chat text use separate providers or engines. Availability depends on configuration. Do not assume that connecting a chat model also configures images or audio.

## Local image generation

The Docker backend includes a local image engine with CPU and Vulkan options. Linux x86_64 can include a zVram Vulkan path. Model weights are downloaded separately; the container image does not contain them. A model is loaded for a request rather than all models being kept in GPU memory. Compatible models and recipes are listed in the canonical [local image runtime guide](https://github.com/nerdrx/novum-xenium/blob/main/docs/local-images.md).

On Linux, the documented Vulkan route needs a host driver, Docker access to `/dev/dri`, and the repository's `docker/gpu.vulkan.yml` Compose override with the host render-group ID configured. Windows/macOS Docker Desktop GPU passthrough is not covered by that route; CPU mode remains available. A zVram paging option can be slow and does not guarantee a model fits under all concurrent GPU load.

To use a local image model, download a supported model in Cookbook, wait for the completed download to appear, then select it under **Settings → AI → Image Generation**. Use a small request first. If loading fails, check the selected engine, model support, and available host/container resources.

## Hosted image providers

Image providers are configured separately from chat providers. Some workflows can use an existing host login through the optional Codex image bridge, which needs its own setup. It is not installed or enabled merely by using a chat model. See the [Codex image bridge instructions](https://github.com/nerdrx/novum-xenium/blob/main/docs/codex-image-bridge.md).

## Audio

The desktop's local Linux alarm is a host-side feature that uses a user-session timer and restores the previous system volume/mute state after its bounded playback. The computer and user audio session must be available. It does not wake a powered-off computer or act as an Android alarm. Other voice/audio features require their own supported provider configuration; verify the exact feature in the current Settings and release notes.

## Troubleshooting

If the request succeeds but no image appears, inspect the Gallery result and the engine's status. If the model fails to load, follow [Models and memory](troubleshooting/models.md). Do not repeatedly retry large image requests while the engine reports out of memory.
