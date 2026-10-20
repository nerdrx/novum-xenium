const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

const staticRoot = path.resolve(__dirname, '../../static');
const html = `<!doctype html><meta charset="utf-8">
<div class="list-item active-session" data-session-id="chat-A"></div>
<textarea id="message"></textarea><div id="attach-strip"></div><input id="file-input" type="file" multiple>
<input id="incognito-toggle" type="checkbox"><input id="web-toggle" type="checkbox"><input id="research-toggle" type="checkbox"><input id="bash-toggle" type="checkbox"><button id="research-toggle-btn"></button>
<div id="chat-history"></div><button class="send-btn"></button><div id="toast"></div>
<script type="module">
  import chat from '/js/chat.js';
  import sessions from '/js/sessions.js';
  import spinner from '/js/spinner.js';
  window.modulesReady = Promise.all([chat, sessions]).then(() => { window.modules = { chat, sessions, spinner }; });
</script>`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://fixture');
  if (url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(html);
  }
  const file = path.resolve(staticRoot, `.${decodeURIComponent(url.pathname)}`);
  if (!file.startsWith(`${staticRoot}${path.sep}`) || !fs.existsSync(file)) {
    res.writeHead(404);
    return res.end('Not found');
  }
  res.writeHead(200, {
    'Content-Type': file.endsWith('.js') || file.endsWith('.mjs') ? 'text/javascript' : 'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  fs.createReadStream(file).pipe(res);
});

const sse = (events) => events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n';
const toolStart = (tool) => ({ type: 'tool_start', tool, command: `synthetic ${tool}` });
const toolOutput = (tool) => ({ type: 'tool_output', tool, exit_code: 0, output: 'synthetic receipt' });

(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.BROWSER_EXECUTABLE || '/opt/google/chrome/chrome',
    args: ['--no-sandbox', '--disable-gpu'],
  });
  const results = {};
  const origin = `http://127.0.0.1:${server.address().port}`;
  let externalRequests = 0;
  try {
    async function runCase(name, events, addUnrelatedNode = false) {
      const page = await browser.newPage();
      const pageErrors = [];
      page.on('pageerror', (error) => pageErrors.push(error.stack || error.message));
      await page.route('**/*', async (route) => {
        let requestOrigin = '';
        try { requestOrigin = new URL(route.request().url()).origin; } catch {}
        if (requestOrigin === origin) return route.continue();
        externalRequests++;
        return route.abort('blockedbyclient');
      });
      await page.goto(`${origin}/`);
      await page.waitForFunction(() => window.modules, null, { timeout: 10000 });
      await page.evaluate(({ caseEvents, addUnrelatedNode, caseName }) => {
        const { chat, sessions, spinner } = window.modules;
        sessions.setCurrentSessionId('chat-A');
        window.__odysseusDefaultChat = { endpoint_url: 'http://fixture', model: 'fixture-model', endpoint_id: 'fixture-endpoint' };
        window.spinnerInstances = [];
        const create = spinner.create.bind(spinner);
        spinner.create = (...args) => {
          const instance = create(...args);
          window.spinnerInstances.push(instance);
          return instance;
        };
        const originalFetch = window.fetch.bind(window);
        window.fetch = async (input, init = {}) => {
          const url = String(input);
          if (url.includes('/api/auth/status')) return new Response(JSON.stringify({ configured: false, authenticated: false, username: null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
          if (url.includes('/api/default-chat')) return new Response(JSON.stringify(window.__odysseusDefaultChat), { status: 200, headers: { 'Content-Type': 'application/json' } });
          if (url.includes('/api/chat_stream')) return new Response(window.fixtureSse, { status: 200, headers: { 'Content-Type': 'text/event-stream', 'X-Odysseus-Run-Id': 'synthetic-run' } });
          if (url.includes('/api/session/') && url.includes('/truncate')) return new Response('{}', { status: 200 });
          if (url.startsWith('/api/')) return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
          return originalFetch(input, init);
        };
        window.fixtureSse = caseEvents;
        if (addUnrelatedNode) {
          const node = document.createElement('div');
          node.className = 'agent-thread-node running';
          node.dataset.toolName = 'synthetic-B';
          node.innerHTML = '<div class="agent-thread-header"><span class="agent-thread-wave">▁▂▃</span></div>';
          node._waveInterval = setInterval(() => {}, 1000);
          node._elapsedTicker = setInterval(() => {}, 1000);
          document.getElementById('chat-history').appendChild(node);
          window.unrelatedNode = node;
        }
        document.getElementById('message').value = caseName;
        window.sendSettled = false;
        window.sendPromise = chat.handleChatSubmit({ preventDefault() {} }).finally(() => { window.sendSettled = true; });
      }, { caseEvents: sse(events), addUnrelatedNode, caseName: `synthetic ${name}` });
      await page.waitForFunction(() => window.sendSettled, null, { timeout: 15000 });
      await page.waitForTimeout(30);
      const result = await page.evaluate(() => ({
        spinners: window.spinnerInstances.map((spinner) => ({ running: spinner.isRunning, interval: spinner.intervalId !== null, connected: !!spinner.element?.isConnected })),
        nodes: [...document.querySelectorAll('#chat-history .agent-thread-node')].map((node) => ({
          name: node.dataset.toolName,
          running: node.classList.contains('running'),
          pending: node.classList.contains('pending'),
          done: node.classList.contains('done'),
          wave: node._waveInterval != null,
          elapsed: node._elapsedTicker != null,
          status: node.querySelector('.agent-thread-status')?.textContent || '',
        })),
        unrelatedTimers: window.unrelatedNode ? {
          wave: window.unrelatedNode._waveInterval != null,
          elapsed: window.unrelatedNode._elapsedTicker != null,
        } : null,
        approvalCards: [...document.querySelectorAll('#chat-history .ask-user-card')].map((card) => ({
          kind: card.dataset.askUserKind,
          text: card.innerText,
        })),
        busy: window.__odysseusChatBusy,
      }));
      assert.deepEqual(pageErrors, [], `${name} page errors`);
      results[name] = result;
      if (addUnrelatedNode) {
        await page.evaluate(() => {
          clearInterval(window.unrelatedNode._waveInterval);
          clearInterval(window.unrelatedNode._elapsedTicker);
        });
      }
      await page.close();
    }

    await runCase('singleEof', [toolStart('tool-one')]);
    await runCase('twoStartsEof', [toolStart('tool-one'), toolStart('tool-two')]);
    await runCase('normalReceipt', [toolStart('tool-one'), toolOutput('tool-one')]);
    await runCase('ownedAWhileBRunning', [toolStart('tool-A')], true);
    const approval = {
      kind: 'tool_approval',
      approval_id: 'synthetic-approval-1',
      question: 'Allow the synthetic tool action?',
      options: [{ label: 'Approve', value: 'approve' }, { label: 'Deny', value: 'deny' }],
      action: { tool: 'bash', content: 'synthetic harmless action' },
    };
    await runCase('pendingApproval', [
      { type: 'tool_output', tool: 'bash', approval_required: true, ask_user: approval },
      { type: 'ask_user', data: approval },
    ]);
    for (const name of ['singleEof', 'twoStartsEof', 'ownedAWhileBRunning']) {
      const nodes = results[name].nodes.filter((node) => node.name !== 'synthetic-B');
      assert.ok(nodes.length >= 1, `${name} should render owned tool nodes`);
      for (const node of nodes) {
        assert.equal(node.running, false, `${name}: unfinished node is terminal`);
        assert.equal(node.wave, false, `${name}: wave interval cleared`);
        assert.equal(node.elapsed, false, `${name}: elapsed interval cleared`);
        assert.equal(node.status, 'No result received', `${name}: missing receipt is reported honestly`);
      }
    }
    assert.deepEqual(results.normalReceipt.nodes.map((node) => ({ running: node.running, wave: node.wave, elapsed: node.elapsed, status: node.status })), [
      { running: false, wave: false, elapsed: false, status: 'done' },
    ], 'tool_output receipt remains completed');
    assert.deepEqual(results.ownedAWhileBRunning.unrelatedTimers, { wave: true, elapsed: true }, 'cleanup leaves another stream node timers alone');
    assert.equal(results.pendingApproval.nodes.length, 1);
    assert.deepEqual(
      { pending: results.pendingApproval.nodes[0].pending, status: results.pendingApproval.nodes[0].status },
      { pending: true, status: 'awaiting approval' },
      'pending tool approval status remains intact',
    );
    assert.deepEqual(results.pendingApproval.approvalCards.map((card) => card.kind), ['tool_approval']);
    assert.match(results.pendingApproval.approvalCards[0].text, /Allow the synthetic tool action/);
    assert.equal(externalRequests, 0, 'all browser requests stayed on the loopback fixture origin');
    console.log(JSON.stringify({ pass: true, loopbackOnly: true, actualChatModule: true, externalRequests, results }, null, 2));
  } finally {
    await browser.close();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((error) => {
  console.error(error);
  server.closeAllConnections?.();
  server.close();
  process.exitCode = 1;
});
