import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const source = await readFile(new URL('../src-tauri/src/workspace_image_actions.js', import.meta.url), 'utf8');
test('desktop image menu keeps pixels and addresses separate', async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || '/opt/google/chrome/chrome', args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.route('http://127.0.0.1:7000/**', route => route.fulfill({ contentType: 'text/html', body: '<html></html>' }));
    await page.goto('http://127.0.0.1:7000/');
    await page.setContent('<img id="image" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX2sAAAAASUVORK5CYII=">');
    await page.evaluate(() => {
      window.writes = [];
      window.ClipboardItem = class { constructor(data) { this.data = data; } };
      Object.defineProperty(navigator, 'clipboard', { value: {
        write: async items => { const blob = await items[0].data['image/png']; window.writes.push({ type: blob.type, size: blob.size }); },
        writeText: async text => window.writes.push({ text })
      }, configurable: true });
    });
    await page.addScriptTag({ content: source });
    await page.locator('#image').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Copy image', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'Image copied to clipboard' }).waitFor();
    assert.deepEqual(await page.evaluate(() => writes.map(w => w.type)), ['image/png']);
    await page.locator('#image').click({ button: 'right' });
    assert.equal(await page.getByRole('menuitem', { name: 'Open in browser' }).isDisabled(), true);
    await page.getByRole('menuitem', { name: 'Copy image address' }).click();
    assert.match(await page.evaluate(() => writes[1].text), /^data:image\/png/);
    await page.locator('#image').click({ button: 'right' });
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('menu').isVisible(), false);
  } finally { await browser.close(); }
});

test('image failures suggest browser recovery only for cross-origin HTTP images', async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || '/opt/google/chrome/chrome', args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.route('http://127.0.0.1:7000/**', route => route.fulfill({ contentType: 'text/html', body: '<html><body><img id="image" src="http://127.0.0.1:7001/image.png"></body></html>' }));
    await page.route('http://127.0.0.1:7001/**', route => route.abort());
    await page.goto('http://127.0.0.1:7000/');
    await page.evaluate(() => {
      window.ClipboardItem = class { constructor(data) { this.data = data; } };
      Object.defineProperty(navigator, 'clipboard', { value: {
        write: async () => { throw new TypeError('Failed to fetch'); },
        writeText: async () => { throw new Error('clipboard unavailable'); }
      }, configurable: true });
      window.fetch = async () => { throw new TypeError('Failed to fetch'); };
    });
    await page.addScriptTag({ content: source });

    await page.locator('#image').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Copy image', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'Could not copy image pixels.' }).waitFor();
    assert.match(await page.getByRole('status').innerText(), /may block in-app access; choose Open in browser to copy it there\./);

    await page.locator('#image').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Save image', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'Could not save image.' }).waitFor();
    assert.match(await page.getByRole('status').innerText(), /may block in-app access; choose Open in browser to save it there\./);

    await page.locator('#image').evaluate(image => { image.src = '/same-origin.png'; });
    await page.locator('#image').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Save image', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'Could not save image' }).waitFor();
    assert.equal(await page.getByRole('status').innerText(), 'Could not save image');

    await page.locator('#image').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Copy image address', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'Could not copy image address' }).waitFor();
    assert.equal(await page.getByRole('status').innerText(), 'Could not copy image address');
  } finally { await browser.close(); }
});
