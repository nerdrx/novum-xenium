"""Behavioral coverage for the Admin Tools full-list save queue."""
import json
import re
import shutil
import subprocess
from pathlib import Path

import pytest


_ADMIN = Path(__file__).resolve().parent.parent / "static/js/admin.js"
_HAS_NODE = shutil.which("node") is not None


def _run_tool_saves(scenario):
    source = _ADMIN.read_text(encoding="utf-8")
    match = re.search(
        r"async function _saveToolState\(changes\) \{([\s\S]*?)\n"
        r"    \}\n    function _updateCatCounter",
        source,
    )
    assert match, "_saveToolState(changes) not found in static/js/admin.js"
    function_source = "async function _saveToolState(changes) {" + match.group(1) + "\n}"
    js = r"""
let disabled = new Set();
let failNextPost = false;
const posts = [];
const getTools = () => Promise.resolve({
  tools: ['a', 'b'].map(id => ({id, enabled: !disabled.has(id)})),
});
const fetch = async (_url, request) => {
  const body = JSON.parse(request.body);
  posts.push(body.disabled);
  if (failNextPost) {
    failNextPost = false;
    throw new Error('offline');
  }
  disabled = new Set(body.disabled);
  return {ok: true};
};
const invalidateTools = () => {};
const invalidateSettings = () => {};
const list = {querySelectorAll: () => []};
const _updateCatCounter = () => {};
let _toolStateSaveQueue = Promise.resolve();
""" + function_source + "\n" + scenario
    proc = subprocess.run(
        ["node", "--input-type=module"], input=js, capture_output=True,
        text=True, encoding="utf-8", timeout=30,
    )
    assert proc.returncode == 0, proc.stderr
    return json.loads(proc.stdout.strip())


@pytest.mark.skipif(not _HAS_NODE, reason="node binary not on PATH")
def test_overlapping_tool_toggles_merge_from_the_preceding_saved_state():
    result = _run_tool_saves(r"""
await Promise.all([
  _saveToolState([{id: 'a', enabled: false}]),
  _saveToolState([{id: 'b', enabled: false}]),
]);
console.log(JSON.stringify({posts, disabled: [...disabled].sort()}));
""")
    assert result == {"posts": [["a"], ["a", "b"]], "disabled": ["a", "b"]}


@pytest.mark.skipif(not _HAS_NODE, reason="node binary not on PATH")
def test_failed_tool_save_does_not_poison_later_queued_changes():
    result = _run_tool_saves(r"""
failNextPost = true;
const outcomes = await Promise.allSettled([
  _saveToolState([{id: 'a', enabled: false}]),
  _saveToolState([{id: 'b', enabled: false}]),
]);
await _saveToolState([{id: 'a', enabled: false}]);
console.log(JSON.stringify({
  outcomes: outcomes.map(value => value.status),
  posts,
  disabled: [...disabled].sort(),
}));
""")
    assert result == {
        "outcomes": ["rejected", "fulfilled"],
        "posts": [["a"], ["b"], ["a", "b"]],
        "disabled": ["a", "b"],
    }


@pytest.mark.skipif(not _HAS_NODE, reason="node binary not on PATH")
def test_reopened_tools_editor_waits_for_the_pending_save():
    source = _ADMIN.read_text(encoding="utf-8")
    function_source = source.split("async function loadBuiltinTools() {", 1)[1].split("async function loadMcpServers()", 1)[0]
    script = r"""
const list = {innerHTML: ''};
const el = () => list;
let release;
let reads = 0;
let _toolStateSaveQueue = new Promise(resolve => {release = resolve;});
const invalidateTools = () => {};
const getTools = async () => {reads++; return {tools: []};};
""" + "async function loadBuiltinTools() {" + function_source + r"""
const reopening = loadBuiltinTools();
await Promise.resolve();
const before = reads;
release();
await reopening;
console.log(JSON.stringify({before, after: reads, rendered: list.innerHTML}));
"""
    proc = subprocess.run(["node", "--input-type=module"], input=script, capture_output=True, text=True, timeout=30)
    assert proc.returncode == 0, proc.stderr
    result = json.loads(proc.stdout.strip())
    assert result["before"] == 0
    assert result["after"] == 1
    assert "No tools found" in result["rendered"]


@pytest.mark.skipif(not _HAS_NODE, reason="node binary not on PATH")
def test_failed_checkbox_save_reports_error_and_restores_server_state():
    source = _ADMIN.read_text(encoding="utf-8")
    match = re.search(
        r"    async function _saveToolChanges\(changes, catEl\) \{([\s\S]*?)\n"
        r"    \}\n\n    // Wire individual tool toggles",
        source,
    )
    assert match, "_saveToolChanges not found in static/js/admin.js"
    function_source = "async function _saveToolChanges(changes, catEl) {" + match.group(1) + "\n}"
    js = r"""
const errors = [];
let updates = 0;
let reloads = 0;
const uiModule = {showError: message => errors.push(message)};
const _toolStateSaveQueue = Promise.resolve();
const _saveToolState = async () => {throw new Error('Failed to update tools (500)');};
const _updateCatCounter = () => updates++;
const loadBuiltinTools = async () => {reloads++;};
const category = {};
""" + function_source + r"""
await _saveToolChanges([{id: 'bash', enabled: false}], category);
console.log(JSON.stringify({errors, updates, reloads}));
"""
    proc = subprocess.run(
        ["node", "--input-type=module"], input=js, capture_output=True,
        text=True, encoding="utf-8", timeout=30,
    )
    assert proc.returncode == 0, proc.stderr
    assert json.loads(proc.stdout.strip()) == {
        "errors": ["Failed to update tools: Failed to update tools (500)"],
        "updates": 0,
        "reloads": 1,
    }

    # Both individual and category toggles route through the rejection handler.
    assert "await _saveToolChanges([" in source
    assert "await _saveToolChanges(changes, catEl);" in source
