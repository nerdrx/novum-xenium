const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

const repo = path.resolve(__dirname, '../..');
const staticRoot = path.join(repo, 'static');
const html = `<!doctype html><meta charset="utf-8">
<textarea id="message"></textarea><div id="attach-strip"></div><input id="file-input" type="file" multiple>
<input id="incognito-toggle" type="checkbox"><input id="web-toggle" type="checkbox"><input id="research-toggle" type="checkbox"><input id="bash-toggle" type="checkbox"><button id="research-toggle-btn"></button>
<div id="chat-history"></div><div id="toast"></div><button class="send-btn"></button>
<script type="module">
  import chat from '/js/chat.js';
  import sessions from '/js/sessions.js';
  import markdown from '/js/markdown.js';
  import files from '/js/fileHandler.js';
  window.modulesReady = Promise.all([chat, sessions, files]).then(() => {
    window.testModules = { chat, sessions, markdown, files };
  });
</script>`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://fixture');
  if (url.pathname === '/fixture') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.end(html);
  }
  if (url.pathname.startsWith('/api/')) {
    res.writeHead(404, { 'content-type': 'application/json' }).end('{}');
    return;
  }
  const file = path.resolve(staticRoot, `.${decodeURIComponent(url.pathname)}`);
  if (!file.startsWith(`${staticRoot}${path.sep}`) || !fs.existsSync(file)) {
    res.statusCode = 404;
    return res.end('Not found');
  }
  res.setHeader('Content-Type', /\.(?:m?js)$/.test(file) ? 'text/javascript; charset=utf-8' : 'application/octet-stream');
  res.end(fs.readFileSync(file));
});

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.BROWSER_EXECUTABLE || '/opt/google/chrome/chrome',
    args: ['--no-sandbox', '--disable-gpu'],
  });
  try {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.stack || error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/fixture`);
    try {
      await page.waitForFunction(() => window.testModules, null, { timeout: 20000 });
    } catch (error) {
      throw new Error(`${error.message}; page errors: ${pageErrors.join(' | ')}`);
    }

    await page.evaluate(() => {
      const { chat, sessions } = window.testModules;
      const nativeFetch = window.fetch.bind(window);
      window.resumeFixtures = new Map();
      window.resumeResults = new Map();
      window.fetch = (input, init) => {
        if (!String(input).includes('/api/chat/resume/')) return nativeFetch(input, init);
        let controller;
        const body = new ReadableStream({ start(streamController) { controller = streamController; } });
        const sessionId = String(input).split('/').pop();
        window.resumeFixtures.set(sessionId, { controller, settled: false });
        return Promise.resolve(new Response(body, {
          status: 200,
          headers: { 'X-Odysseus-Run-Id': 'resume-format-run' },
        }));
      };
      window.startResumeFixture = sessionId => {
        sessions.setCurrentSessionId(sessionId);
        const result = chat.resumeStream(sessionId).then(value => {
          const fixture = window.resumeFixtures.get(sessionId);
          if (fixture) fixture.settled = true;
          return value;
        });
        window.resumeResults.set(sessionId, result);
      };
    });
    const markdownDelta = [
      '# Resumed heading',
      '',
      'A **bold** phrase.',
      '',
      '- first item',
      '- second item',
      '',
      '| Name | Value |',
      '| --- | --- |',
      '| cat | nine |',
      '',
      '```js',
      'const resumed = true;',
      '```',
      '',
      '<think>Reasoning is shown as a collapsible section while this stream is open.</think>',
      '',
      'Visible answer',
    ].join('\n');
    await page.evaluate(delta => {
      window.startResumeFixture('resume-format-fixture');
      const controller = window.resumeFixtures.get('resume-format-fixture').controller;
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ delta })}\n\n`));
    }, markdownDelta);

    await page.waitForFunction(() => {
      const content = document.querySelector('#chat-history .stream-content');
      return content?.querySelector('h1') && content?.querySelector('table') &&
        content?.querySelector('pre code') && content?.textContent.includes('Visible answer');
    }, null, { timeout: 10000 });

    const liveState = await page.evaluate(() => {
      const content = document.querySelector('#chat-history .stream-content');
      return {
        settled: window.resumeFixtures.get('resume-format-fixture').settled,
        heading: content.querySelector('h1')?.textContent,
        strong: content.querySelector('strong')?.textContent,
        listItems: [...content.querySelectorAll('ul li')].map(item => item.textContent),
        tableCell: content.querySelector('table tbody td')?.textContent,
        code: content.querySelector('pre code')?.textContent,
        thinking: content.querySelector('.thinking-content-inner')?.textContent.trim(),
        rawThinkTextVisible: content.textContent.includes('<think>'),
      };
    });
    assert.equal(liveState.settled, false, 'SSE reader should still be open after chunks');
    assert.equal(liveState.heading, 'Resumed heading');
    assert.equal(liveState.strong, 'bold');
    assert.deepEqual(liveState.listItems, ['first item', 'second item']);
    assert.equal(liveState.tableCell, 'cat');
    assert.match(liveState.code, /const resumed = true;/);
    assert.match(liveState.thinking, /Reasoning is shown/);
    assert.equal(liveState.rawThinkTextVisible, false);

    await page.evaluate(() => {
      const controller = window.resumeFixtures.get('resume-format-fixture').controller;
      const delta = '\n\n```text\nprint("still live")';
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ delta })}\n\n`));
    });
    await page.waitForFunction(() => [...document.querySelectorAll('#chat-history .stream-content pre code')]
      .some(content => content.textContent.includes('print("still live")')), null, { timeout: 10000 });
    assert.equal(await page.evaluate(() => window.resumeFixtures.get('resume-format-fixture').settled), false);

    await page.evaluate(() => {
      const controller = window.resumeFixtures.get('resume-format-fixture').controller;
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: 'agent_step', round: 2 })}\n\n`));
      const delta = 'Native reasoning stays separate from the reply until this round ends.';
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ delta, thinking: true })}\n\n`));
    });
    await page.waitForFunction(() => {
      const rounds = document.querySelectorAll('#chat-history .stream-content');
      const next = rounds[rounds.length - 1];
      return rounds.length >= 2 && next?.querySelector('.thinking-section') &&
        next.textContent.includes('Thinking');
    }, null, { timeout: 10000 });
    const pendingNative = await page.locator('#chat-history .stream-content').last().evaluate(node => ({
      text: node.querySelector('.resume-thinking-content')?.textContent || '',
      reply: node.querySelector('.live-reply-content')?.textContent || '',
      expanded: node.querySelector('.thinking-content')?.classList.contains('expanded'),
      headerExpanded: node.querySelector('.thinking-header')?.getAttribute('aria-expanded'),
    }));
    assert.match(pendingNative.text, /Native reasoning stays separate/);
    assert.doesNotMatch(pendingNative.reply, /Native reasoning stays separate/);
    assert.equal(pendingNative.expanded, true, 'reopened active reasoning is visible like the primary stream');
    assert.equal(pendingNative.headerExpanded, 'true');

    // A round boundary must close one native reasoning stream and reset its
    // state before the next round starts a fresh native reasoning stream.
    await page.evaluate(() => {
      const controller = window.resumeFixtures.get('resume-format-fixture').controller;
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: 'agent_step', round: 3 })}\n\n`));
      const delta = 'Second-round private reasoning.';
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ delta, thinking: true })}\n\n`));
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ delta: 'Second-round visible answer.' })}\n\n`));
    });
    await page.waitForFunction(() => {
      const rounds = document.querySelectorAll('#chat-history .stream-content');
      const prior = rounds[rounds.length - 2];
      const current = rounds[rounds.length - 1];
      return rounds.length >= 3 && prior?.querySelector('.thinking-content-inner') &&
        current?.querySelector('.thinking-content-inner') && current.textContent.includes('Second-round visible answer.');
    }, null, { timeout: 10000 });
    const resumedRounds = await page.evaluate(() => [...document.querySelectorAll('#chat-history .stream-content')]
      .map(node => ({
        heading: node.querySelector('h1')?.textContent || '',
        text: node.textContent,
        thoughts: [...node.querySelectorAll('.thinking-content-inner')].map(inner => inner.textContent),
        reply: node.querySelector('.live-reply-content')?.textContent || '',
      })));
    assert.match(resumedRounds[0].text, /print\("still live"\)/);
    assert.match(resumedRounds[1].thoughts.join(' '), /Native reasoning stays separate/);
    assert.match(resumedRounds[2].thoughts.join(' '), /Second-round private reasoning/);
    assert.equal(resumedRounds[2].reply.trim(), 'Second-round visible answer.');

    await page.evaluate(async () => {
      const controller = window.resumeFixtures.get('resume-format-fixture').controller;
      controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
      controller.close();
      await window.resumeResults.get('resume-format-fixture');
    });

    await page.evaluate(() => {
      const sessionId = 'resume-pending-think-fixture';
      window.startResumeFixture(sessionId);
      const controller = window.resumeFixtures.get(sessionId).controller;
      const delta = '<think>Working through private reasoning that is not finished yet';
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ delta })}\n\n`));
    });
    await page.waitForFunction(() => {
      const content = [...document.querySelectorAll('#chat-history .stream-content')].at(-1);
      return content?.querySelector('.thinking-section') && content.textContent.includes('Thinking');
    });
    const pendingThought = await page.locator('#chat-history .stream-content').last().evaluate(node => ({
      thought: node.querySelector('.resume-thinking-content')?.textContent || '',
      reply: node.querySelector('.live-reply-content')?.textContent || '',
    }));
    assert.match(pendingThought.thought, /Working through private reasoning/);
    assert.doesNotMatch(pendingThought.reply, /Working through private reasoning/);
    assert.equal(await page.evaluate(() => window.resumeFixtures.get('resume-pending-think-fixture').settled), false);
    await page.evaluate(async () => {
      const fixture = window.resumeFixtures.get('resume-pending-think-fixture');
      fixture.controller.close();
      await window.resumeResults.get('resume-pending-think-fixture');
    });

    // Leaving and reopening an active session must rebuild the same live
    // reasoning panel from the replay buffer, not just the generic spinner.
    await page.evaluate(() => {
      const sessionId = 'resume-navigation-reopen-fixture';
      window.startResumeFixture(sessionId);
      const controller = window.resumeFixtures.get(sessionId).controller;
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ delta: 'Reasoning already streamed before navigation.', thinking: true })}\n\n`));
    });
    await page.waitForFunction(() => [...document.querySelectorAll('#chat-history .stream-content')].at(-1)
      ?.querySelector('.resume-thinking-content')?.textContent.includes('before navigation'));
    await page.evaluate(async () => {
      const sessionId = 'resume-navigation-reopen-fixture';
      window.testModules.sessions.setCurrentSessionId('other-session');
      window.testModules.chat.detachCurrentStream(sessionId);
      await window.resumeResults.get(sessionId);
      document.getElementById('chat-history').replaceChildren();
      window.testModules.sessions.setCurrentSessionId(sessionId);
      window.startResumeFixture(sessionId);
    });
    await page.waitForFunction(() => document.querySelector('#chat-history .stream-content'));
    await page.evaluate(() => {
      const controller = window.resumeFixtures.get('resume-navigation-reopen-fixture').controller;
      const media = document.createElement('video');
      media.dataset.fixture = 'preserve-identity';
      document.querySelector('#chat-history .stream-content').appendChild(media);
      window.resumeFixtureMedia = media;

      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ delta: 'Reasoning already streamed before navigation.', thinking: true })}\n\n`));
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ delta: ' Current reasoning after reopen.', thinking: true })}\n\n`));
    });
    await page.waitForFunction(() => [...document.querySelectorAll('#chat-history .stream-content')].at(-1)
      ?.querySelector('.resume-thinking-content')?.textContent.includes('after reopen'));
    const reopenedReasoning = await page.locator('#chat-history .stream-content').last().evaluate(node => ({
      thought: node.querySelector('.resume-thinking-content')?.textContent || '',
      reply: node.querySelector('.live-reply-content')?.textContent || '',
      expanded: node.querySelector('.thinking-content')?.classList.contains('expanded'),
    }));
    assert.match(reopenedReasoning.thought, /before navigation/);
    assert.match(reopenedReasoning.thought, /after reopen/);
    assert.doesNotMatch(reopenedReasoning.reply, /Reasoning already streamed/);
    assert.equal(reopenedReasoning.expanded, true);
    assert.equal(await page.evaluate(() => window.resumeFixtureMedia.isConnected), true,
      'live reasoning updates retain existing media nodes in the resumed round');
    const liveHeader = page.locator('#chat-history .stream-content').last().locator('.thinking-header');
    await liveHeader.focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => ![...document.querySelectorAll('#chat-history .stream-content')].at(-1)
      ?.querySelector('.thinking-content')?.classList.contains('expanded'));
    await page.evaluate(() => {
      const controller = window.resumeFixtures.get('resume-navigation-reopen-fixture').controller;
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ delta: ' One more hidden reasoning update.', thinking: true })}\n\n`));
    });
    await page.waitForFunction(() => [...document.querySelectorAll('#chat-history .stream-content')].at(-1)
      ?.querySelector('.resume-thinking-content')?.textContent.includes('One more hidden reasoning update'));
    assert.equal(await page.locator('#chat-history .stream-content').last().locator('.thinking-content').evaluate(el => el.classList.contains('expanded')), false,
      'a collapsed thinking panel stays collapsed as replay updates arrive');
    assert.equal(await page.evaluate(() => window.resumeFixtureMedia.isConnected), true);
    await liveHeader.click();
    await page.waitForFunction(() => [...document.querySelectorAll('#chat-history .stream-content')].at(-1)
      ?.querySelector('.thinking-content')?.classList.contains('expanded'));
    const manyReasoningLines = Array.from({ length: 30 }, (_, index) => `reasoning line ${index + 1}`).join('\n');
    await page.evaluate(lines => {
      const box = document.querySelector('#chat-history .stream-content:last-child .thinking-content');
      box.style.height = '60px';
      box.style.maxHeight = '60px';
      box.style.overflowY = 'auto';
      const controller = window.resumeFixtures.get('resume-navigation-reopen-fixture').controller;
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ delta: `\n${lines}`, thinking: true })}\n\n`));
    }, manyReasoningLines);
    await page.waitForFunction(() => [...document.querySelectorAll('#chat-history .stream-content')].at(-1)
      ?.querySelector('.resume-thinking-content')?.textContent.includes('reasoning line 30'));
    const autoFollow = await page.locator('#chat-history .stream-content').last().locator('.thinking-content').evaluate(box => ({
      whiteSpace: box.querySelector('.resume-thinking-content')?.style.whiteSpace,
      scrollTop: box.scrollTop,
      maxScroll: box.scrollHeight - box.clientHeight,
    }));
    assert.equal(autoFollow.whiteSpace, 'pre-wrap');
    assert.ok(autoFollow.maxScroll > 80, 'fixture reasoning is long enough to scroll');
    assert.ok(autoFollow.maxScroll - autoFollow.scrollTop < 2, 'near-bottom reader follows new reasoning');
    await page.evaluate(() => {
      const box = document.querySelector('#chat-history .stream-content:last-child .thinking-content');
      box.scrollTop = 0;
      const controller = window.resumeFixtures.get('resume-navigation-reopen-fixture').controller;
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ delta: '\nmanual scroll stays put', thinking: true })}\n\n`));
    });
    await page.waitForFunction(() => [...document.querySelectorAll('#chat-history .stream-content')].at(-1)
      ?.querySelector('.resume-thinking-content')?.textContent.includes('manual scroll stays put'));
    assert.equal(await page.locator('#chat-history .stream-content').last().locator('.thinking-content').evaluate(box => box.scrollTop), 0,
      'older-text reading position is preserved when the reader has scrolled up');
    await page.evaluate(() => {
      const controller = window.resumeFixtures.get('resume-navigation-reopen-fixture').controller;
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ delta: 'A separate user-facing answer.', thinking: false })}\n\n`));
    });
    await page.waitForFunction(() => [...document.querySelectorAll('#chat-history .stream-content')].at(-1)
      ?.querySelector('.live-reply-content')?.textContent.includes('user-facing answer'));
    const answerAfterThinking = await page.locator('#chat-history .stream-content').last().evaluate(node => ({
      thought: node.querySelector('.thinking-content-inner')?.textContent || '',
      reply: node.querySelector('.live-reply-content')?.textContent || '',
      thoughtSections: node.querySelectorAll('.thinking-section').length,
    }));
    assert.match(answerAfterThinking.thought, /One more hidden reasoning update/);
    assert.equal(answerAfterThinking.reply.trim(), 'A separate user-facing answer.');
    assert.equal(answerAfterThinking.thoughtSections, 1, 'closing reasoning updates the existing panel rather than duplicating it');
    await page.evaluate(async () => {
      const fixture = window.resumeFixtures.get('resume-navigation-reopen-fixture');
      fixture.controller.close();
      await window.resumeResults.get('resume-navigation-reopen-fixture');
    });

    await page.evaluate(() => {
      document.body.classList.add('hide-thinking');
      const sessionId = 'resume-hidden-thinking-pref';
      window.startResumeFixture(sessionId);
      const controller = window.resumeFixtures.get(sessionId).controller;
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ delta: '<think>Respect the saved hidden-thinking preference' })}\n\n`));
    });
    await page.waitForFunction(() => {
      const content = [...document.querySelectorAll('#chat-history .stream-content')].at(-1);
      return content?.querySelector('.resume-thinking-content')?.textContent.includes('Respect the saved');
    });
    const hiddenPreference = await page.locator('#chat-history .stream-content').last().evaluate(node => ({
      expanded: node.querySelector('.thinking-content')?.classList.contains('expanded'),
      hidden: document.body.classList.contains('hide-thinking'),
    }));
    assert.equal(hiddenPreference.expanded, false);
    assert.equal(hiddenPreference.hidden, true);
    await page.evaluate(async () => {
      const fixture = window.resumeFixtures.get('resume-hidden-thinking-pref');
      fixture.controller.close();
      await window.resumeResults.get('resume-hidden-thinking-pref');
      document.body.classList.remove('hide-thinking');
    });

    await page.evaluate(() => {
      const sessionId = 'resume-native-terminal-think-fixture';
      window.startResumeFixture(sessionId);
      const controller = window.resumeFixtures.get(sessionId).controller;
      const delta = 'Terminal native reasoning is collapsed, never leaked.';
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ delta, thinking: true })}\n\n`));
    });
    await page.waitForFunction(() => {
      const content = [...document.querySelectorAll('#chat-history .stream-content')].at(-1);
      return content?.querySelector('.thinking-section') && content.textContent.includes('Thinking');
    });
    const terminalFixture = await page.evaluate(() => [...window.resumeFixtures.entries()].at(-1)?.[0]);
    const terminalPending = await page.locator('#chat-history .stream-content').last().evaluate(node => ({
      thought: node.querySelector('.resume-thinking-content')?.textContent || '',
      reply: node.querySelector('.live-reply-content')?.textContent || '',
    }));
    assert.match(terminalPending.thought, /Terminal native reasoning/);
    assert.doesNotMatch(terminalPending.reply, /Terminal native reasoning/);
    await page.evaluate(async id => {
      const fixture = window.resumeFixtures.get(id);
      fixture.controller.close();
      await window.resumeResults.get(id);
    }, terminalFixture);
    const terminalThought = await page.locator('#chat-history .msg-ai').last().locator('.thinking-content-inner').textContent();
    assert.match(terminalThought, /Terminal native reasoning is collapsed/);
    assert.deepEqual(pageErrors, []);
    console.log('PASS resumed live Markdown and thinking formatting');
  } finally {
    await browser.close();
    server.close();
  }
})().catch(error => {
  console.error(error);
  server.close();
  process.exitCode = 1;
});
