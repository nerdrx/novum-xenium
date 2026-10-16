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
    def test_group_model_identity_preserves_endpoint_duplicates_and_display_alignment(self):
        proc = subprocess.run(
            ["node", "--input-type=module"],
            input=f"""
          import assert from 'node:assert/strict';
          import {{ readFile }} from 'node:fs/promises';
          import vm from 'node:vm';
          const source = await readFile({str(_GROUP_JS)!r}, 'utf8');
          const start = source.indexOf('export function groupModelKey(');
          const end = source.indexOf('async function loadGroupModelItems(', start);
          assert.ok(start >= 0 && end > start, 'production group model mapping found');
          const helperSource = source.slice(start, end).replaceAll('export function ', 'function ');
          const context = vm.createContext({{ sortModelObjects: rows => rows, URL }});
          vm.runInContext(helperSource + ';globalThis.result = buildGroupModelItems;globalThis.key = groupModelKey;', context);
          const models = context.result([
            {{ endpoint_id: 1, endpoint_name: 'Regular', url: 'https://regular.test/v1', models: ['same', 'regular-two'], models_display: ['Same regular'] }},
            {{ endpoint_id: 2, endpoint_name: 'zVram · Local models', url: 'http://zvram.test/v1', models: ['same'], models_display: ['Same zVram'] }},
            {{ endpoint_id: 3, endpoint_name: 'Images', url: 'https://images.test/v1', model_type: 'image', models: ['image-only'] }},
          ]);
          assert.equal(models.length, 3);
          assert.deepEqual(Array.from(models, m => m.display), ['Same regular', 'regular-two', 'Same zVram']);
          assert.deepEqual(Array.from(models, m => m.providerName), ['Regular', 'Regular', 'zVram · Local models']);
          assert.notEqual(models[0].key, models[2].key);
          assert.equal(models[1].display, 'regular-two', 'missing display entries must not shift parallel arrays');
          assert.equal(context.key(models[0]), context.key({{ endpointId: 1, mid: 'same' }}));
          assert.equal(models.find(m => m.key === models[0].key).url, 'https://regular.test/v1');
          assert.equal(models.find(m => m.key === models[2].key).endpointId, '2');
          assert.ok(source.includes('models.find(m => m.key === modelSel.value)'), 'participant selection resolves full endpoint identity');
            """,
            capture_output=True,
            text=True,
            cwd=str(_REPO),
            timeout=30,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)

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
