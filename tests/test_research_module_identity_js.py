"""Agent-started research and the sidebar must share the same job store."""
import shutil
import subprocess
from pathlib import Path

import pytest


@pytest.mark.skipif(not shutil.which("node"), reason="node is not installed")
def test_chat_research_adoption_uses_sidebar_job_store():
    root = Path(__file__).resolve().parents[1]
    script = """
      import assert from 'node:assert/strict';
      import { readFileSync } from 'node:fs';
      import { pathToFileURL } from 'node:url';
      const panel = pathToFileURL(process.cwd() + '/static/js/research/panel.js');
      const stream = pathToFileURL(process.cwd() + '/static/js/chatStream.js');
      const panelSpec = readFileSync(panel, 'utf8').match(/import \\* as jobs from '([^']+)'/)[1];
      const streamSpec = readFileSync(stream, 'utf8').match(/import\\('([^']*research\\/jobs\\.js[^']*)'\\)/)[1];
      const sidebarJobs = await import(new URL(panelSpec, panel));
      const chatJobs = await import(new URL(streamSpec, stream));
      const job = chatJobs.addToQueue('Agent-started research', {});
      assert.ok(sidebarJobs.getJobs().includes(job), 'Sidebar must see the exact chat-adopted job');
      assert.equal(sidebarJobs, chatJobs, 'One module instance owns polling and cancellation');
    """
    result = subprocess.run(["node", "--input-type=module"], input=script,
                            text=True, capture_output=True, cwd=root, timeout=10)
    assert result.returncode == 0, result.stderr
