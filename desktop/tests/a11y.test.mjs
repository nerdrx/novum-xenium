import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_PACKAGE || 'playwright');
const script = await fs.readFile(new URL('../../static/js/a11y.js', import.meta.url), 'utf8');

test('tool windows are modeless while blocking dialogs keep their explicit semantics', async t => {
  const browser = await chromium.launch({ headless:true, executablePath:process.env.BROWSER_EXECUTABLE, args:['--no-sandbox'] });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`<main><textarea aria-label="Message"></textarea></main>
    <section id="tool" class="modal-content"><header class="modal-header"><h3>Library</h3></header><button>Close</button></section>
    <section id="blocking" class="modal-content" aria-modal="true"><header class="modal-header"><h3>Confirm</h3></header></section>`);
  await page.addScriptTag({content:script});
  assert.equal(await page.locator('#tool').getAttribute('role'), 'dialog');
  assert.equal(await page.locator('#tool').getAttribute('aria-modal'), 'false');
  assert.equal(await page.locator('#blocking').getAttribute('aria-modal'), 'true');
  const label = await page.locator('#tool').getAttribute('aria-labelledby');
  assert.equal(await page.locator(`#${label}`).textContent(), 'Library');
  await page.getByRole('textbox', {name:'Message'}).fill('Still usable');
  await page.evaluate(() => {
    const pane = document.createElement('section');
    pane.className = 'notes-pane';
    pane.innerHTML = '<h3 class="notes-pane-title">Notes</h3>';
    document.body.append(pane);
  });
  await page.waitForFunction(() => document.querySelector('.notes-pane').getAttribute('aria-modal') === 'false');
});
