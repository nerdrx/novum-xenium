import subprocess
from pathlib import Path


_REPO = Path(__file__).resolve().parents[1]


def test_composer_drafts_are_bounded_and_account_scoped():
    source = (_REPO / "static/js/composerDrafts.js").read_text()
    source = source.replace("export function ", "function ")
    script = f"""
      const assert = require('node:assert/strict');
      const values = new Map();
      const storage = {{
        get length() {{ return values.size; }},
        key: index => [...values.keys()][index] ?? null,
        getItem: key => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, value),
        removeItem: key => values.delete(key),
      }};
      {source}

      assert.equal(saveComposerDraft('chat-a', 'unfinished', {{ accountId: 'alice', storage }}).persisted, true);
      saveComposerDraft('chat/one with space', 'encoded key', {{ accountId: 'alice', storage }});
      assert.equal(values.has('ody-composer-drafts:alice:chat%2Fone%20with%20space'), true);
      assert.equal(getComposerDraft('chat-a', {{ accountId: 'alice', storage }}), 'unfinished');
      assert.equal(getComposerDraft('chat-a', {{ accountId: 'bob', storage }}), '');
      saveComposerDraft('private-chat', 'secret', {{ accountId: 'alice', incognito: true, storage }});
      assert.equal(getComposerDraft('private-chat', {{ accountId: 'alice', incognito: true, storage }}), 'secret');
      assert.equal(JSON.stringify([...values.values()]).includes('secret'), false);
      memoryDrafts.delete(_draftKey('alice', 'private-chat')); // simulate page reload
      assert.equal(getComposerDraft('private-chat', {{ accountId: 'alice', storage }}), '');
      saveComposerDraft('chat-a', '', {{ accountId: 'alice', storage }}); // accepted send clears it
      assert.equal(getComposerDraft('chat-a', {{ accountId: 'alice', storage }}), '');
      saveComposerDraft('large', 'older saved draft', {{ accountId: 'alice', storage }});
      const large = 'x'.repeat(25000);
      assert.equal(saveComposerDraft('large', large, {{ accountId: 'alice', storage }}).reason, 'size');
      assert.equal(getComposerDraft('large', {{ accountId: 'alice', storage }}), large);
      assert.equal(storage.getItem('ody-composer-drafts:alice:large'), null);
      memoryDrafts.delete(_draftKey('alice', 'large')); // oversized draft is not persisted
      assert.equal(getComposerDraft('large', {{ accountId: 'alice', storage }}), '');
      for (let i = 0; i < 40; i++) saveComposerDraft('chat-' + i, 'draft', {{ accountId: 'alice', storage }});
      assert.equal(saveComposerDraft('chat-40', 'draft', {{ accountId: 'alice', storage }}).reason, 'count');
      assert.equal(getComposerDraft('chat-40', {{ accountId: 'alice', storage }}), 'draft');
      assert.equal([...values.keys()].filter(key => key.startsWith('ody-composer-drafts:alice:')).length, 40);
      const brokenStorage = {{ length: 0, key: () => null, getItem: () => null, removeItem: () => {{}}, setItem: () => {{ throw new Error('quota'); }} }};
      const failed = 'kept in memory';
      assert.equal(saveComposerDraft('chat-fail', failed, {{ accountId: 'alice', storage: brokenStorage }}).reason, 'storage');
      assert.equal(getComposerDraft('chat-fail', {{ accountId: 'alice', storage: brokenStorage }}), failed);
      Object.defineProperty(globalThis, 'localStorage', {{ configurable: true, get() {{ throw new Error('blocked'); }} }});
      assert.equal(saveComposerDraft('chat-blocked', failed, {{ accountId: 'alice' }}).reason, 'storage');
      assert.equal(getComposerDraft('chat-blocked', {{ accountId: 'alice' }}), failed);
      console.log('composer draft storage ok');
    """
    result = subprocess.run(
        ["node", "-e", script], capture_output=True, text=True, cwd=_REPO, timeout=30
    )
    assert result.returncode == 0, result.stderr
