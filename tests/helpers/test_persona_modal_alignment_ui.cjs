const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

const css = fs.readFileSync('static/style.css', 'utf8');
const source = fs.readFileSync('static/index.html', 'utf8');
const start = source.indexOf('<div id="custom-preset-modal"');
assert.ok(start >= 0, 'Persona modal exists in the app shell');
const tags = /<\/?div\b[^>]*>/gi;
tags.lastIndex = start;
let depth = 0;
let end = -1;
for (let match; (match = tags.exec(source));) {
  if (/^<div\b/i.test(match[0])) depth += 1;
  else depth -= 1;
  if (depth === 0) { end = tags.lastIndex; break; }
}
assert.ok(end > start, 'Persona modal markup is balanced');
const modal = source.slice(start, end).replace('class="modal hidden"', 'class="modal"');

(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.BROWSER_EXECUTABLE || '/opt/google/chrome/chrome',
    args: ['--no-sandbox', '--disable-gpu'],
  });
  try {
    for (const width of [1280, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      await page.setContent(`<style>${css}</style>${modal}`);
      await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important}body{margin:0}' });
      await page.evaluate(() => {
        document.querySelector('[data-chartab="inject"]')?.classList.remove('active');
        document.querySelector('[data-chartab="character"]')?.classList.add('active');
        document.querySelector('[data-chartab-panel="inject"]')?.setAttribute('style', 'display:none');
        document.querySelector('[data-chartab-panel="character"]')?.setAttribute('style', 'display:block');
        document.querySelector('#custom-character-name').value = 'Lanalu';
        document.querySelector('#char-delete-template-btn').style.display = '';
        document.querySelector('#reset-character-btn').style.display = 'none';
        document.querySelector('#save-custom-preset').textContent = 'Start Persona';
      });
      await page.waitForTimeout(50);
      const metrics = await page.evaluate(() => {
        const rect = selector => {
          const element = document.querySelector(selector);
          const r = element.getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
        };
        const modal = rect('.preset-modal-content');
        return {
          viewport: innerWidth,
          modal,
          select: rect('#char-template-select'),
          name: rect('#custom-character-name'),
          newButton: rect('#char-new-btn'),
          deleteButton: rect('#char-delete-template-btn'),
          textarea: rect('#custom-system-prompt'),
          expandButton: rect('#char-expand-btn'),
          startButton: rect('#save-custom-preset'),
          startAlign: getComputedStyle(document.querySelector('#save-custom-preset')).alignItems,
          startDisplay: getComputedStyle(document.querySelector('#save-custom-preset')).display,
          startJustify: getComputedStyle(document.querySelector('#save-custom-preset')).justifyContent,
          startIconWidth: parseFloat(getComputedStyle(document.querySelector('#save-custom-preset'), '::before').width),
          startGap: parseFloat(getComputedStyle(document.querySelector('#save-custom-preset')).gap),
          controlHeights: ['#char-template-select', '#char-new-btn', '#custom-character-name', '#char-delete-template-btn', '#save-custom-preset']
            .map(selector => rect(selector).height),
          buttonTextBounds: ['#char-new-btn', '#char-delete-template-btn', '#char-expand-btn', '#save-custom-preset'].map(selector => {
            const element = document.querySelector(selector);
            const range = document.createRange();
            range.selectNodeContents(element);
            const r = range.getBoundingClientRect();
            const b = element.getBoundingClientRect();
            return { selector, x: r.x, y: r.y, width: r.width, height: r.height,
              buttonX: b.x, buttonY: b.y, buttonWidth: b.width, buttonHeight: b.height };
          }),
          overflowX: document.documentElement.scrollWidth > innerWidth,
          mobileControlMinHeights: ['#char-template-select', '#char-new-btn', '#custom-character-name', '#char-delete-template-btn', '#save-custom-preset']
            .map(selector => parseFloat(getComputedStyle(document.querySelector(selector)).minHeight)),
          labels: [...document.querySelectorAll('.preset-chartab[data-chartab-panel="character"] > label')].map(el => ({
            text: el.textContent.trim(), x: el.getBoundingClientRect().x, width: el.getBoundingClientRect().width,
          })),
        };
      });
      const close = (a, b, tolerance, description) => assert.ok(
        Math.abs(a - b) <= tolerance, `${description}: ${a} vs ${b}`
      );
      assert.ok(Math.abs(metrics.modal.x - (width - metrics.modal.width) / 2) <= 1,
        `${width}px modal should be centered horizontally`);
      close(metrics.select.x, metrics.name.x, 1, `${width}px fields share a left edge`);
      close(metrics.select.right, metrics.name.right, 1, `${width}px fields share a right edge`);
      close(metrics.select.y + metrics.select.height / 2, metrics.newButton.y + metrics.newButton.height / 2, 1,
        `${width}px picker and New button share a centerline`);
      close(metrics.name.y + metrics.name.height / 2, metrics.deleteButton.y + metrics.deleteButton.height / 2, 1,
        `${width}px name and Delete button share a centerline`);
      close(metrics.newButton.width, metrics.deleteButton.width, 1, `${width}px action buttons share a width`);
      assert.ok(metrics.expandButton.right <= metrics.textarea.right - 4,
        `${width}px Expand stays inside the prompt field`);
      assert.ok(metrics.textarea.bottom - metrics.expandButton.bottom >= 1 &&
        metrics.textarea.bottom - metrics.expandButton.bottom <= 3,
        `${width}px Expand keeps a small aligned inset from the field bottom`);
      assert.equal(metrics.startAlign, 'center', `${width}px Start icon and text align vertically`);
      assert.equal(metrics.startJustify, 'center', `${width}px Start icon and text form a centered group`);
      const startText = metrics.buttonTextBounds.find(item => item.selector === '#save-custom-preset');
      const startGroupLeft = startText.x - metrics.startIconWidth - metrics.startGap;
      close(startGroupLeft + (startText.width + metrics.startIconWidth + metrics.startGap) / 2,
        metrics.startButton.x + metrics.startButton.width / 2, 1,
        `${width}px Start icon and text group is centered horizontally`);
      close(startText.y + startText.height / 2,
        metrics.startButton.y + metrics.startButton.height / 2, 2,
        `${width}px Start label is vertically centered`);
      assert.equal(metrics.overflowX, false, `${width}px dialog must not cause horizontal scrolling`);
      for (const item of metrics.buttonTextBounds) {
        assert.ok(item.width > 0 && item.height > 0, `${width}px ${item.selector} text is visible`);
        assert.ok(item.x >= item.buttonX && item.x + item.width <= item.buttonX + item.buttonWidth,
          `${width}px ${item.selector} text is not clipped horizontally`);
      }
      if (width <= 768) {
        assert.ok(metrics.mobileControlMinHeights.every(height => height >= 44),
          'mobile Persona controls keep 44px touch targets');
      }
      await page.screenshot({ path: `/tmp/persona-modal-alignment-${width}.png` });
      console.log(`PASS ${width}px: ${JSON.stringify(metrics)}`);
      await page.close();
    }
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
