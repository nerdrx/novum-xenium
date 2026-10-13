#!/usr/bin/env node
/** Run the selected workspace's real Electron app under private Xvfb. */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { constants } from 'node:fs';
import * as fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

const MAX_TIMEOUT_S = 45;
const OUTPUT_DIR_NAME = '.odysseus-preview';
const require = createRequire(import.meta.url);

export function ensureOutputIgnore(fsApi, outputDir) {
  try {
    fsApi.writeFileSync(path.join(outputDir, '.gitignore'), '*\n', { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
}

export function summarizeMainStderr(lines) {
  const values = Array.isArray(lines) ? lines.map(value => String(value)) : [];
  const handlerIndex = values.findIndex(value => /Error occurred in handler for\b/.test(value));
  if (handlerIndex >= 0) {
    // Electron can log a rejected IPC value as a multi-line object rather than
    // an Error stack. Keep its bounded diagnostic fields ahead of startup noise.
    const block = [values[handlerIndex].slice(0, 300)];
    for (const value of values.slice(handlerIndex + 1, handlerIndex + 8)) {
      if (!/^\s+|^\s*}/.test(value)) break;
      block.push(value.slice(0, 240));
      if (/^\s*}/.test(value)) break;
    }
    return [block.join('\n').slice(0, 740)];
  }
  const errorIndex = values.findIndex(value => /\b(?:[A-Za-z]*Error|Exception):/.test(value));
  if (errorIndex >= 0) {
    const location = values.slice(Math.max(0, errorIndex - 8), errorIndex)
      .reverse().find(value => /(?:^|[/\\])[^/\\\s:]+:\d+(?::\d+)?\s*$/.test(value));
    const exception = values[errorIndex].slice(0, 480);
    return [location
      ? `${exception}\n${location.slice(0, 240)}`.slice(0, 740)
      : exception];
  }
  return values.slice(0, 3).map(value => value.slice(0, 180));
}

function inside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

function resolveFileInside(root, value, label) {
  if (typeof value !== 'string' || !value || path.isAbsolute(value)) {
    throw new Error(`${label} must be a relative path inside the workspace`);
  }
  const resolved = fs.realpathSync(path.resolve(root, value));
  if (!inside(root, resolved) || !fs.statSync(resolved).isFile()) {
    throw new Error(`${label} must resolve to a file inside the workspace`);
  }
  return resolved;
}

export function resolveWorkspaceProject(rawWorkspace, rawTestScript = '') {
  const workspace = fs.realpathSync(rawWorkspace || process.cwd());
  if (!fs.statSync(workspace).isDirectory()) throw new Error('workspace is not a directory');
  const manifestPath = resolveFileInside(workspace, 'package.json', 'package.json');
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw new Error(`cannot parse package.json: ${error.message}`);
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('package.json must contain an object');
  }
  const entry = typeof manifest.main === 'string' && manifest.main.trim()
    ? manifest.main.trim() : 'index.js';
  const entryPath = resolveFileInside(workspace, entry, 'Electron manifest entry');
  const electronPath = resolveFileInside(
    workspace, 'node_modules/electron/dist/electron', 'workspace-local Electron executable',
  );
  if (!(fs.statSync(electronPath).mode & 0o111)) {
    throw new Error('workspace-local Electron executable is not executable');
  }
  let testScript = '';
  if (rawTestScript) testScript = resolveFileInside(workspace, rawTestScript, 'test script');
  return { workspace, manifestPath, manifest, entryPath, electronPath, testScript };
}

function findOnPath(name) {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, constants.X_OK);
      return fs.realpathSync(candidate);
    } catch { /* try next PATH entry */ }
  }
  return '';
}

function resolvePlaywright(workspace) {
  const local = path.join(workspace, 'node_modules/playwright');
  if (fs.existsSync(path.join(local, 'package.json'))) return fs.realpathSync(local);
  const cli = findOnPath('playwright-mcp');
  const bundled = cli && path.join(path.dirname(cli), 'node_modules/playwright');
  if (bundled && fs.existsSync(path.join(bundled, 'package.json'))) return fs.realpathSync(bundled);
  throw new Error('Playwright is unavailable; install/use an existing local or built-in Playwright package');
}

function parseArgs(argv) {
  const out = { workspace: process.cwd(), testScript: '', timeout: 35, noSandbox: false, workspaceBound: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--workspace' || arg === '--test-script' || arg === '--timeout') {
      const value = argv[++i];
      if (!value) throw new Error(`${arg} requires a value`);
      if (arg === '--workspace') out.workspace = value;
      else if (arg === '--test-script') out.testScript = value;
      else out.timeout = Number(value);
    } else if (arg === '--no-sandbox') {
      out.noSandbox = true;
    } else if (arg === '--workspace-bound') {
      out.workspaceBound = true;
    } else if (arg === '--help' || arg === '-h') {
      out.help = true;
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
  }
  if (!Number.isInteger(out.timeout) || out.timeout < 15 || out.timeout > MAX_TIMEOUT_S) {
    throw new Error(`--timeout must be an integer from 15 to ${MAX_TIMEOUT_S} seconds`);
  }
  return out;
}

export function previewStatus(rendererConnected, runtimeIssues, test) {
  if (!rendererConnected || runtimeIssues) return 'runtime issues observed';
  return test?.configured && test.status === 'completed'
    ? 'rendered; workspace test completed' : 'rendered; behavior unverified';
}

export function deriveControlStateChanges(records) {
  const attributeValue = (attributeName, value) => attributeName === 'disabled'
    ? value !== null : String(value ?? '').slice(0, 32);
  return records.flatMap((record, index) => {
    if (record.type !== 'attributes'
        || !['disabled', 'aria-disabled'].includes(record.attributeName)) return [];
    const next = records.slice(index + 1).find(candidate =>
      candidate.type === 'attributes' && candidate.target === record.target
      && candidate.attributeName === record.attributeName);
    const from = attributeValue(record.attributeName, record.oldValue);
    const to = attributeValue(record.attributeName,
      next ? next.oldValue : record.target.getAttribute(record.attributeName));
    return from === to ? [] : [{ target: record.target, field: record.attributeName, from, to }];
  });
}

export function appendControlTimelineEvent(events, event) {
  if (events.length >= 40) events.shift();
  events.push(event);
}

export const ELECTRON_WORKER_SOURCE = String.raw`
const ensureOutputIgnore = ${ensureOutputIgnore.toString()};
const previewStatus = ${previewStatus.toString()};
const summarizeMainStderr = ${summarizeMainStderr.toString()};
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import * as fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

const require = createRequire(import.meta.url);
const WORKSPACE_ACTION_TIMEOUT_MS = 5000;
const fail = (message) => { console.error('PREVIEW_ERROR: ' + message); process.exitCode = 1; };
let electronProcess;
let browser;
let profile = '';
let runDirectory = '';
let outputDir = '';
let runId = '';
let activePage = null;
let flushMainOutput = () => {};
let phase = 'initializing';
let workspace = '';
let appEntry = '';
let electronPath = '';
const diagnostics = {
  pageErrors: [], pageErrorDetails: [], consoleErrors: [], consoleErrorDetails: [],
  failedRequests: [], badResponses: [], mainStdout: [], mainStderr: [],
};
const cap = (array, value) => { if (array.length < 80) array.push(String(value).slice(0, 500)); };
const capLatest = (array, value) => {
  if (array.length >= 80) array.shift();
  array.push(String(value).slice(0, 500));
};
const capDetail = (array, value) => { if (array.length < 20) array.push(value); };
const cleanUrl = (value) => { try { const u = new URL(value); return (u.origin + u.pathname).slice(0, 300); } catch { return String(value).slice(0, 300); } };
const safeRm = (target, base) => {
  if (!target || !base) return;
  try {
    const st = fs.lstatSync(target);
    if (st.isSymbolicLink() || !st.isDirectory()) return;
    const real = fs.realpathSync(target);
    if (real === base || !real.startsWith(base + path.sep)) return;
    fs.rmSync(real, { recursive: true, force: true });
  } catch { /* already gone */ }
};

try {
  const config = JSON.parse(process.env.ODYSSEUS_PREVIEW_CONFIG || '{}');
  workspace = fs.realpathSync(config.workspace);
  const playwrightPath = config.playwrightPath;
  const outputStat = fs.lstatSync(config.outputDir);
  if (outputStat.isSymbolicLink() || !outputStat.isDirectory() || outputStat.uid !== process.getuid()) {
    throw new Error('preview output must be a real directory owned by the workspace user');
  }
  outputDir = fs.realpathSync(config.outputDir);
  const outputRel = path.relative(workspace, outputDir);
  if (outputRel === '..' || outputRel.startsWith('..' + path.sep) || path.isAbsolute(outputRel)) {
    throw new Error('preview output directory escapes the workspace');
  }
  appEntry = config.entryPath;
  electronPath = config.electronPath;
  const pw = require(playwrightPath);
  if (!pw.chromium?.connectOverCDP) throw new Error('installed Playwright package lacks Chromium CDP support');

  runId = randomUUID();
  runDirectory = path.join(outputDir, 'run-' + runId);
  fs.mkdirSync(runDirectory, { mode: 0o700 });
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'odysseus-electron-preview-' + process.getuid() + '-'));
  const desktopPath = path.join(runDirectory, 'desktop.png');
  const compactPath = path.join(runDirectory, 'compact.png');
  const reportPath = path.join(runDirectory, 'report.json');

  phase = 'launching Electron';
  const args = [workspace, '--user-data-dir=' + profile, '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', '--remote-allow-origins=*'];
  if (config.noSandbox) args.push('--no-sandbox');
  electronProcess = spawn(config.electronPath, args, {
    cwd: workspace, env: process.env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let electronLaunchError = null;
  electronProcess.on('error', error => { electronLaunchError = error; cap(diagnostics.mainStderr, error.message); });
  const collectOutput = (stream, bucket, latest = false) => {
    let pending = '';
    const add = latest ? value => capLatest(bucket, value) : value => cap(bucket, value);
    stream.setEncoding('utf8').on('data', chunk => {
      const lines = (pending + chunk).split(/\r?\n/);
      pending = lines.pop() || '';
      if (pending.length > 5000) pending = pending.slice(-5000);
      for (const line of lines) if (line.trim()) add(line);
    });
    const flush = () => { if (pending.trim()) add(pending); pending = ''; };
    stream.on('end', flush);
    return flush;
  };
  const outputFlushes = [
    electronProcess.stdout && collectOutput(electronProcess.stdout, diagnostics.mainStdout, true),
    electronProcess.stderr && collectOutput(electronProcess.stderr, diagnostics.mainStderr),
  ].filter(Boolean);
  flushMainOutput = () => outputFlushes.forEach(flush => flush());
  const devtoolsFile = path.join(profile, 'DevToolsActivePort');
  const deadline = Date.now() + Math.max(10000, (config.timeout - 10) * 1000);
  let endpoint = '';
  while (Date.now() < deadline) {
    if (electronLaunchError) throw new Error('could not start workspace Electron: ' + electronLaunchError.message);
    if (electronProcess.exitCode !== null) throw new Error('Electron exited before opening its private DevTools endpoint (exit ' + electronProcess.exitCode + ')');
    try {
      const port = Number(fs.readFileSync(devtoolsFile, 'utf8').split(/\r?\n/)[0]);
      if (Number.isInteger(port) && port > 0 && port < 65536) { endpoint = 'http://127.0.0.1:' + port; break; }
    } catch { /* Electron has not written its fresh profile endpoint yet */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!endpoint) throw new Error('Electron did not create a loopback DevTools endpoint before timeout');
  phase = 'connecting Playwright';
  browser = await pw.chromium.connectOverCDP(endpoint, { timeout: Math.max(5000, (config.timeout - 12) * 1000) });
  const context = browser.contexts()[0];
  if (!context) throw new Error('Electron DevTools endpoint exposed no browser context');
  const attachPageDiagnostics = target => {
    target.on('pageerror', error => {
      cap(diagnostics.pageErrors, error.message);
      capDetail(diagnostics.pageErrorDetails, {
        message: String(error.message || error).slice(0, 300),
        stack: String(error.stack || '').slice(0, 1600),
      });
    });
    target.on('console', message => {
      if (message.type() === 'error') {
        cap(diagnostics.consoleErrors, message.text());
        const location = message.location?.() || {};
        capDetail(diagnostics.consoleErrorDetails, {
          message: String(message.text()).slice(0, 300),
          location: {
            url: String(location.url || '').slice(0, 300),
            lineNumber: Number.isInteger(location.lineNumber) ? location.lineNumber : null,
            columnNumber: Number.isInteger(location.columnNumber) ? location.columnNumber : null,
          },
        });
      }
    });
    target.on('requestfailed', request => cap(
      diagnostics.failedRequests, cleanUrl(request.url()) + ': ' + (request.failure()?.errorText || 'failed'),
    ));
    target.on('response', response => {
      if (response.status() >= 400) cap(diagnostics.badResponses, response.status() + ' ' + cleanUrl(response.url()));
    });
  };
  const diagnosedPages = new WeakSet();
  const watchPage = target => {
    if (diagnosedPages.has(target)) return;
    diagnosedPages.add(target);
    attachPageDiagnostics(target);
  };
  context.on('page', watchPage);
  for (const openPage of context.pages()) watchPage(openPage);
  let page = context.pages().find(candidate => !candidate.url().startsWith('devtools:'));
  if (!page) page = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Electron opened no renderer page')), Math.max(5000, (config.timeout - 15) * 1000));
    context.once('page', target => { clearTimeout(timer); resolve(target); });
  });
  activePage = page;
  watchPage(page);
  phase = 'inspecting rendered page';
  // Revisit the initial document only after diagnostics are attached.
  await page.reload({ waitUntil: 'domcontentloaded', timeout: Math.max(5000, (config.timeout - 15) * 1000) }).catch(() => {});
  await page.waitForLoadState('domcontentloaded', { timeout: Math.max(5000, (config.timeout - 15) * 1000) }).catch(() => {});
  await page.waitForTimeout(250);
  const inspect = async (width, height, screenshot) => {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(150);
    const baseline = await page.evaluate(() => {
      const visible = element => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      const controls = [...document.querySelectorAll('button,input,select,textarea,a,[role="button"]')]
        .filter(visible).slice(0, 60).map(el => {
          const rect = el.getBoundingClientRect(), style = getComputedStyle(el);
          return {
            tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || '',
            label: (el.getAttribute('aria-label') || (el.labels ? [...el.labels].map(label => label.innerText.trim()).filter(Boolean).join(' ') : '') || el.innerText || el.getAttribute('placeholder') || el.getAttribute('title') || '').trim().slice(0, 120),
            disabled: !!el.disabled,
            rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
            belowViewport: rect.bottom > innerHeight,
            color: style.color, background: style.backgroundColor, fontSize: style.fontSize,
            borderRadius: style.borderRadius, boxShadow: style.boxShadow,
          };
        });
      const htmlStyle = getComputedStyle(document.documentElement);
      const bodyStyle = getComputedStyle(document.body);
      const documentWidth = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
      const documentHeight = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
      return {
        title: document.title, url: location.href,
        viewport: { width: innerWidth, height: innerHeight },
        document: { width: documentWidth, height: documentHeight,
          horizontalOverflow: documentWidth > innerWidth },
        html: { background: htmlStyle.backgroundColor, backgroundImage: htmlStyle.backgroundImage },
        body: { background: bodyStyle.backgroundColor, backgroundImage: bodyStyle.backgroundImage,
          color: bodyStyle.color, fontFamily: bodyStyle.fontFamily,
          text: (document.body?.innerText || '').slice(0, 1800) },
        controls,
      };
    });
    await page.screenshot({ path: screenshot, fullPage: false, animations: 'disabled', timeout: 10000 });
    return { ...baseline, screenshot };
  };
  const desktop = await inspect(1280, 800, desktopPath);
  const compact = await inspect(800, 600, compactPath);

  let test = { configured: false, status: 'not exercised; no workspace test script supplied' };
  if (config.testScript) {
    phase = 'loading workspace test';
    const mod = await import(pathToFileURL(config.testScript).href);
    const run = typeof mod.default === 'function' ? mod.default : mod.run;
    if (typeof run !== 'function') throw new Error('test script must export a default function or named run function');
    phase = 'running workspace test';
    // Bound implicit locator/action waits so a selector failure is reported
    // before the outer helper timeout; explicit per-call waits can override it.
    page.setDefaultTimeout(WORKSPACE_ACTION_TIMEOUT_MS);
    await page.evaluate(() => {
      const deriveChanges = ${deriveControlStateChanges.toString()};
      const appendEvent = ${appendControlTimelineEvent.toString()};
      const events = [];
      const selector = 'button,input,select,textarea,a,[role="button"]';
      const targetInfo = element => ({
        tag: String(element.tagName || '').toLowerCase().slice(0, 24),
        id: String(element.id || '').slice(0, 80),
      });
      for (const element of document.querySelectorAll(selector)) {
        const ariaDisabled = element.getAttribute('aria-disabled');
        if (element.disabled || ariaDisabled !== null) appendEvent(events, {
          kind: 'state', observedMs: Math.round(performance.now()),
          target: targetInfo(element), field: 'snapshot',
          disabled: !!element.disabled, ariaDisabled: ariaDisabled?.slice(0, 32) ?? null,
        });
      }
      const observeRecords = records => {
        for (const { target, ...change } of deriveChanges(records.slice(-80))) {
          appendEvent(events, {
            kind: 'state', observedMs: Math.round(performance.now()),
            target: targetInfo(target), ...change,
          });
        }
      };
      const observer = new MutationObserver(observeRecords);
      observer.observe(document.documentElement, {
        subtree: true, attributes: true, attributeOldValue: true,
        attributeFilter: ['disabled', 'aria-disabled'],
      });
      document.addEventListener('click', event => {
        const clicked = event.target instanceof Element ? event.target.closest(selector) : null;
        if (clicked) appendEvent(events, {
          kind: 'click', observedMs: Math.round(performance.now()), target: targetInfo(clicked),
        });
      }, true);
      window.__odysseusControlTimeline = {
        events,
        drain() { observeRecords(observer.takeRecords()); return events; },
      };
    });
    const value = await run({
      app: { pid: electronProcess.pid, executablePath: config.electronPath, exitCode: electronProcess.exitCode },
      page, context, artifacts: { outputDir, desktopPath, compactPath },
    });
    test = { configured: true, status: 'completed', result: value === undefined ? null : value };
    phase = 'workspace test completed';
  }

  flushMainOutput();
  const runtimeIssues = diagnostics.pageErrors.length || diagnostics.consoleErrors.length ||
    diagnostics.failedRequests.length || diagnostics.badResponses.length ||
    electronProcess.exitCode !== null;
  const electronDiagnosticLeads = runtimeIssues ? {
    note: 'Documentation leads for investigation; not a diagnosis or verified remediation.',
    processModel: 'https://www.electronjs.org/docs/latest/tutorial/process-model',
    contextIsolation: 'https://www.electronjs.org/docs/latest/tutorial/context-isolation',
    ipc: 'https://www.electronjs.org/docs/latest/tutorial/ipc',
    runtimeBoundaries: [
      'Attach preload through BrowserWindow.webPreferences.preload; it is not an HTML script.',
      'Keep privileged Electron APIs in preload/main and expose narrow APIs with contextBridge for renderer use.',
      'Values sent over IPC must be serializable.',
      'Use renderer error stacks/source locations to find source code; report JSON line numbers are not source locations.',
    ],
  } : undefined;
  const report = {
    status: previewStatus(!page.isClosed(), runtimeIssues, test),
    runId, workspace, appEntry: config.entryPath, electron: config.electronPath,
    rendererConnected: !page.isClosed(),
    viewportMode: 'Playwright renderer viewport emulation; native BrowserWindow bounds/resize unverified',
    desktop, compact, test, diagnostics, electronDiagnosticLeads,
    electronPid: electronProcess.pid, electronExitCode: electronProcess.exitCode,
    sandbox: config.noSandbox ? 'disabled for this explicit isolated test only' : 'default Electron/Chromium settings',
  };
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
  const summary = {
    status: previewStatus(!page.isClosed(), runtimeIssues, test),
    appEntry,
    rendererConnected: !page.isClosed(),
    viewports: [desktop.viewport, compact.viewport],
    viewportMode: 'emulated renderer viewport; native BrowserWindow size unverified',
    errors: {
      page: diagnostics.pageErrors.length,
      console: diagnostics.consoleErrors.length,
      requests: diagnostics.failedRequests.length,
      responses: diagnostics.badResponses.length,
      mainStdout: diagnostics.mainStdout.length,
      mainStderr: diagnostics.mainStderr.length,
      examples: [...diagnostics.pageErrors, ...diagnostics.consoleErrors,
        ...diagnostics.failedRequests, ...diagnostics.badResponses,
        ...summarizeMainStderr(diagnostics.mainStderr),
        ...diagnostics.mainStdout.slice(-3)].slice(0, 3).map(value => String(value).slice(0, 180)),
      mainStdoutExamples: diagnostics.mainStdout.slice(-3),
      mainStderrExamples: summarizeMainStderr(diagnostics.mainStderr),
      actualSourceFrames: diagnostics.pageErrorDetails.slice(0, 2).map(detail => ({ message: detail.message, stack: detail.stack.slice(0, 800) })),
      consoleLocations: diagnostics.consoleErrorDetails.slice(0, 2),
    },
    behavior: test.configured ? test.status : 'unverified; no workspace test script supplied',
    test: test.status,
    electronDiagnosticLeads,
    screenshots: [desktopPath, compactPath],
    report: reportPath,
  };
  const firstRendererError = diagnostics.pageErrorDetails[0];
  if (firstRendererError) {
    console.log('RENDERER_ERROR: ' + JSON.stringify({
      message: firstRendererError.message,
      sourceFrames: firstRendererError.stack.split(/\r?\n/).slice(0, 5),
    }));
  }
  console.log('PREVIEW_RESULT: ' + JSON.stringify(summary));
  if (page.isClosed() || runtimeIssues) process.exitCode = 1;
} catch (error) {
  fail(error?.message || error);
  flushMainOutput();
  const reportPath = runDirectory ? path.join(runDirectory, 'report.json') : '';
  const workspaceTestFailed = phase === 'running workspace test';
  const errorSummary = String(error?.message || error).slice(0, 300);
  const testEvidence = {};
  if (workspaceTestFailed && activePage && !activePage.isClosed()) {
    try {
      testEvidence.controlTimeline = await activePage.evaluate(() => {
        const timeline = window.__odysseusControlTimeline;
        return timeline ? timeline.drain() : [];
      });
    } catch (captureError) {
      testEvidence.controlTimelineError = String(captureError?.message || captureError).slice(0, 200);
    }
    try {
      const bodyText = String(await activePage.locator('body').innerText({ timeout: 3000 }));
      const marker = '\n...[visible text truncated]...\n';
      const contentBudget = 5000 - marker.length;
      const headLength = Math.floor(contentBudget / 2);
      testEvidence.visibleText = bodyText.length <= 5000 ? bodyText
        : bodyText.slice(0, headLength) + marker + bodyText.slice(-(contentBudget - headLength));
    } catch (captureError) {
      testEvidence.captureError = String(captureError?.message || captureError).slice(0, 300);
    }
    try {
      testEvidence.screenshot = path.join(runDirectory, 'test-failure.png');
      await activePage.screenshot({
        path: testEvidence.screenshot, fullPage: false, animations: 'disabled', timeout: 5000,
      });
    } catch (captureError) {
      delete testEvidence.screenshot;
      testEvidence.screenshotError = String(captureError?.message || captureError).slice(0, 300);
    }
  }
  const failureReport = {
    status: 'failed',
    behavior: workspaceTestFailed
      ? 'workspace test failed; app behavior remains unverified'
      : 'unverified; preview failed before workspace tests',
    runId, workspace, appEntry, electron: electronPath, phase,
    testEvidence,
    error: String(error?.stack || error).slice(0, 8000), diagnostics,
  };
  if (reportPath) {
    try { fs.writeFileSync(reportPath, JSON.stringify(failureReport, null, 2), { mode: 0o600 }); } catch {}
  }
  console.log('PREVIEW_RESULT: ' + JSON.stringify({
    status: 'failed', phase, appEntry,
    behavior: failureReport.behavior,
    test: workspaceTestFailed ? 'failed' : 'not run',
    report: reportPath || null,
    error: errorSummary,
    ...(testEvidence.controlTimeline?.length ? {
      controlTimeline: testEvidence.controlTimeline.slice(-8).map(event => ({
        ...event, target: { ...event.target, id: event.target.id.slice(0, 24) },
        ...(typeof event.from === 'string' ? { from: event.from.slice(0, 24) } : {}),
        ...(typeof event.to === 'string' ? { to: event.to.slice(0, 24) } : {}),
      })),
    } : {}),
    sourceFrames: String(error?.stack || '').split(/\r?\n/).slice(0, 5)
      .map(frame => frame.slice(0, 300)),
    errors: {
      page: diagnostics.pageErrors.length, console: diagnostics.consoleErrors.length,
      mainStdout: diagnostics.mainStdout.length,
      stderr: diagnostics.mainStderr.length,
      examples: [...diagnostics.pageErrors, ...diagnostics.consoleErrors,
        ...summarizeMainStderr(diagnostics.mainStderr),
        ...diagnostics.mainStdout.slice(-3)].slice(0, 3).map(value => String(value).slice(0, 180)),
      mainStderrExamples: summarizeMainStderr(diagnostics.mainStderr),
      mainStdoutExamples: diagnostics.mainStdout.slice(-3),
    },
    ...(Object.keys(testEvidence).length ? { testEvidence } : {}),
  }));
} finally {
  if (browser) { try { await browser.close(); } catch { /* close CDP connection */ } }
  if (electronProcess && electronProcess.exitCode === null) {
    electronProcess.kill('SIGTERM');
    await Promise.race([new Promise(resolve => electronProcess.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 1500))]);
    if (electronProcess.exitCode === null) {
      electronProcess.kill('SIGKILL');
      await Promise.race([new Promise(resolve => electronProcess.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 1000))]);
    }
  }
  if (profile) safeRm(profile, os.tmpdir());
}
`;

async function waitForExit(child) {
  return await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code: code ?? (signal ? 128 : 1), signal }));
  });
}

function procInfo(pid) {
  try {
    const stat = fs.readFileSync(path.join('/proc', String(pid), 'stat'), 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return { pid: Number(pid), ppid: Number(fields[1]), startTime: fields[19] };
  } catch { return null; }
}

function ownedDescendants(rootPid, expectedStartTime) {
  const root = procInfo(rootPid);
  if (!root || !expectedStartTime || root.startTime !== expectedStartTime) return [];
  const parents = new Map();
  for (const entry of fs.readdirSync('/proc', { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    try {
      const stat = fs.readFileSync(path.join('/proc', entry.name, 'stat'), 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const pid = Number(entry.name), ppid = Number(fields[1]), startTime = fields[19];
      if (!parents.has(ppid)) parents.set(ppid, []);
      parents.get(ppid).push({ pid, startTime });
    } catch { /* process exited while enumerating */ }
  }
  const found = [];
  const visit = processInfo => {
    for (const child of parents.get(processInfo.pid) || []) visit(child);
    found.push(processInfo);
  };
  visit(root);
  return found;
}

async function killOwnedTree(pid, expectedStartTime, graceMs = 1200) {
  if (!pid || process.platform !== 'linux') return;
  const owned = new Map();
  const remember = entry => owned.set(entry.pid + ':' + entry.startTime, entry);
  for (const entry of ownedDescendants(pid, expectedStartTime)) remember(entry);
  const signalSet = signal => {
    for (const entry of owned.values()) {
      if (procInfo(entry.pid)?.startTime !== entry.startTime) continue;
      try { process.kill(entry.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  };
  signalSet('SIGTERM');
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    for (const child of ownedDescendants(pid, expectedStartTime)) remember(child);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  // Keep the initial PID set: descendants may be reparented if the helper exits
  // during timeout cleanup, but are still exactly those spawned by this run.
  signalSet('SIGKILL');
}

export async function runOwnedCommand(command, args, { timeoutMs, env, stdio = 'inherit' } = {}) {
  // Stay in the invoking Bash process group: its hard cancellation then kills
  // this helper and every non-detached workspace/Xvfb/Electron descendant.
  const child = spawn(command, args, { stdio, env });
  const expectedStartTime = child.pid ? procInfo(child.pid)?.startTime : undefined;
  let timedOut = false;
  let interrupted = false;
  let timer;
  const onSignal = () => { interrupted = true; void killOwnedTree(child.pid, expectedStartTime); };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  const timeout = new Promise(resolve => {
    timer = setTimeout(async () => {
      timedOut = true;
      await killOwnedTree(child.pid, expectedStartTime);
      resolve({ code: 124, signal: 'SIGKILL' });
    }, timeoutMs);
    timer.unref?.();
  });
  try {
    const result = await Promise.race([waitForExit(child), timeout]);
    clearTimeout(timer);
    if (timedOut || interrupted) await killOwnedTree(child.pid, expectedStartTime, 0);
    return { ...result, code: timedOut ? 124 : result.code, timedOut, interrupted };
  } finally {
    clearTimeout(timer);
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }
}

function usage() {
  console.log(`Usage: node /app/scripts/electron_preview.mjs [--workspace DIR] [--workspace-bound] [--test-script RELATIVE.mjs] [--timeout 15..45] [--no-sandbox]\n\nLaunches the workspace-local Electron app under Xvfb, captures rendered DOM/styles/screenshots at 1280x800 and 800x600, and optionally runs a workspace test module. --workspace-bound requires --workspace to resolve inside the current directory. Outputs are kept in .odysseus-preview/. --no-sandbox affects only this isolated test run.`);
}

async function main() {
  let options;
  try { options = parseArgs(process.argv.slice(2)); }
  catch (error) { console.error(`PREVIEW_ERROR: ${error.message}`); process.exitCode = 2; return; }
  if (options.help) { usage(); return; }
  if (process.platform !== 'linux') {
    console.error('PREVIEW_ERROR: this isolated Electron workflow currently requires Linux and xvfb-run');
    process.exitCode = 2; return;
  }
  let project;
  if (options.workspaceBound) {
    try {
      const activeWorkspace = fs.realpathSync(process.cwd());
      const requestedWorkspace = fs.realpathSync(options.workspace);
      if (!inside(activeWorkspace, requestedWorkspace)) {
        console.error('PREVIEW_ERROR: project_path must resolve inside the active workspace');
        process.exitCode = 2; return;
      }
    } catch (error) {
      console.error(`PREVIEW_ERROR: project_path is not an existing workspace directory: ${error.message}`);
      process.exitCode = 2; return;
    }
  }
  try { project = resolveWorkspaceProject(options.workspace, options.testScript); }
  catch (error) { console.error(`PREVIEW_ERROR: ${error.message}`); process.exitCode = 2; return; }
  const stat = fs.statSync(project.workspace);
  if (stat.uid === 0) {
    console.error('PREVIEW_ERROR: refusing to launch project code from a root-owned workspace');
    process.exitCode = 2; return;
  }
  const xvfb = findOnPath('xvfb-run');
  if (!xvfb) { console.error('PREVIEW_ERROR: xvfb-run is not installed'); process.exitCode = 2; return; }
  const node = process.execPath;
  const setpriv = findOnPath('setpriv');
  let command = node;
  let args = [process.argv[1], '--worker'];
  if (process.getuid?.() === 0) {
    if (!setpriv) { console.error('PREVIEW_ERROR: setpriv is required to drop root privileges'); process.exitCode = 2; return; }
    command = setpriv;
    args = [`--reuid=${stat.uid}`, `--regid=${stat.gid}`, '--init-groups', '--', node, process.argv[1], '--worker'];
  } else if (process.getuid?.() !== stat.uid) {
    console.error('PREVIEW_ERROR: run this helper as the workspace owner or as root with setpriv installed');
    process.exitCode = 2; return;
  }
  let playwrightPath;
  try { playwrightPath = resolvePlaywright(project.workspace); }
  catch (error) { console.error(`PREVIEW_ERROR: ${error.message}`); process.exitCode = 2; return; }
  const outputDir = path.join(project.workspace, OUTPUT_DIR_NAME);
  const config = {
    ...project, playwrightPath, outputDir,
    xvfbPath: xvfb,
    noSandbox: options.noSandbox, timeout: options.timeout,
  };
  const env = {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    HOME: project.workspace,
    LANG: 'C.UTF-8',
    ODYSSEUS_PREVIEW_CONFIG: JSON.stringify(config),
  };
  const worker = await runOwnedCommand(command, args, { timeoutMs: options.timeout * 1000, env });
  if (worker.timedOut) {
    console.error(`PREVIEW_TIMEOUT: stopped the owned Electron/Xvfb process group after ${options.timeout}s`);
    process.exitCode = 124;
  } else if (worker.interrupted) {
    console.error('PREVIEW_CANCELLED: stopped the owned Electron/Xvfb process group');
    process.exitCode = 130;
  } else {
    process.exitCode = worker.code;
  }
}

if (process.argv[2] === '--worker') {
  const config = JSON.parse(process.env.ODYSSEUS_PREVIEW_CONFIG || '{}');
  try {
    fs.mkdirSync(config.outputDir, { mode: 0o700 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const st = fs.lstatSync(config.outputDir);
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid()) throw new Error('unsafe preview output directory');
  ensureOutputIgnore(fs, config.outputDir);
  const workspace = fs.realpathSync(config.workspace);
  const outputDir = fs.realpathSync(config.outputDir);
  const outputRel = path.relative(workspace, outputDir);
  if (outputRel === '..' || outputRel.startsWith('..' + path.sep) || path.isAbsolute(outputRel)) {
    throw new Error('preview output directory escapes the workspace');
  }
  const child = spawn(config.xvfbPath, ['-a', '--server-args=-screen 0 1280x800x24', process.execPath, '--input-type=module', '-e', ELECTRON_WORKER_SOURCE], {
    stdio: 'inherit', env: { ...process.env, ODYSSEUS_PREVIEW_CONFIG: JSON.stringify(config) },
  });
  const result = await waitForExit(child);
  process.exitCode = result.code;
} else if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
