# Local image runtime

Every Docker backend image includes `stable-diffusion.cpp` `sd-server`, built
from pinned commit [`1d0a58a35050d285b1d6fb1bc68a92924d35825e`](https://github.com/leejet/stable-diffusion.cpp/commit/1d0a58a35050d285b1d6fb1bc68a92924d35825e).
The default `/usr/local/bin/sd-server` is the CPU-capable build. The optional
`/usr/local/bin/sd-server-vulkan` build is selected when a usable render device
is exposed, or explicitly in the manager. Both use the same upstream server API and
accept model weights as runtime arguments. The upstream MIT license is at
`/usr/share/licenses/stable-diffusion.cpp/LICENSE` in the image.

Linux x86_64 images also bundle zVram `95fed253f4937b5ee9f5a87cf4624a053a8bc7a6`
and expose `/usr/local/bin/sd-server-zvram`. The layer uses pinned Vulkan 1.4.341
headers so newer command lookups reach its typed forwarding hooks. When selected in Cookbook alongside
Vulkan, it launches `sd-server-vulkan` through zVram's local recovery mode,
which can page eligible Vulkan allocations into system memory when VRAM is full. Paging
can be slow and does not add physical VRAM or make an unsupported Vulkan queue
compatible.
The zVram MIT license is at `/usr/share/licenses/zvram/LICENSE`. Other image
architectures keep the normal Vulkan server and report that the bundled zVram
layer is unavailable if its wrapper is selected.

## Automatic engine management

The backend starts an authenticated local image gateway with no weights loaded.
The desktop manager's **Image engine** card controls CPU/Vulkan/zVram mode,
automatic startup, refresh, and idle unloading (five minutes by default).
Auto mode prefers zVram when a render device and the bundled wrapper are available,
then Vulkan, otherwise CPU. A manually stopped engine stays stopped until started
again or automatic startup is enabled.

Completed compatible Cookbook downloads are registered within about 30 seconds.
The image model list contains a separate identity for each checkpoint under
**Local images**. Select it in **Settings → AI → Image Generation**; an unset
selection is filled automatically. Explicit cloud/manual choices and the image
generation enable toggle are preserved. A stopped legacy local Cookbook image
selection is migrated to the managed provider; its old endpoint is retained.
Only the requested model loads, one image worker at a time. Switching models or
reaching the idle timeout releases that worker. Startup and cache scans do not
generate images or load all models into VRAM.

The managed catalogue currently supports standalone SD 1.x/2.x/XL checkpoints
and the FLUX.2 Klein 4B recipes below. Incomplete downloads, adapters, projectors,
and unsupported pipelines are not advertised as usable models. Remote SSH caches
stay on their remote host. Existing manual launches remain available in Cookbook.
The gateway exposes the OpenAI-compatible generation/edit routes, not the native
sd.cpp WebUI routes. Its bearer credential and native manager control token are
separate private files in `data/engine-manager`; they are not UI settings.

Model files are not in the container image. In **Cookbook → Download**, download
a supported single-checkpoint Stable Diffusion 1.x/2.x/XL model into the
persistent model cache. New FLUX.2 Klein 4B or Klein Base 4B default downloads
target the three required files automatically. For an existing partial download, open the cached
model under **Launch** and use **Download missing FLUX.2 Klein components**.
This targets only missing diffusion weights, the recommended Qwen3-4B encoder,
and the shared Klein VAE from the public Comfy-Org component repository. These are the component files expected by stable-diffusion.cpp,
not a duplicate full Hugging Face repository. Use CFG 1 and 4 steps for
distilled Klein 4B, or CFG 4 and 20 steps for Klein Base 4B. For an advanced manual launch, select
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
render group ID. Auto mode can then select the Vulkan/zVram binary. Native Linux/macOS
installs need a separately built runtime; the helper below builds the CPU or
Vulkan variant for the current host. Windows native installs must follow
upstream's Windows build instructions.

For Vulkan launches, zVram is a memory-management path for ordinary
Stable Diffusion checkpoints and FLUX.2 Klein. It uses `--auto-fit off` because
the Vulkan layer can report a virtual heap that overstates immediately
available VRAM. FLUX.2 Klein also keeps its text encoder and VAE on CPU.
Its launch recipe uses `--params-backend diffusion=cpu --max-vram 3` to stream
weights from RAM through memory-limited GPU graph segments, leaving room for
a resident chat model. The zVram wrapper reserves 256 MiB of Vulkan headroom for
standalone `--diffusion-model` launches; checkpoint launches keep its default.
zVram remains enabled for eligible GPU allocations;
3 GiB is the engine budget, not a cap on total system or GPU memory usage.

Native Linux installs can put `scripts/sd-server-zvram` on `PATH` (for example,
`install -m 0755 scripts/sd-server-zvram ~/.local/bin/`) when both `zvram` and
`sd-server-vulkan` are already installed and on `PATH`. The wrapper forces
`--vulkan-recover-local` and `--auto-fit off`; paging can be slow when it spills
into system memory. It also sets `GGML_VK_DISABLE_HOST_VISIBLE_VIDMEM=1` so
GGML uses device-local allocations eligible for paging instead of host-visible
ReBAR allocations, which the layer deliberately leaves unmanaged.

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
generated a 512×512 PNG at 20 steps with the pageable allocation setting and
CPU text encoder/VAE. A separate 256×256, 4-step pressure test stayed below
a 6 GiB managed-residency cap with 1,641 evictions and 1,844 restores, producing
the byte-identical baseline PNG. A 4 GiB cap failed because the active working
set did not fit; extra cold storage alone did not fix that. These caps cover
eligible allocations, not total GPU usage. Paging added latency (117 seconds
versus 33 seconds without that pressure). This is bounded validation of these
models and sizes, not a guarantee for arbitrary models or memory limits.

The installed backend was also checked through
Cookbook launch, readiness, image generation, authenticated Gallery retrieval,
stop (including port release), and a same-port restart. An existing cloud image
default remained unchanged. The UI defaults this engine to 512×512 when a tool
does not supply a size.

### Shared-GPU validation

A later real chat exposed a coexistence limit: the resident 27B chat model left
too little GPU memory for FLUX's unsegmented working set. Both 1024×1024 and
512×512 requests failed with Vulkan `ErrorOutOfDeviceMemory`; zVram's 4 GiB
cold store also filled. Increasing image resolution was not the only cause.
The RAM-backed, 3 GiB segmented recipe above generated a real 512×512 image
at 20 steps through Novum, with authenticated Gallery retrieval, while the same
27B model remained loaded. This avoids requiring users to unload
their chat model for the tested workload. Different models, resolutions and
other GPU applications can still exceed the available resources.

A separate 1024×1024 stress request still failed when zVram's live admission
allowance fell to about 901 MiB during rendering. The segmented recipe is not
a GPU reservation and does not guarantee coexistence under arbitrary pressure.
Keep 512×512 as the default; 1024×1024 under that pressure remains unverified
as a usable end-to-end path. No successful image is claimed for that request.
