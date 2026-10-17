"""Focused checks for the targeted FLUX.2 Klein download recipe."""

import re
import shutil
import subprocess
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parent.parent
DOWNLOAD = ROOT / "static/js/cookbookDownload.js"


def test_flux2_klein_recipe_targets_only_supported_components_in_node():
    node = shutil.which("node")
    if not node:
        pytest.skip("Node.js is unavailable")
    source = DOWNLOAD.read_text(encoding="utf-8")
    shared = re.search(r"const FLUX2_KLEIN_SHARED_COMPONENTS = \[.*?\n\];", source, re.S)
    recipe = re.search(r"export function flux2KleinDownloadRecipe\(variant\) \{.*?\n\}", source, re.S)
    bundle = re.search(r"export async function downloadFlux2KleinBundle\(panel, variant, hostOverride, missingKinds = \[\]\) \{.*?\n\}", source, re.S)
    assert shared and recipe and bundle
    recipe_source = recipe.group(0).replace("export function", "function", 1)
    bundle_source = bundle.group(0).replace("export async function", "async function", 1)
    script = (
        "const calls=[];\n"
        + "const flux2KleinDownloadRecipe = new Function("
        + repr(shared.group(0) + "\n" + recipe_source + "\nreturn flux2KleinDownloadRecipe;")
        + ")();\n"
        + "const download = new Function('flux2KleinDownloadRecipe', '_runModelDownload', "
        + repr(bundle_source + "\nreturn downloadFlux2KleinBundle;")
        + ")(flux2KleinDownloadRecipe, async (...args) => { calls.push(args); });\n"
        + r"""
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const recipe = flux2KleinDownloadRecipe;
for (const [variant, expectedRepo, expectedFile] of [
  ['klein4b', 'black-forest-labs/FLUX.2-klein-4B', 'flux-2-klein-4b.safetensors'],
  ['base4b', 'black-forest-labs/FLUX.2-klein-base-4B', 'flux-2-klein-base-4b.safetensors'],
]) {
  const files = recipe(variant);
  assert(files.length === 3, `${variant} should request exactly three files`);
  assert(files[0].repo_id === expectedRepo && files[0].include === expectedFile, `${variant} diffusion target changed`);
  assert(files[1].repo_id === files[2].repo_id, 'shared components should use the same public repo');
  assert(files[1].include === 'split_files/text_encoders/qwen_3_4b.safetensors', 'Qwen3 encoder target changed');
  assert(files[2].include === 'split_files/vae/flux2-vae.safetensors', 'Klein VAE target changed');
  assert(files.every(file => file.include && !file.include.includes('*')), 'recipe must never download full repositories');
}
let rejected = false;
try { recipe('9b'); } catch (error) { rejected = error instanceof RangeError; }
assert(rejected, 'unsupported variants should fail closed');
await download({ id: 'panel' }, 'klein4b', 'gpu-box');
assert(calls.length === 3, 'bundle should enqueue all three components');
assert(calls.every(call => call[0].id === 'panel' && call[1].download_include && call[2] === 'stable-diffusion.cpp' && call[3] === 'gpu-box'), 'bundle should route each component through the selected server');
calls.length = 0;
await download({ id: 'panel' }, 'base4b', 'gpu-box', ['llm', 'vae']);
assert(calls.length === 2, 'bundle should enqueue only missing components');
assert(calls[0][1].download_include === 'split_files/text_encoders/qwen_3_4b.safetensors' && calls[1][1].download_include === 'split_files/vae/flux2-vae.safetensors', 'missing component kinds should map to encoder and VAE');
calls.length = 0;
await download({ id: 'panel' }, 'klein4b', 'gpu-box', []);
assert(calls.length === 3, 'empty missing-kind list should retain full-bundle behavior');
let badKind = false;
try { await download({ id: 'panel' }, 'klein4b', 'gpu-box', ['other']); } catch (error) { badKind = error instanceof RangeError; }
assert(badKind, 'unknown component kinds should fail closed');
"""
    )
    result = subprocess.run([node, "--input-type=module", "-e", script], capture_output=True, text=True, timeout=20)
    assert result.returncode == 0, result.stderr


def test_bfl_download_defaults_to_bundle_but_preserves_explicit_include_and_host():
    node = shutil.which("node")
    if not node:
        pytest.skip("Node.js is unavailable")
    source = DOWNLOAD.read_text(encoding="utf-8")
    helpers = re.search(r"const FLUX2_KLEIN_SHARED_COMPONENTS = \[.*?\n\];", source, re.S)
    recipe = re.search(r"export function flux2KleinDownloadRecipe\(variant\) \{.*?\n\}", source, re.S)
    bundle = re.search(r"export async function downloadFlux2KleinBundle\(.*?\n\}", source, re.S)
    run = re.search(
        r"export async function _runModelDownload\(.*?(?=\n// ── Init ──)", source, re.S
    )
    assert helpers and recipe and bundle and run
    declarations = "\n".join((
        helpers.group(0),
        recipe.group(0).replace("export function", "function", 1),
        bundle.group(0).replace("export async function", "async function", 1),
        run.group(0).replace("export async function", "async function", 1),
    ))
    script = r"""
const requests = [];
let _envState = {env:'none', envPath:'', hfToken:'', servers:[]};
const _downloadStartsInFlight = new Set();
const uiModule = {showToast() {}};
const window = {cookbookModule:{_serverKey:()=> 'gpu-key'}};
const document = {getElementById:()=>null};
const _getPanelFields = () => ({});
const _syncEnvFromPanel = () => {};
const _ggufDownloadSource = () => null;
const _downloadTaskName = name => name;
const _serverByVal = key => key === 'gpu.example'
  ? {host:'gpu.example', name:'GPU', port:2222, platform:'linux'} : null;
const _getPort = () => 22;
const _isWindows = () => false;
const _buildEnvPrefix = () => '';
const _loadTasks = () => [];
const _saveTasks = () => {};
const _renderRunningTab = () => {};
const _addTask = () => {};
const _fetchDownloadControlWithTimeout = async (_url, init) => {
  requests.push(JSON.parse(init.body));
  return {ok:true, json:async()=>({ok:true,session_id:'fixture'})};
};
__FUNCTIONS__
const panel = {querySelectorAll:()=>[]};
await _runModelDownload(panel, {name:'black-forest-labs/FLUX.2-klein-4B'}, 'stable-diffusion.cpp', 'gpu.example');
if (requests.length !== 3) throw new Error(`Expected three default downloads, got ${requests.length}`);
const expected = [
  ['black-forest-labs/FLUX.2-klein-4B', 'flux-2-klein-4b.safetensors'],
  ['Comfy-Org/vae-text-encorder-for-flux-klein-4b', 'split_files/text_encoders/qwen_3_4b.safetensors'],
  ['Comfy-Org/vae-text-encorder-for-flux-klein-4b', 'split_files/vae/flux2-vae.safetensors'],
];
for (const request of requests) {
  if (!request.remote_host || request.remote_host !== 'gpu.example') throw new Error(`Bundle lost selected remote host: ${JSON.stringify(request)}`);
  const index = expected.findIndex(([repo, include]) => repo === request.repo_id && include === request.include);
  if (index < 0) throw new Error(`Unexpected bundle component: ${request.repo_id} ${request.include}`);
  expected.splice(index, 1);
}
if (expected.length) throw new Error('Default bundle omitted a component');
requests.length = 0;
await _runModelDownload(panel, {
  name:'black-forest-labs/FLUX.2-klein-4B',
  download_include:'custom/explicit-file.safetensors',
}, 'stable-diffusion.cpp', 'gpu.example');
if (requests.length !== 1) throw new Error('Explicit file selection must bypass default bundle');
if (requests[0].repo_id !== 'black-forest-labs/FLUX.2-klein-4B'
    || requests[0].include !== 'custom/explicit-file.safetensors'
    || requests[0].remote_host !== 'gpu.example') throw new Error('Explicit include or remote host was changed');
""".replace("__FUNCTIONS__", declarations)
    result = subprocess.run(
        [node, "--input-type=module", "-e", script], capture_output=True, text=True, timeout=20
    )
    assert result.returncode == 0, result.stderr
