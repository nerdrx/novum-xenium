const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('../../desktop/node_modules/playwright');

async function main() {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    console.error(`SKIP_BROWSER: ${error.message}`);
    process.exitCode = 77;
    return;
  }

  try {
    const css = fs.readFileSync(
      path.resolve(__dirname, '../../static/style.css'), 'utf8'
    );
    const page = await browser.newPage();
    await page.setContent(`
      <html class="theme-novum-xenium">
        <head><style>${css}</style></head>
        <body>
          <div class="modal-content">
            <div class="email-reader-body">
              <div class="email-summary-panel">
                <div class="email-summary-content">
                  PayPal confirmed 16,99 € on 15.10.2026
                </div>
              </div>
              <div class="email-inline-image-load-all">
                <span>9 hidden inline images</span>
              </div>
              Sie haben 16,99 EUR bezahlt
            </div>
          </div>
          <textarea class="doc-editor-textarea email-mode">
            Total 16,99 EUR on 15.10.2026
          </textarea>
          <span class="emoji">✅</span>
        </body>
      </html>
    `);

    for (const selector of [
      '.email-reader-body',
      '.email-summary-content',
      '.email-inline-image-load-all span',
      'textarea.email-mode',
    ]) {
      const actual = await page.locator(selector).evaluate(
        element => getComputedStyle(element).fontVariantEmoji
      );
      if (actual === 'emoji') {
        throw new Error(`${selector} forces emoji presentation`);
      }
    }

    const emojiVariant = await page.locator('.emoji').evaluate(
      element => getComputedStyle(element).fontVariantEmoji
    );
    if (emojiVariant !== 'emoji') {
      throw new Error('the explicit .emoji wrapper lost emoji presentation');
    }
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
