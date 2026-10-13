import assert from 'node:assert/strict';
import { mkdtemp, mkdir, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Read-only app acceptance: all generated media and outputs live in a temp folder.
export default async function ({ page }) {
  const errors = [];
  page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  const root = fileURLToPath(new URL('.', import.meta.url));
  const input = join(root, '../test_input.mp4');
  const work = await mkdtemp(join(tmpdir(), 'nx-full-flow-'));
  const phases = [];
  let halted = false;
  let cleanupSafe = true;
  const phase = async (name, fn) => {
    const assertions = [];
    if (halted) { phases.push({ phase: name, passed: false, assertions: [{ assertion: 'skipped because process cleanup could not be confirmed', passed: false }] }); return; }
    try {
      await fn((condition, message) => {
        assertions.push({ assertion: message, passed: Boolean(condition) });
      });
    } catch (e) { assertions.push({ assertion: e.message, passed: false }); halted = !cleanupSafe; }
    phases.push({ phase: name, passed: assertions.length > 0 && assertions.every(a => a.passed), assertions });
  };
  const setFile = async file => {
    const cdp = await page.context().newCDPSession(page);
    try {
      const { root: doc } = await cdp.send('DOM.getDocument');
      const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: doc.nodeId, selector: '#inputFile' });
      assert.ok(nodeId, 'GUI file picker exists');
      await cdp.send('DOM.setFileInputFiles', { nodeId, files: [file] });
    } finally { await cdp.detach(); }
    await page.waitForFunction(expected => document.querySelector('#inputPath').value === expected, file, { timeout: 5000 });
  };
  const guiConvert = async ({ file = input, name, args = '-c copy' }) => {
    const dir = join(work, name);
    await mkdir(dir, { recursive: true });
    await setFile(file);
    await page.locator('#outputPath').fill(dir);
    await page.locator('#outputName').fill(name + '.mp4');
    await page.locator('#argsInput').fill(args);
    await page.locator('#startBtn').click({ timeout: 5000 });
    return { dir, output: join(dir, name + '.mp4') };
  };
  try {
    await phase('success: GUI conversion produces playable output', async check => {
      const { output } = await guiConvert({ name: 'success' });
      await page.waitForFunction(() => /Conversion completed/i.test(document.querySelector('#logConsole').textContent), null, { timeout: 15000 });
      const info = await stat(output);
      const probe = JSON.parse(execFileSync('ffprobe', ['-v','error','-show_streams','-show_format','-of','json',output], { encoding: 'utf8', timeout: 5000 }));
      check(info.size > 0, 'output file is non-empty');
      check(probe.streams.some(s => s.codec_type === 'video'), 'output contains a video stream');
      check(Number(probe.format.duration) >= 4, 'output preserves the test clip duration');
      check(await page.locator('#startBtn').isEnabled(), 'Start recovers after completion');
    });

    await phase('success contract: invoke promise settles', async check => {
      const dir = join(work, 'settlement'); await mkdir(dir, { recursive: true });
      const result = await page.evaluate(async options => {
        let timer;
        try { return await Promise.race([
          window.electron.spawnFFmpeg(options).then(value => ({ settled: true, value }), error => ({ settled: true, error: String(error) })),
          new Promise(resolve => { timer = setTimeout(() => resolve({ settled: false }), 6000); })
        ]); } finally { clearTimeout(timer); }
      }, { input, output: dir, outputName: 'settlement.mp4', args: '-c copy' });
      check(result.settled, 'spawnFFmpeg promise settles after FFmpeg exits');
      check(result.value?.success === true, `settled result reports success (${JSON.stringify(result)})`);
      check((await stat(join(dir, 'settlement.mp4'))).size > 0, 'invoke output exists');
    });

    await phase('failure: invalid FFmpeg arguments and UI recovery', async check => {
      const { dir } = await guiConvert({ name: 'invalid-args', args: '-nx-invalid-option' });
      await page.waitForFunction(() => /conversion-error|Error:/i.test(document.querySelector('#logConsole').textContent), null, { timeout: 10000 });
      check(/conversion-error|Error:/i.test(await page.locator('#logConsole').innerText()), 'GUI reports FFmpeg failure');
      check(await page.locator('#startBtn').isEnabled(), 'Start remains available after FFmpeg failure');
      check(await page.locator('#argsInput').isEnabled(), 'arguments remain editable after FFmpeg failure');
      check(!(await stat(join(dir, 'invalid-args.mp4')).then(s => s.size > 0).catch(() => false)), 'invalid arguments produce no completed output');
    });

    await phase('failure contract: invoke settles with failure', async check => {
      const dir = join(work, 'failure-contract'); await mkdir(dir, { recursive: true });
      const result = await Promise.race([
        page.evaluate(options => window.electron.spawnFFmpeg(options).then(value => ({ settled: true, value }), error => ({ settled: true, error: String(error) })),
          { input, output: dir, outputName: 'failure.mp4', args: '-nx-invalid-option' }),
        new Promise(resolve => setTimeout(() => resolve({ settled: false }), 6000))
      ]);
      check(result.settled, 'spawnFFmpeg promise settles after FFmpeg rejects invalid args');
      check(result.value?.success === false || Boolean(result.error), `settled result reports failure (${JSON.stringify(result)})`);
    });

    await phase('cancellation: GUI control and state recovery', async check => {
      await page.evaluate(() => { window.__qaCancelled = false; window.electron.onCancel(() => { window.__qaCancelled = true; }); });
      cleanupSafe = false;
      await guiConvert({ name: 'cancel-gui', args: '-vf realtime -c:v libx264 -preset ultrafast' });
      await page.waitForTimeout(300);
      const enabled = await page.locator('#cancelBtn').isEnabled();
      check(enabled, 'GUI Cancel enables during an active conversion');
      check(!(await page.locator('#startBtn').isEnabled()), 'Start disables during active conversion');
      if (enabled) await page.locator('#cancelBtn').click({timeout:2000});
      else await page.evaluate(() => { window.electron.cancelConversion(); });
      await page.waitForFunction(() => window.__qaCancelled, null, {timeout:3000});
      await page.waitForTimeout(200);
      cleanupSafe = true;
      check(await page.locator('#startBtn').isEnabled(), 'Start recovers after cancel');
      check(await page.locator('#outputPath').isEnabled(), 'Output field recovers after cancel');
    });
    await phase('cancellation contract: both requests settle', async check => {
      const dir = join(work,'cancel-contract'); await mkdir(dir,{recursive:true});
      await page.evaluate(options => {
        window.__qaInvoke = window.electron.spawnFFmpeg(options).then(value => ({settled:true,value}), error => ({settled:true,error:String(error)}));
      }, {input,output:dir,outputName:'cancel.mp4',args:'-vf realtime -c:v libx264 -preset ultrafast'});
      cleanupSafe = false;
      await page.waitForTimeout(300);
      const result = await page.evaluate(async () => {
        let timer;
        try { return await Promise.race([
          Promise.all([window.__qaInvoke, window.electron.cancelConversion()]).then(values => ({settled:true,values})),
          new Promise(resolve => { timer=setTimeout(() => resolve({settled:false}),6000); })
        ]); } finally {clearTimeout(timer);}
      });
      check(result.settled, 'Conversion and cancel promises both settle after cancellation');
      // The paced clip is only five seconds; all natural/cancel exits are past by this point.
      await page.waitForTimeout(5000);
      cleanupSafe = true;
    });

    await phase('repeat: GUI conversion succeeds after failure and cancellation', async check => {
      const priorCompletions = (await page.locator('#logConsole').innerText()).match(/Conversion completed/gi)?.length || 0;
      const { output } = await guiConvert({ name: 'repeat' });
      await page.waitForFunction(count => (document.querySelector('#logConsole').textContent.match(/Conversion completed/gi)?.length || 0) > count, priorCompletions, { timeout: 15000 });
      check((await stat(output)).size > 0, 'repeat output is non-empty');
      check(await page.locator('#startBtn').isEnabled(), 'Start remains available after repeat conversion');
    });
    phases.push({ phase: 'runtime errors', passed: errors.length === 0, assertions: [{ assertion: 'no page or console errors: ' + (errors.join(' | ') || 'none'), passed: errors.length === 0 }] });
    const report = { phases, passed: phases.every(p => p.passed), limitations: ['Cancellation falls back to the exposed API only when the disabled GUI Cancel control is unavailable; this fallback is reported as a failed UI assertion.', 'Invoke settlement checks observe the actual preload API; no behavior is mocked or replaced.'] };
    console.log('NX_FULL_FLOW ' + JSON.stringify(report));
    assert.ok(report.passed, phases.filter(p => !p.passed).map(p => p.phase + ': ' + p.assertions.filter(a => !a.passed).map(a => a.assertion).join('; ')).join(' | '));
    return report;
  } finally { console.log('NX_FULL_FLOW_ARTIFACTS ' + work); }
}
