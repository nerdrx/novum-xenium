const assert = require('node:assert/strict');
const fs = require('node:fs');
const source = fs.readFileSync('static/app.js', 'utf8');
const match = source.match(/function handleSubmit\(e\) \{([\s\S]*?)\n  \}\n\n  chatForm\.onsubmit = handleSubmit;/);
assert.ok(match, 'Find the production submit handler');

function runSubmit(workspaceAuthError) {
  const calls = { toast: [], add: 0, hide: 0, send: 0, original: 0 };
  const input = { value: 'keep this draft' };
  const workspaceModule = { getWorkspaceAvailabilityError: () => workspaceAuthError };
  const uiModule = { showToast: text => calls.toast.push(text) };
  const groupModule = { isActive: () => true, isRunning: () => false, sendMessage: () => calls.send++ };
  const chatRenderer = { hideWelcomeScreen: () => calls.hide++, addMessage: () => calls.add++ };
  const document = { getElementById: id => id === 'message' ? input : null };
  const chatForm = { dataset: {} };
  const handler = new Function('workspaceModule', 'uiModule', 'groupModule', 'chatRenderer', 'document', 'chatForm', 'input', 'calls', 'setTimeout', `
    let _submitting = false;
    const _bumpChatPriority = () => {};
    const compareModule = null;
    const chatModule = {};
    const originalSubmit = () => { calls.original++; };
    return function handleSubmit(e) {${match[1]}\n    };
  `)(workspaceModule, uiModule, groupModule, chatRenderer, document, chatForm, input, calls, fn => fn());
  let prevented = false;
  handler({ preventDefault() { prevented = true; } });
  return { calls, input, prevented };
}

for (const reason of ['Account verification required', 'Your account changed. Reload before choosing a workspace.']) {
  const { calls, input, prevented } = runSubmit(reason);
  assert.equal(prevented, true);
  assert.equal(input.value, 'keep this draft');
  assert.deepEqual([calls.add, calls.hide, calls.send, calls.original], [0, 0, 0, 0]);
  assert.equal(calls.toast[0], reason);
}
const empty = runSubmit('');
assert.equal(empty.input.value, '');
assert.deepEqual([empty.calls.add, empty.calls.hide, empty.calls.send], [1, 1, 1]);
console.log(JSON.stringify({ suite: 'production app group submit guard', cases: 3, passed: true }));
