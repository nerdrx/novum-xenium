"""Exercise the model-list HTTP handler used by the group picker."""
import shutil
import subprocess
import unittest
from pathlib import Path


_REPO = Path(__file__).resolve().parent.parent
_GROUP_JS = _REPO / "static" / "js" / "group.js"
_HAS_NODE = shutil.which("node") is not None


@unittest.skipUnless(_HAS_NODE, "node binary not on PATH")
class GroupModelFetchTests(unittest.TestCase):
    def test_model_list_handler_rejects_failures_and_accepts_valid_items(self):
        proc = subprocess.run(
            ["node", "--input-type=module"],
            input=f"""
          import assert from 'node:assert/strict';
          import {{ readFile }} from 'node:fs/promises';
          import vm from 'node:vm';
          const source = await readFile({str(_GROUP_JS)!r}, 'utf8');
          const start = source.indexOf('async function loadGroupModelItems(');
          const end = source.indexOf('\\n}}\\n', start) + 2;
          assert.ok(start >= 0 && end > start, 'production model handler found');
          const handler = vm.runInNewContext(source.slice(start, end) + '; loadGroupModelItems');
          const items = [{{ models: ['provider/model'] }}];
          assert.deepEqual(await handler(async (url, options) => {{
            assert.equal(url, '/api/models');
            assert.equal(options.credentials, 'same-origin');
            return {{ ok: true, json: async () => ({{ items }}) }};
          }}, ''), items);
          await assert.rejects(handler(async () => ({{ ok: false, status: 503 }}), ''), /503/);
          await assert.rejects(handler(async () => ({{ ok: true, json: async () => ({{ items: {{}} }}) }}), ''), /invalid response/);
          await assert.rejects(handler(async () => ({{ ok: true, json: async () => ({{ items: [null] }}) }}), ''), /invalid response/);
          await assert.rejects(handler(async () => ({{ ok: true, json: async () => ({{ items: [{{ models: 'bad' }}] }}) }}), ''), /invalid response/);
          let attempt = 0;
          const retryingFetch = async () => {{
            attempt++;
            if (attempt === 1) throw new Error('offline');
            return {{ ok: true, json: async () => ({{ items }}) }};
          }};
          await assert.rejects(handler(retryingFetch, ''), /offline/);
          assert.deepEqual(await handler(retryingFetch, ''), items);
            """,
            capture_output=True,
            text=True,
            cwd=str(_REPO),
            timeout=30,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)


if __name__ == "__main__":
    unittest.main()
