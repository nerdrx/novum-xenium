import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createRequire} from 'node:module';
const {chromium} = createRequire(import.meta.url)(process.env.PLAYWRIGHT_PACKAGE || 'playwright');
const root = new URL('../../modules/', import.meta.url);
const catalog = JSON.parse(await fs.readFile(new URL('index.json', root)));

test('subagent module filters tasks and opens child chats through the sandbox bridge', async t => {
  const browser = await chromium.launch({headless:true, executablePath:process.env.BROWSER_EXECUTABLE, args:['--no-sandbox']});
  t.after(() => browser.close());
  for (const entry of catalog.modules) {
    const manifest = JSON.parse(await fs.readFile(new URL(`${entry.path}/module.json`, root)));
    const markup = await fs.readFile(new URL(`${entry.path}/panel.html`, root), 'utf8');
    const page = await browser.newPage({viewport:{width:600,height:700}});
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setContent('<iframe sandbox="allow-scripts" style="width:100%;height:650px"></iframe>');
    await page.evaluate(({markup, capability}) => {
      window.requests = [];
      const frame = document.querySelector('iframe');
      addEventListener('message', event => {
        if (event.source !== frame.contentWindow) return;
        if (event.data?.type === 'novum:open') { window.opened = event.data; return; }
        if (event.data?.type !== 'novum:request') return;
        window.requests.push(event.data);
        if (event.data.capability !== capability) throw new Error('Unexpected capability');
        frame.contentWindow.postMessage({type:'novum:response', id:event.data.id, data:{
          summary:{Entries:1}, items:[{title:'<img src=x onerror=alert(1)>', detail:'Actual fixture data', status:'running', session_id:'child-123', model:'local-model'}],
          notice:'Read-only fixture.',
        }}, '*');
      });
      frame.srcdoc = markup;
    }, {markup, capability:manifest.permissions[0]});
    const panel = page.frameLocator('iframe');
    await panel.getByRole('heading', {name:'<img src=x onerror=alert(1)>', exact:true}).waitFor();
    assert.equal(await panel.locator('img').count(), 0, 'data is rendered as text');
    await panel.getByRole('button', {name:'Open chat', exact:true}).click();
    assert.deepEqual(await page.evaluate(() => window.opened), {type:'novum:open',action:'session',session_id:'child-123'});
    await panel.getByRole('combobox').selectOption('finished');
    await panel.getByText('No matching agents. Try another name or status.', {exact:true}).waitFor();
    await panel.getByRole('combobox').selectOption('all');
    await panel.getByRole('searchbox').fill('no-match');
    await panel.getByText('No matching agents. Try another name or status.', {exact:true}).waitFor();
    await panel.getByRole('button', {name:'Refresh', exact:true}).click();
    assert.equal(await page.evaluate(() => window.requests.length), 2);
    assert.equal(await panel.locator('body').evaluate(body => body.scrollWidth <= innerWidth), true);
    assert.deepEqual(errors, [], manifest.id);
    await page.close();
  }
});
