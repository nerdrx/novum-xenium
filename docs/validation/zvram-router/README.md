# llama-server router dynamic load/unload validation

Date: 2026-10-09 (Europe/Berlin).
Result: PASS. Initial `/models` reported `tiny-a=unloaded`, `tiny-b=unloaded`. A request to each alias returned non-empty output; with `--models-max 1`, requesting `tiny-b` unloaded `tiny-a` and loaded `tiny-b`.
Model: local SmolLM2-135M-Instruct F16 GGUF (259 MiB). Router: local Vulkan llama-server binary, two aliases point to same GGUF; context 512, parallel 1, batch 32, no warmup.
zVram: launched with `--no-live-control --vulkan-virtual-gib 96`; router environment contained `ZVRAM_VULKAN_VIRTUAL_MIB=98304` and `VK_INSTANCE_LAYERS=VK_LAYER_NX_zvram`; `libzvram_layer.so` appeared in two sampled process maps.
GPU: CPU-only (`--gpu-layers 0`) because RX 7900 XTX render node was active with VRChat/desktop processes; no GPU load claim. This run validates routing and launcher environment inheritance, not GPU layer mapping.
Elapsed: 1.81 s. Router process cleaned up; exit 0.

Command shape: `zvram --no-live-control --vulkan-virtual-gib 96 llama-server --models-preset <temporary-ini> --models-max 1 --models-autoload --host 127.0.0.1 --port <free> --ctx-size 512 --parallel 1 --batch-size 32 --gpu-layers 0 --no-warmup`.

Per-alias status evidence:
```json
[
  {
    "alias": "tiny-a",
    "http": 200,
    "output_nonempty": true,
    "models": {
      "tiny-a": "loaded",
      "tiny-b": "unloaded"
    }
  },
  {
    "alias": "tiny-b",
    "http": 200,
    "output_nonempty": true,
    "models": {
      "tiny-a": "unloaded",
      "tiny-b": "loaded"
    }
  }
]
```

## Desktop bridge dispatch integration

Result: PASS. Called `desktop/src-tauri/src/zvram_bridge.py` `dispatch` with real helpers from `_load_runtime` and a real `zvram_manager.Manager` using temporary state/home. Discovery was patched to two aliases (`tiny-a`, `tiny-b`) for the same local SmolLM2-135M F16 GGUF; helper default server pointed to the tested Vulkan binary. The real command builder was retained, with only `--gpu-layers 999` changed to `0` for this test because the RX 7900 XTX render node was busy.

`router_start` returned started; bridge status reached `router.healthy=true`. Initial `/v1/models` states: `{'tiny-a': 'unloaded', 'tiny-b': 'unloaded'}`. Requests to both aliases returned HTTP 200 with non-empty output. After tiny-a: `{'tiny-a': 'loaded', 'tiny-b': 'unloaded'}`. After tiny-b: `{'tiny-a': 'unloaded', 'tiny-b': 'loaded'}`. No `router_register` call was made.

Cleanup: `router_stop` used manager-owned worker path; worker state `stopped`, alive `False`, child exit `0`. Elapsed 1.73 s. Private manager evidence: `/tmp/zvram-bridge-private-b1jp1onf`.
