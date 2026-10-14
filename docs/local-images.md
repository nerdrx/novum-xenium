# Local image runtime

Every Docker backend image includes `stable-diffusion.cpp` `sd-server`, built
from pinned commit [`1d0a58a35050d285b1d6fb1bc68a92924d35825e`](https://github.com/leejet/stable-diffusion.cpp/commit/1d0a58a35050d285b1d6fb1bc68a92924d35825e).
The default `/usr/local/bin/sd-server` is the CPU-capable build. The optional
`/usr/local/bin/sd-server-vulkan` build is selected explicitly, so software
Vulkan is never chosen implicitly. Both use the same upstream server API and
accept model weights as runtime arguments. The upstream MIT license is at
`/usr/share/licenses/stable-diffusion.cpp/LICENSE` in the image.

Model files are not in the container image. In **Cookbook → Download**, download
a supported single-checkpoint Stable Diffusion 1.x/2.x/XL model into the
persistent model cache. Select **stable-diffusion.cpp** under **Launch**, choose
CPU or Vulkan, then start the model. When its status is **Ready**, choose the
image model under **Settings → AI → Image Generation**; it can then be selected
for image requests in chat. The first download can be several gigabytes.

The engine's OpenAI-compatible endpoint is `POST /v1/images/generations`.
The server also offers its native async API at `/sdcpp/v1/` and WebUI
compatibility API at `/sdapi/v1/`. One small SD 1.5 GGUF option is
[`v1-5-pruned_Q4_0.gguf`](https://huggingface.co/kostakoff/stable-diffusion-v1-5-GGUF),
about 3 GB. It inherits CreativeML OpenRAIL-M; review the model card terms
before use.

## GPU support

The CPU build is intended for Docker on Linux and Docker Desktop on Windows/macOS.
Linux x86_64 CPU and AMD Vulkan generation have been tested; other host and
architecture combinations have not been verified. Performance depends on host
CPU and memory. Docker Desktop cannot pass through the Apple
Metal GPU, and this bundled build does not include Metal. Vulkan passthrough is
for Linux Docker Engine only; install
the host Vulkan driver, ensure the Docker user can access `/dev/dri`, then add
`docker/gpu.vulkan.yml` to `COMPOSE_FILE` and set `RENDER_GID` to the host
render group ID. The Vulkan binary must be requested explicitly. Native Linux/macOS
installs need a separately built runtime; the helper below builds the CPU or
Vulkan variant for the current host. Windows native installs must follow
upstream's Windows build instructions.

Native Linux/macOS build prerequisites are CMake, a C/C++ compiler, Git and
recursive submodule network access. Vulkan additionally needs the Vulkan SDK
or the distribution packages `libvulkan-dev`, `glslc`, and `spirv-headers`.
Run:

```sh
scripts/build-stable-diffusion.sh cpu ./build/stable-diffusion
# Or, on Linux with Vulkan development packages:
scripts/build-stable-diffusion.sh both ./build/stable-diffusion
```

The output contains `cpu/sd-server`, optionally `vulkan/sd-server`, and the
upstream license. The helper supports `cpu`, `vulkan`, and `both`.

Upstream references: [build guide](https://github.com/leejet/stable-diffusion.cpp/blob/master/docs/build.md),
[server APIs](https://github.com/leejet/stable-diffusion.cpp/blob/master/examples/server/api.md),
[server options](https://github.com/leejet/stable-diffusion.cpp/blob/master/examples/server/README.md).

## Verified integration

A downloaded SD 1.5 Q4 checkpoint generated real 512×512 PNGs with both CPU
and RX 7900 XTX Vulkan execution. The installed backend was also checked through
Cookbook launch, readiness, image generation, authenticated Gallery retrieval,
stop (including port release), and a same-port restart. An existing cloud image
default remained unchanged. The UI defaults this engine to 512×512 when a tool
does not supply a size.
