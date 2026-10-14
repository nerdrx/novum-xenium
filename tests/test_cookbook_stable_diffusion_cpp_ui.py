"""Focused UI guards for Cookbook's built-in Stable Diffusion engine."""

import re
import shutil
import subprocess
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parent.parent
SERVE = ROOT / "static/js/cookbookServe.js"
COOKBOOK = ROOT / "static/js/cookbook.js"


def test_sd_cpp_model_scope_in_node():
    node = shutil.which("node")
    if not node:
        pytest.skip("Node.js is unavailable")
    source = SERVE.read_text(encoding="utf-8")
    match = re.search(r"function _isStableDiffusionCppCandidate\(model\) \{.*?\n\}", source, re.S)
    assert match, "expected the UI's SD checkpoint candidate classifier"
    script = "const _isStableDiffusionCppCandidate = new Function(" + repr(match.group(0) + "\nreturn _isStableDiffusionCppCandidate;") + ")();\n" + r"""
const assert = (ok, message) => { if (!ok) throw new Error(message); };
assert(_isStableDiffusionCppCandidate({repo_id:'kostakoff/stable-diffusion-v1-5-GGUF',_tag:'image'}), 'SD GGUF should be offered');
assert(_isStableDiffusionCppCandidate({repo_id:'kostakoff/stable-diffusion-v1-5-GGUF'}), 'SD GGUF should not depend on scan flags');
assert(_isStableDiffusionCppCandidate({repo_id:'org/stable-diffusion-xl',is_diffusion:true}), 'SDXL should be offered');
assert(_isStableDiffusionCppCandidate({repo_id:'black-forest-labs/FLUX.2-klein-4B',is_diffusion:true}), 'FLUX.2 Klein 4B should be offered');
assert(_isStableDiffusionCppCandidate({repo_id:'black-forest-labs/FLUX.2-klein-base-4B',is_diffusion:true}), 'FLUX.2 Klein base 4B should be offered');
assert(!_isStableDiffusionCppCandidate({repo_id:'meta-llama/llama-2-7b-GGUF',_tag:'llm'}), 'arbitrary GGUF LLM must stay excluded');
assert(!_isStableDiffusionCppCandidate({repo_id:'black-forest-labs/FLUX.1-dev',is_diffusion:true}), 'FLUX pipeline must stay excluded');
assert(!_isStableDiffusionCppCandidate({repo_id:'black-forest-labs/FLUX.2-klein-9B',is_diffusion:true}), 'Klein 9B should stay excluded');
assert(!_isStableDiffusionCppCandidate({repo_id:'org/stable-diffusion-video',is_diffusion:true,is_video:true}), 'video models must stay excluded');
"""
    result = subprocess.run([node, "--input-type=module", "-e", script], capture_output=True, text=True, timeout=20)
    assert result.returncode == 0, result.stderr


def test_sd_cpp_gguf_filter_in_node():
    node = shutil.which("node")
    if not node:
        pytest.skip("Node.js is unavailable")
    source = SERVE.read_text(encoding="utf-8")
    files = re.search(r"function _ggufFilesForModel\(model\) \{.*?\n\}", source, re.S)
    runnable = re.search(r"function _runnableGgufFiles\(model\) \{.*?\n\}", source, re.S)
    filtered = re.search(r"function _stableDiffusionCppGgufFiles\(model\) \{.*?\n\}", source, re.S)
    assert files and runnable and filtered
    script = "const filter = new Function(" + repr(files.group(0) + "\n" + runnable.group(0) + "\n" + filtered.group(0) + "\nreturn _stableDiffusionCppGgufFiles;") + ")();\n" + r"""
const files = filter({gguf_files:[
  {rel_path:'v1-5-Q4_0.gguf',role:'model'},
  {rel_path:'clip_l-Q4_0.gguf',role:'model'},
  {rel_path:'v1-5-Q4_0-00001-of-00002.gguf',role:'model',split:true,parts:2},
]});
if (files.length !== 1 || files[0].rel_path !== 'v1-5-Q4_0.gguf') throw new Error(JSON.stringify(files));
"""
    result = subprocess.run([node, "--input-type=module", "-e", script], capture_output=True, text=True, timeout=20)
    assert result.returncode == 0, result.stderr


def test_sd_cpp_is_local_only_and_uses_safe_checkpoint_defaults():
    serve = SERVE.read_text(encoding="utf-8")
    cookbook = COOKBOOK.read_text(encoding="utf-8")
    assert "if (!target?.host && _isStableDiffusionCppCandidate(model))" in serve
    assert "_selectedGgufExpr(m, repo, selectedGguf.rel_path)" in serve
    assert 'data-field="sd_gguf_file"' in serve
    assert "Choose a cached GGUF checkpoint or enter a local .safetensors/.ckpt path first." in serve
    assert "--backend ${sdBackend}`" in cookbook
    assert "const binary = useVulkan ? (useZVram ? 'sd-server-zvram' : 'sd-server-vulkan') : 'sd-server';" in cookbook
    assert "does not load arbitrary Diffusers pipelines, FLUX, or video models" in serve


def test_flux2_klein_components_and_launch_defaults():
    serve = SERVE.read_text(encoding="utf-8")
    cookbook = COOKBOOK.read_text(encoding="utf-8")
    assert "safetensors_files" in serve
    assert "data-field=\"flux2_diffusion_file\"" in serve
    assert "data-field=\"flux2_llm_file\"" in serve
    assert "data-field=\"flux2_vae_file\"" in serve
    assert "f._flux2_llm_path && f._flux2_vae_path" in serve
    assert "Choose cached FLUX.2 diffusion, Qwen3 4B, and VAE files" in serve
    assert "--diffusion-model" in cookbook
    assert "--llm ${llm}" in cookbook
    assert "--vae ${vae}" in cookbook
    assert "--cfg-scale ${cfg}" in cookbook
    assert "--steps ${steps}" in cookbook
    assert "sd-server-zvram" in cookbook
    assert "Use zVram memory management (Vulkan)" in serve
    assert "Paging can be slow" in serve
    assert "const sdBackend = useZVram ? (f.flux2 ? 'diffusion=vulkan0,te=cpu,vae=cpu' : 'diffusion=vulkan0')" in cookbook
    assert "if (useZVram) cmd += ' --auto-fit off';" in cookbook
    assert "zvram --vulkan-recover-local -- sd-server-vulkan" in (ROOT / "scripts/sd-server-zvram").read_text(encoding="utf-8")
    assert "flux2MissingAtRender.length" in serve
    assert "downloadFlux2KleinBundle(panel, variant, undefined, missingKinds)" in serve


def test_flux2_cache_accepts_alias_and_exact_qwen_encoder():
    node = shutil.which("node")
    if not node:
        pytest.skip("Node.js is unavailable")
    source = SERVE.read_text(encoding="utf-8")
    match = re.search(r"function _cachedFlux2Files\(kind, selectedRepo = ''\) \{.*?\n\}", source, re.S)
    assert match, "expected the cached FLUX.2 component filter"
    script = "const _cachedAllModels = " + r"""[
{repo_id:'Comfy-Org/flux2-klein-4B',status:'ready',safetensors_files:[
  {name:'qwen_3_4b.safetensors',rel_path:'snap/split_files/text_encoders/qwen_3_4b.safetensors'},
  {name:'qwen_3_4b_fp4.safetensors',rel_path:'snap/split_files/text_encoders/qwen_3_4b_fp4.safetensors'},
  {name:'flux2-vae.safetensors',rel_path:'snap/split_files/vae/flux2-vae.safetensors'}]},
{repo_id:'other/Qwen3-4B',status:'ready',safetensors_files:[{name:'qwen_3_4b.safetensors',rel_path:'qwen_3_4b.safetensors'}]}
];
""" + match.group(0) + r"""
const assert = (ok, message) => { if (!ok) throw new Error(message); };
assert(_cachedFlux2Files('llm').length === 1, 'only exact cached Qwen3 4B encoder should match');
assert(_cachedFlux2Files('llm')[0].file.name === 'qwen_3_4b.safetensors', 'wrong encoder selected');
assert(_cachedFlux2Files('vae').length === 1, 'Klein VAE from the downloaded alias should match');
"""
    result = subprocess.run([node, "--input-type=module", "-e", script], capture_output=True, text=True, timeout=20)
    assert result.returncode == 0, result.stderr
