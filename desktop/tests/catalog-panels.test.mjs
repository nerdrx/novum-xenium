import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createRequire} from 'node:module';
const {chromium} = createRequire(import.meta.url)(process.env.PLAYWRIGHT_PACKAGE || 'playwright');
const root = new URL('../../modules/', import.meta.url);
const catalog = JSON.parse(await fs.readFile(new URL('index.json', root)));

test('all six shipped data panels render host responses safely inside opaque frames', async t => {
  const browser = await chromium.launch({headless:true, executablePath:process.env.BROWSER_EXECUTABLE, args:['--no-sandbox']});
  t.after(() => browser.close());
  for (const entry of catalog.modules.filter(item => item.path !== 'focus-timer')) {
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
        if (event.source !== frame.contentWindow || event.data?.type !== 'novum:request') return;
        window.requests.push(event.data);
        if (event.data.capability !== capability) throw new Error('Unexpected capability');
        frame.contentWindow.postMessage({type:'novum:response', id:event.data.id, data:{
          summary:{Entries:1}, items:[{title:'<img src=x onerror=alert(1)>', detail:'Actual fixture data', status:'Ready'}],
          notice:'Read-only fixture.',
        }}, '*');
      });
      frame.srcdoc = markup;
    }, {markup, capability:manifest.permissions[0]});
    const panel = page.frameLocator('iframe');
    await panel.getByRole('heading', {name:'<img src=x onerror=alert(1)>', exact:true}).waitFor();
    assert.equal(await panel.locator('img').count(), 0, 'data is rendered as text');
    await panel.getByRole('searchbox').fill('no-match');
    await panel.getByText('No matching entries.', {exact:true}).waitFor();
    await panel.getByRole('button', {name:'Refresh', exact:true}).click();
    assert.equal(await page.evaluate(() => window.requests.length), 2);
    assert.equal(await panel.locator('body').evaluate(body => body.scrollWidth <= innerWidth), true);
    assert.deepEqual(errors, [], manifest.id);
    await page.close();
  }
});
