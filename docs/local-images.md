# Local image runtime

Every Docker backend image includes `stable-diffusion.cpp` `sd-server`, built
from pinned commit [`1d0a58a35050d285b1d6fb1bc68a92924d35825e`](https://github.com/leejet/stable-diffusion.cpp/commit/1d0a58a35050d285b1d6fb1bc68a92924d35825e).
The default `/usr/local/bin/sd-server` is the CPU-capable build. The optional
`/usr/local/bin/sd-server-vulkan` build is selected explicitly, so software
Vulkan is never chosen implicitly. Both use the same upstream server API and
accept model weights as runtime arguments. The upstream MIT license is at
`/usr/share/licenses/stable-diffusion.cpp/LICENSE` in the image.

Linux x86_64 images also bundle zVram `2e904b8bee5e31ca6440299480ec2f00d71f89a6`
and expose `/usr/local/bin/sd-server-zvram`. When selected in Cookbook alongside
Vulkan, it launches `sd-server-vulkan` through zVram's local recovery mode,
which can page eligible Vulkan allocations into system memory when VRAM is full. Paging
can be slow and does not add physical VRAM or make an unsupported Vulkan queue
compatible.
The zVram MIT license is at `/usr/share/licenses/zvram/LICENSE`. Other image
architectures keep the normal Vulkan server and report that the bundled zVram
layer is unavailable if its wrapper is selected.

Model files are not in the container image. In **Cookbook → Download**, download
a supported single-checkpoint Stable Diffusion 1.x/2.x/XL model into the
persistent model cache. For FLUX.2 Klein 4B or Klein Base 4B, open the cached
model under **Launch** and use **Download missing FLUX.2 Klein components**.
This targets only missing diffusion weights, the recommended Qwen3-4B encoder,
and the shared Klein VAE from the public Comfy-Org component repository. These are the component files expected by stable-diffusion.cpp,
not a duplicate full Hugging Face repository. Use CFG 1 and 4 steps for
distilled Klein 4B, or CFG 4 and 20 steps for Klein Base 4B. Select
**stable-diffusion.cpp** under **Launch**, choose CPU or Vulkan, then start the
model. When its status is **Ready**, choose the image model under
**Settings → AI → Image Generation**; it can then be selected for image requests
in chat. This recipe supports only the two 4B variants. The first download can
be several gigabytes. See the pinned upstream
[FLUX.2 support notes](https://github.com/leejet/stable-diffusion.cpp/blob/1d0a58a35050d285b1d6fb1bc68a92924d35825e/docs/flux2.md).

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

For Vulkan launches, zVram is an opt-in memory-management path for ordinary
Stable Diffusion checkpoints and FLUX.2 Klein. It uses `--auto-fit off` because
the Vulkan layer can report a virtual heap that overstates immediately
available VRAM. FLUX.2 Klein also keeps its text encoder and VAE on CPU.

Native Linux installs can put `scripts/sd-server-zvram` on `PATH` (for example,
`install -m 0755 scripts/sd-server-zvram ~/.local/bin/`) when both `zvram` and
`sd-server-vulkan` are already installed and on `PATH`. The wrapper forces
`--vulkan-recover-local` and `--auto-fit off`; paging can be slow when it spills
into system memory.

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

A downloaded SD 1.5 Q4 checkpoint generated a real 512×512 PNG with 20 steps
using RX 7900 XTX Vulkan execution and zVram local paging. FLUX.2 Klein Base 4B
was tested earlier with the compatibility wrapper and CPU text encoder/VAE,
before local paging was enabled; FLUX paging has not been tested. The installed
backend was also checked through
Cookbook launch, readiness, image generation, authenticated Gallery retrieval,
stop (including port release), and a same-port restart. An existing cloud image
default remained unchanged. The UI defaults this engine to 512×512 when a tool
does not supply a size.
