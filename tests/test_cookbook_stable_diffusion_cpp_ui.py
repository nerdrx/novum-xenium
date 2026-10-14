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
assert(!_isStableDiffusionCppCandidate({repo_id:'meta-llama/llama-2-7b-GGUF',_tag:'llm'}), 'arbitrary GGUF LLM must stay excluded');
assert(!_isStableDiffusionCppCandidate({repo_id:'black-forest-labs/FLUX.1-dev',is_diffusion:true}), 'FLUX pipeline must stay excluded');
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
    assert "--backend ${useVulkan ? 'diffusion=vulkan0' : 'cpu'}" in cookbook
    assert "const binary = useVulkan ? 'sd-server-vulkan' : 'sd-server';" in cookbook
    assert "does not load arbitrary Diffusers pipelines, FLUX, or video models" in serve
