const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(process.env.DOCUMENT_COPY_SOURCE || path.resolve(process.cwd(), 'static/js/document.js'), 'utf8');
const match = source.match(/async function copyDocument\(\) \{[\s\S]*?\n  \}/);
assert.ok(match, 'copyDocument function source found');
const copySource = match[0];

async function runCopyDocument({clipboard, uiModule}) {
  const calls = {success: 0, error: []};
  const document = {getElementById: id => id === 'doc-editor-textarea' ? {value: 'synthetic document text'} : null};
  const navigator = {clipboard: {writeText: async text => {
    assert.equal(text, 'synthetic document text');
    if (clipboard === 'reject') throw new Error('synthetic clipboard rejection');
  }}};
  const module = uiModule === 'helper-false'
    ? {copyToClipboard: async () => false, showToast: () => calls.success++, showError: message => calls.error.push(message)}
    : uiModule === 'helper-true'
      ? {copyToClipboard: async () => true, showToast: () => calls.success++, showError: message => calls.error.push(message)}
      : uiModule === 'fallback-with-error'
        ? {showToast: () => calls.success++, showError: message => calls.error.push(message)}
        : null;
  const copyDocument = new Function('document', 'navigator', 'uiModule', `return (${copySource});`)(document, navigator, module);
  const result = await copyDocument();
  return {result: result ?? null, ...calls};
}

let cases;
(async () => {
  cases = {
    fallbackRejectNoUi: await runCopyDocument({clipboard: 'reject', uiModule: null}),
    fallbackRejectWithErrorUi: await runCopyDocument({clipboard: 'reject', uiModule: 'fallback-with-error'}),
    fallbackResolve: await runCopyDocument({clipboard: 'resolve', uiModule: 'fallback-with-error'}),
    sharedHelperFalse: await runCopyDocument({clipboard: 'resolve', uiModule: 'helper-false'}),
    sharedHelperTrue: await runCopyDocument({clipboard: 'resolve', uiModule: 'helper-true'}),
  };
  assert.deepEqual(cases.fallbackRejectNoUi, {result: false, success: 0, error: []});
  assert.deepEqual(cases.fallbackRejectWithErrorUi, {result: false, success: 0, error: ['Could not copy']});
  assert.deepEqual(cases.fallbackResolve, {result: true, success: 1, error: []});
  assert.deepEqual(cases.sharedHelperFalse, {result: false, success: 0, error: []});
  assert.deepEqual(cases.sharedHelperTrue, {result: true, success: 1, error: []});
  process.stdout.write(JSON.stringify({pass: true, scope: 'source-bound extracted copyDocument function with synthetic DOM/UI/clipboard stubs; no OS clipboard or application content', cases}, null, 2) + '\n');
})().catch(error => { process.stdout.write(JSON.stringify({pass:false,cases},null,2)+'\n'); process.stderr.write((error.stack || String(error)) + '\n'); process.exitCode = 1; });
