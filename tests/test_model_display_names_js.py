"""Keep model display names readable without changing routing IDs."""

import json
import shutil
import subprocess
from pathlib import Path

import pytest


_MODULE = (Path(__file__).resolve().parents[1] / "static/js/modelDisplay.js").as_uri()


def test_model_display_alias_and_safe_fallback():
    if not shutil.which("node"):
        pytest.skip("node is not installed")
    script = f"""
      import assert from 'node:assert/strict';
      import {{ resolveModelDisplayName }} from {json.dumps(_MODULE)};
      const catalog = [{{ models: ['nx-model-5'], models_display: ['Llama 3.1 8B'] }}];
      assert.equal(resolveModelDisplayName('nx-model-5', catalog), 'Llama 3.1 8B');
      assert.equal(resolveModelDisplayName('vendor/nx-model-5', catalog, value => value.split('/').pop()), 'Llama 3.1 8B');
      assert.equal(resolveModelDisplayName('nx-model-5', []), 'nx-model-5');
      assert.equal(resolveModelDisplayName('extra-model', [{{
        models: ['primary-model', 'id-without-display'],
        models_display: ['Primary Display'],
        models_extra: ['extra-model'],
        models_extra_display: ['Extra Display'],
      }}]), 'Extra Display');
      assert.equal(resolveModelDisplayName('nx-model-5', [
        {{ models: ['nx-model-5'], models_display: ['Llama 3.1 8B'] }},
        {{ models: ['nx-model-5'], models_display: ['Qwen 3.5'] }},
      ]), 'nx-model-5');
    """
    result = subprocess.run(
        ["node", "--input-type=module"], input=script, text=True,
        capture_output=True, check=False,
    )
    assert result.returncode == 0, result.stderr
