"""Focused lifecycle parsing checks for native stable-diffusion.cpp serves."""

import re
import shutil
import subprocess
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parent.parent
RUNNING = ROOT / "static/js/cookbookRunning.js"


def _function(source, start, end):
    match = re.search(start + r".*?\n}\n", source, re.S)
    assert match, f"could not find function {start}"
    return match.group(0).rstrip()


def test_sd_cpp_lifecycle_and_native_ready_marker_in_node():
    node = shutil.which("node")
    if not node:
        pytest.skip("Node.js is unavailable")
    source = RUNNING.read_text(encoding="utf-8")
    parse_phase = _function(source, r"export function _parseServePhase\(snapshot\) \{", None)
    expected = _function(source, r"function _serveExpectedModel\(task\) \{", None)
    image_task = _function(source, r"function _isImageServeTask\(task\) \{", None)
    ready = _function(source, r"function _serveOutputLooksReady\(task\) \{", None)
    script = "\n".join([
        parse_phase.replace("export function", "function"),
        image_task,
        expected,
        ready,
        r"""
const assert = (ok, message) => { if (!ok) throw new Error(message); };
for (const binary of ['sd-server', 'sd-server-cpu', 'sd-server-vulkan', 'sd-server-zvram', '/opt/bin/sd-server-vulkan.exe']) {
  const task = {payload:{_cmd:`${binary} --listen-port 18123`,repo_id:'black-forest-labs/FLUX.2-klein-4B',_fields:{model_path:'/cache/flux.safetensors'}}};
  assert(_isImageServeTask(task), `${binary} should be an image serve`);
  assert(_serveExpectedModel(task) === 'sd-cpp-local', `${binary} should use the stable local endpoint ID`);
}
assert(!_isImageServeTask({payload:{_cmd:'llama-server -m model.gguf'}}), 'LLM server should not be classified as image serve');
const marker = '[I] listening on: http://127.0.0.1:18123 --- main.cpp:151';
assert(_parseServePhase(marker).status === 'ready', 'native listener marker should parse ready');
assert(_serveOutputLooksReady({output:marker}), 'native listener marker should mark output ready');
assert(!_serveOutputLooksReady({output:'loading diffusion model'}), 'loading output should not mark ready');
""",
    ])
    result = subprocess.run([node, "--input-type=module", "-e", script], capture_output=True, text=True, timeout=20)
    assert result.returncode == 0, result.stderr


def test_sd_cpp_command_parser_and_gpu_preflight_include_native_server():
    source = RUNNING.read_text(encoding="utf-8")
    assert "backend: /(?:^|[\\s/])sd-server(?:-(?:cpu|vulkan|zvram))?(?:\\.exe)?(?=\\s|$)/i.test(cmd) ? 'stable-diffusion.cpp'" in source
    assert "ex(/--listen-port\\s+(\\d+)/)" in source
    assert "sd-server(?:-(?:cpu|vulkan|zvram))?(?:\\.exe)?" in source
    assert "const ownedEndpointId = task.payload?._endpointId || '';" in source
    assert "e.id === ownedEndpointId" in source
    assert "return 'sd-cpp-local';" in source


def test_native_listen_port_used_by_every_endpoint_lookup():
    source = RUNNING.read_text()
    endpoint = _function(source, r"function _endpointUrlForTask\(task, outputText = ''\) \{", None)
    node = shutil.which("node")
    if not node:
        pytest.skip("Node.js is unavailable")
    script = "const _taskLooksOllama=()=>false; const _taskRemoteHost=()=>''; const _connectHostFromRemote=()=> 'localhost';\n" + endpoint + "\n" + r"""
for (const flag of ['--listen-port 18123', '--listen-port=18123', '--port 18123']) {
 const url = _endpointUrlForTask({payload:{_cmd:'sd-server-zvram '+flag}});
 if (url !== 'http://localhost:18123/v1') throw new Error(url);
}
"""
    result = subprocess.run([node, '-e', script], capture_output=True, text=True, timeout=20)
    assert result.returncode == 0, result.stderr
    assert 'match(/--port' not in source


def test_background_registration_matches_address_not_reused_name():
    source = RUNNING.read_text()
    block = source[source.index('const readyServes ='):]
    assert "localTask?.payload?._cmd || t.cmd || ''" in block
    assert 'e.name === t.model' not in block
    assert 'e.base_url.includes(hostPort)' not in block
    node = shutil.which('node')
    if not node:
        pytest.skip('Node.js is unavailable')
    statement = re.search(r"const existing = eps.find\(.*?;", block).group(0)
    script = """
const baseUrl = 'http://localhost:18123/v1';
const eps = [
 {id:'old',name:'FLUX',base_url:'http://localhost:8000/v1'},
 {id:'other',name:'FLUX',base_url:'http://localhost:181230/v1'},
 {id:'right',name:'FLUX',base_url:baseUrl}
];
""" + statement + "\nif (existing.id !== 'right') throw new Error('wrong server');"
    result = subprocess.run([node, '-e', script], capture_output=True, text=True, timeout=20)
    assert result.returncode == 0, result.stderr
