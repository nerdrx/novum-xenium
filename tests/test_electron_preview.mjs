import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, chmod, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { ELECTRON_WORKER_SOURCE, ensureOutputIgnore, resolveWorkspaceProject, runOwnedCommand } from '../scripts/electron_preview.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const node = process.execPath;

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'odysseus-electron-preview-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(path.join(root, 'node_modules/electron/dist'), { recursive: true });
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ main: 'src/main.js' }));
  await writeFile(path.join(root, 'src/main.js'), '/* fixture */');
  const electron = path.join(root, 'node_modules/electron/dist/electron');
  await writeFile(electron, '#!/bin/sh\nexit 0\n');
  await chmod(electron, 0o755);
  return root;
}

async function processState(pid) {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0];
  } catch { return ''; }
}

test('resolves only the local Electron manifest entry, executable, and test module', async t => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'smoke.mjs'), 'export default async () => true;');
  const project = resolveWorkspaceProject(root, 'smoke.mjs');
  assert.equal(project.workspace, root);
  assert.equal(project.entryPath, path.join(root, 'src/main.js'));
  assert.equal(project.electronPath, path.join(root, 'node_modules/electron/dist/electron'));
  assert.equal(project.testScript, path.join(root, 'smoke.mjs'));
});

test('preview output is locally ignored without replacing an existing user ignore file', async t => {
  const root = await fixture(t);
  const gitInit = spawnSync('git', ['init', '-q', root]);
  assert.equal(gitInit.status, 0);
  const output = path.join(root, '.odysseus-preview');
  await mkdir(output);
  ensureOutputIgnore(await import('node:fs'), output);
  assert.equal(await readFile(path.join(output, '.gitignore'), 'utf8'), '*\n');
  await mkdir(path.join(output, 'run'));
  await writeFile(path.join(output, 'run/report.json'), '{}');
  assert.equal(spawnSync('git', ['-C', root, 'check-ignore', '-q', '.odysseus-preview/run/report.json']).status, 0);
  await writeFile(path.join(output, '.gitignore'), 'keep-me\n');
  ensureOutputIgnore(await import('node:fs'), output);
  assert.equal(await readFile(path.join(output, '.gitignore'), 'utf8'), 'keep-me\n');
});

test('workspace-bound mode rejects a resolved project outside the active workspace', async t => {
  const root = await fixture(t);
  const helper = path.join(repo, 'scripts/electron_preview.mjs');
  const outside = path.join(path.dirname(root), 'outside-electron-project');
  await mkdir(outside, { recursive: true });
  t.after(() => rm(outside, { recursive: true, force: true }));
  const result = spawnSync(node, [helper, '--workspace-bound', '--workspace', '../outside-electron-project', '--timeout', '15'], {
    cwd: root, encoding: 'utf8',
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /must resolve inside the active workspace/);
  const outsideLink = path.join(root, 'outside-link');
  await symlink(outside, outsideLink);
  const linked = spawnSync(node, [helper, '--workspace-bound', '--workspace', 'outside-link', '--timeout', '15'], {
    cwd: root, encoding: 'utf8',
  });
  assert.equal(linked.status, 2);
  assert.match(linked.stderr, /must resolve inside the active workspace/);
});

test('rejects manifest, test-script, and Electron symlink escapes', async t => {
  const root = await fixture(t);
  const outside = path.join(path.dirname(root), 'outside-electron-fixture.js');
  await writeFile(outside, '/* outside */');
  t.after(() => rm(outside, { force: true }));

  await writeFile(path.join(root, 'package.json'), JSON.stringify({ main: '../outside-electron-fixture.js' }));
  assert.throws(() => resolveWorkspaceProject(root), /inside the workspace/);
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ main: 'src/main.js' }));

  await symlink(outside, path.join(root, 'smoke.mjs'));
  assert.throws(() => resolveWorkspaceProject(root, 'smoke.mjs'), /inside the workspace/);
  await rm(path.join(root, 'smoke.mjs'));

  const electron = path.join(root, 'node_modules/electron/dist/electron');
  await rm(electron);
  await symlink(outside, electron);
  assert.throws(() => resolveWorkspaceProject(root), /inside the workspace/);
});

test('timeout kills only the helper-owned process group', async t => {
  if (process.platform !== 'linux') return t.skip('process-group assertion uses Linux /proc');
  const root = await fixture(t);
  const pidFile = path.join(root, 'grandchild.pid');
  const childScript = path.join(root, 'owned-child.mjs');
  await writeFile(childScript, `
    import { spawn } from 'node:child_process';
    import { writeFileSync } from 'node:fs';
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    writeFileSync(process.argv[2], String(child.pid));
    setInterval(() => {}, 1000);
  `);

  const unrelated = spawn(node, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  t.after(() => { try { process.kill(unrelated.pid, 'SIGKILL'); } catch {} });
  const result = await runOwnedCommand(node, [childScript, pidFile], {
    timeoutMs: 500,
    stdio: 'ignore',
  });
  assert.equal(result.timedOut, true);
  assert.equal(result.code, 124);

  const grandchildPid = Number((await readFile(pidFile, 'utf8')).trim());
  for (let i = 0; i < 30; i++) {
    const state = await processState(grandchildPid);
    if (!state || state === 'Z') break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(['', 'Z'].includes(await processState(grandchildPid)), 'owned descendant should be stopped');
  assert.ok(await processState(unrelated.pid), 'unrelated process should remain alive');
});

test('hard cancellation of the outer Bash group stops the real helper launch tree only', async t => {
  if (process.platform !== 'linux') return t.skip('process-group assertion uses Linux /proc');
  const root = await fixture(t);
  const bin = path.join(root, 'fake-bin');
  const playwright = path.join(root, 'node_modules/playwright');
  const outputDir = path.join(root, '.odysseus-preview');
  const markerName = 'owned-' + path.basename(root) + '.json';
  let cancelledProfile = '';
  t.after(() => { if (cancelledProfile) return rm(cancelledProfile, { recursive: true, force: true }); });
  await mkdir(bin);
  await mkdir(playwright, { recursive: true });
  await writeFile(path.join(playwright, 'package.json'), JSON.stringify({ main: 'index.js' }));
  await writeFile(path.join(playwright, 'index.js'), `
    const { EventEmitter } = require('node:events');
    const fs = require('node:fs');
    const path = require('node:path');
    class Page extends EventEmitter {
      constructor(url = 'file:///fixture/index.html') { super(); this.pageUrl = url; }
      url() { return this.pageUrl; }
      isClosed() { return false; }
      async reload() {
        const config = JSON.parse(process.env.ODYSSEUS_PREVIEW_CONFIG || '{}');
        if (fs.existsSync(path.join(config.workspace, '.trigger-asset-failure'))) {
          this.emit('requestfailed', { url: () => 'https://assets.invalid/app.css', failure: () => ({errorText: 'net::ERR_FAILED'}) });
          this.emit('response', { status: () => 404, url: () => 'https://assets.invalid/app.css' });
        }
      }
      async waitForLoadState() {}
      async waitForTimeout() {}
      async setViewportSize() {}
      async evaluate() { return { title: 'fixture', url: this.url(), viewport: {width: 800, height: 600}, document: {width: 800, height: 600, horizontalOverflow: false}, html: {}, body: {text: 'fixture'}, controls: [] }; }
      async screenshot({path}) { fs.writeFileSync(path, 'fixture screenshot'); }
    }
    const page = new Page();
    const context = new EventEmitter();
    const pages = [page];
    context.pages = () => pages;
    context.openPopup = () => {
      const popup = new Page('file:///fixture/popup.html');
      pages.push(popup);
      context.emit('page', popup);
      return popup;
    };
    exports.chromium = { async connectOverCDP() {
      return { contexts: () => [context], close: async () => {} };
    }};
  `);
  const fakeXvfb = path.join(bin, 'xvfb-run');
  await writeFile(fakeXvfb, '#!/bin/sh\nshift\nshift\nexec "$@"\n');
  await chmod(fakeXvfb, 0o755);
  const electron = path.join(root, 'node_modules/electron/dist/electron');
  await writeFile(electron, `#!/usr/bin/env node
    const fs = require('node:fs');
    const path = require('node:path');
    const { spawn } = require('node:child_process');
    process.stderr.write('DBus warning: routine fixture startup notice\\n');
    const profile = process.argv.find(arg => arg.startsWith('--user-data-dir=')).slice('--user-data-dir='.length);
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio: 'ignore'});
    fs.writeFileSync(path.join(profile, 'DevToolsActivePort'), '9222\\n/devtools/browser/fixture\\n');
    fs.writeFileSync(path.join(profile, ${JSON.stringify(markerName)}), JSON.stringify({electron: process.pid, child: child.pid}));
    process.on('SIGTERM', () => { child.kill('SIGTERM'); process.exit(0); });
    setInterval(() => {}, 1000);
  `);
  await chmod(electron, 0o755);

  const unrelated = spawn(node, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  t.after(() => { try { process.kill(unrelated.pid, 'SIGKILL'); } catch {} });
  const env = { ...process.env, PATH: bin + path.delimiter + process.env.PATH };
  const helper = path.join(repo, 'scripts/electron_preview.mjs');
  const runner = spawn('bash', ['-c', 'exec "$1" "$2" --workspace "$3" --timeout 45', 'preview-outer', node, helper, root], {
    detached: true, stdio: 'ignore', env,
  });
  t.after(() => { try { process.kill(-runner.pid, 'SIGKILL'); } catch {} });

  let owned;
  for (let i = 0; i < 120; i++) {
    try {
      const tempDirs = await readdir(os.tmpdir());
      for (const name of tempDirs.filter(item => item.startsWith('odysseus-electron-preview-'))) {
        try {
          cancelledProfile = path.join(os.tmpdir(), name);
          owned = JSON.parse(await readFile(path.join(cancelledProfile, markerName), 'utf8'));
          break;
        } catch { cancelledProfile = ''; }
      }
      if (owned) break;
    } catch {}
    if (runner.exitCode !== null) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(owned, 'actual helper path should start its local Electron executable');
  assert.equal(await readFile(path.join(outputDir, '.gitignore'), 'utf8'), '*\n');
  try { process.kill(-runner.pid, 'SIGKILL'); } catch {}
  await new Promise(resolve => runner.once('close', resolve));
  for (const pid of [runner.pid, owned.electron, owned.child]) {
    for (let i = 0; i < 30; i++) {
      const state = await processState(pid);
      if (!state || state === 'Z') break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(['', 'Z'].includes(await processState(pid)), 'outer cancellation must stop PID ' + pid);
  }
  assert.ok(await processState(unrelated.pid), 'outer cancellation must preserve unrelated detached process');

  const retry = spawn(node, [helper, '--workspace', root, '--timeout', '15'], { stdio: 'ignore', env });
  const retryResult = await new Promise(resolve => retry.once('close', code => resolve({ code })));
  assert.equal(retryResult.code, 0, 'a cancelled preview must not leave a stale workspace lock');
  const completedRuns = (await readdir(outputDir)).filter(name => name.startsWith('run-'));
  assert.equal(completedRuns.length, 2, 'each preview must retain isolated artifacts in its own run directory');
  const reports = await Promise.all(completedRuns.map(async name => {
    try { return await readFile(path.join(outputDir, name, 'report.json'), 'utf8'); } catch { return ''; }
  }));
  assert.ok(reports.some(Boolean), 'retry should produce its own report');

  const popupScript = path.join(root, 'popup-test.mjs');
  await writeFile(popupScript, `
    export default async ({context}) => {
      const popup = context.openPopup();
      popup.emit('pageerror', new Error('popup renderer exploded'));
      popup.emit('console', {
        type: () => 'error', text: () => 'popup console exploded',
        location: () => ({url: 'file:///fixture/popup.js', lineNumber: 23, columnNumber: 7}),
      });
    };
  `);
  const popupRun = spawn(node, [helper, '--workspace', root, '--test-script', 'popup-test.mjs', '--timeout', '15'], { stdio: ['ignore', 'pipe', 'ignore'], env });
  let popupStdout = '';
  popupRun.stdout.setEncoding('utf8').on('data', chunk => { popupStdout += chunk; });
  const popupResult = await new Promise(resolve => popupRun.once('close', code => resolve({ code })));
  assert.equal(popupResult.code, 1, 'renderer errors in test-created popup pages must fail the preview');
  const runsAfterPopup = (await readdir(outputDir)).filter(name => name.startsWith('run-'));
  assert.equal(runsAfterPopup.length, 3);
  const popupReports = await Promise.all(runsAfterPopup.map(async name => {
    try { return JSON.parse(await readFile(path.join(outputDir, name, 'report.json'), 'utf8')); } catch { return null; }
  }));
  const popupReport = popupReports.find(report => report?.diagnostics?.pageErrors?.includes('popup renderer exploded'));
  assert.ok(popupReport, 'the report should include page errors from pages opened after CDP connection');
  assert.match(popupReport.diagnostics.pageErrorDetails[0].stack, /popup-test\.mjs/,
    'the report should retain renderer stack source frames');
  assert.deepEqual(popupReport.diagnostics.consoleErrorDetails[0].location, {
    url: 'file:///fixture/popup.js', lineNumber: 23, columnNumber: 7,
  });
  const leads = popupReport.electronDiagnosticLeads;
  assert.match(leads.processModel, /^https:\/\/www\.electronjs\.org\/docs\/latest\//);
  assert.match(leads.contextIsolation, /^https:\/\/www\.electronjs\.org\/docs\/latest\//);
  assert.match(leads.ipc, /^https:\/\/www\.electronjs\.org\/docs\/latest\//);
  assert.ok(leads.runtimeBoundaries.some(note => note.includes('BrowserWindow.webPreferences.preload')));
  assert.match(leads.note, /not a diagnosis or verified remediation/i);
  const popupSummary = JSON.parse(popupStdout.split('PREVIEW_RESULT: ')[1]);
  assert.equal(popupSummary.electronDiagnosticLeads.note, leads.note);
  assert.equal(popupSummary.electronDiagnosticLeads.runtimeBoundaries.length, 4);
  assert.match(popupSummary.errors.actualSourceFrames[0].stack, /popup-test\.mjs/);
  assert.match(popupSummary.errors.examples[0], /popup renderer exploded/,
    'renderer errors should outrank routine main-process stderr in examples');
  const rendererLead = popupStdout.slice(0, popupStdout.indexOf('PREVIEW_RESULT: ')).trim().split(/\r?\n/).at(-1);
  assert.match(rendererLead, /^RENDERER_ERROR: /,
    'the compact output should lead with labeled renderer evidence');
  const rendererDetails = JSON.parse(rendererLead.slice('RENDERER_ERROR: '.length));
  assert.equal(rendererDetails.message, 'popup renderer exploded');
  assert.ok(rendererDetails.sourceFrames.some(frame => /popup-test\.mjs/.test(frame)),
    'the leading renderer evidence should include source frames');
  assert.doesNotMatch(rendererLead, /DBus warning/);
  assert.deepEqual(popupSummary.errors.consoleLocations[0].location, {
    url: 'file:///fixture/popup.js', lineNumber: 23, columnNumber: 7,
  });
  assert.ok(popupStdout.length < 6000, 'source-location evidence should keep the summary bounded');

  await writeFile(path.join(root, '.trigger-asset-failure'), '1');
  const failedAssetRun = spawn(node, [helper, '--workspace', root, '--timeout', '15'], { stdio: 'ignore', env });
  const failedAssetResult = await new Promise(resolve => failedAssetRun.once('close', code => resolve({ code })));
  assert.equal(failedAssetResult.code, 1, 'failed requests and HTTP errors must fail the preview');
  const allRuns = (await readdir(outputDir)).filter(name => name.startsWith('run-'));
  assert.equal(allRuns.length, 4);
  const reportsAfterAssetFailure = await Promise.all(allRuns.map(async name => {
    try { return JSON.parse(await readFile(path.join(outputDir, name, 'report.json'), 'utf8')); } catch { return null; }
  }));
  const assetFailureReport = reportsAfterAssetFailure.find(report => report?.diagnostics?.failedRequests?.length);
  assert.equal(assetFailureReport?.status, 'runtime issues observed');
  assert.ok(assetFailureReport?.diagnostics?.badResponses?.some(value => value.startsWith('404 ')));
});

test('helper help documents bounded isolated workflow', async () => {
  const result = await new Promise((resolve, reject) => {
    const child = spawn(node, [path.join(repo, 'scripts/electron_preview.mjs'), '--help'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => resolve({ code, stdout, stderr }));
  });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /--workspace/);
  assert.match(result.stdout, /--no-sandbox affects only this isolated test run/);
});

test('embedded Electron worker parses as an ES module', () => {
  const result = spawnSync(node, ['--check', '--input-type=module'], {
    input: ELECTRON_WORKER_SOURCE, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
});
