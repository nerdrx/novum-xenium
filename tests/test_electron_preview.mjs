import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, chmod, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { ELECTRON_WORKER_SOURCE, resolveWorkspaceProject, runOwnedCommand } from '../scripts/electron_preview.mjs';

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
      url() { return 'file:///fixture/index.html'; }
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
    context.pages = () => [page];
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

  await writeFile(path.join(root, '.trigger-asset-failure'), '1');
  const failedAssetRun = spawn(node, [helper, '--workspace', root, '--timeout', '15'], { stdio: 'ignore', env });
  const failedAssetResult = await new Promise(resolve => failedAssetRun.once('close', code => resolve({ code })));
  assert.equal(failedAssetResult.code, 1, 'failed requests and HTTP errors must fail the preview');
  const allRuns = (await readdir(outputDir)).filter(name => name.startsWith('run-'));
  assert.equal(allRuns.length, 3);
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
