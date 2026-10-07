"""Run actual group controller: continuation, limits, cancellation and errors."""
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]


@pytest.mark.parametrize('scenario', ['limit', 'concurrent', 'stop', 'stale', 'toggle', 'single', 'parallel', 'http-error', 'sse-error', 'early-eof', 'sync-error', 'context', 'approval', 'deny', 'ask-stop', 'ask-stale', 'question', 'tool-events', 'guard-persisted', 'guard-legacy', 'intent-stop', 'budget-stop', 'rounds-stop'])
def test_group_conversation(scenario):
    if not shutil.which('node'):
        pytest.skip('node is not installed')
    result = subprocess.run(
        ['node', '--experimental-default-type=module', 'tests/helpers/test_group_conversation.js', scenario],
        text=True, capture_output=True, cwd=ROOT, timeout=15)
    assert result.returncode == 0, result.stderr
