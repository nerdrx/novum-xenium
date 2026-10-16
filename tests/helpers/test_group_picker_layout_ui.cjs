const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

const css = fs.readFileSync('static/style.css', 'utf8');

(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.BROWSER_EXECUTABLE || '/opt/google/chrome/chrome',
    args: ['--no-sandbox', '--disable-gpu'],
  });
  try {
    for (const viewport of [1280, 320]) {
      const page = await browser.newPage({ viewport: { width: viewport, height: 720 } });
      await page.setContent(`<style>${css}</style>
        <main id="custom-preset-modal" style="box-sizing:border-box;width:460px;max-width:calc(100vw - 30px);padding:14px">
          <div id="group-participants">
            <div class="group-participant-picker">
              <select class="preset-input group-participant-model"><option>qwen3.5:9b · zVram · Local models</option></select>
              <select class="preset-input group-participant-character"><option>No character</option></select>
            </div>
            <div class="group-participant-entry" style="display:flex;padding:4px 6px">
              <span class="group-participant-copy"><span class="group-participant-title">qwen3.5:9b</span>
                <span class="group-participant-provider">zVram · Local models</span></span><button>×</button>
            </div>
          </div>
          <div class="msg" style="width:280px;margin-top:20px"><div class="body">${'A wrapped message line with readable words. '.repeat(12)}</div></div>
        </main>`);

      const metrics = await page.evaluate(() => {
        const root = document.querySelector('#group-participants');
        const modal = document.querySelector('#custom-preset-modal');
        const controls = [...root.querySelectorAll('select')];
        const body = document.querySelector('.msg .body');
        const range = document.createRange();
        range.selectNodeContents(body);
        return {
          viewport: innerWidth,
          modalWidth: modal.getBoundingClientRect().width,
          participantWidth: root.getBoundingClientRect().width,
          participantScrollWidth: root.scrollWidth,
          controls: controls.map(control => ({
            width: control.getBoundingClientRect().width,
            height: control.getBoundingClientRect().height,
            textOverflow: getComputedStyle(control).textOverflow,
          })),
          providerFontSize: getComputedStyle(root.querySelector('.group-participant-provider')).fontSize,
          messageWhiteSpace: getComputedStyle(body).whiteSpace,
          messageLines: range.getClientRects().length,
        };
      });

      assert.equal(metrics.modalWidth, viewport === 1280 ? 460 : 290);
      assert.ok(metrics.participantScrollWidth <= metrics.participantWidth, JSON.stringify(metrics));
      assert.ok(metrics.controls.every(control => control.width === metrics.participantWidth && control.height >= 44), JSON.stringify(metrics));
      assert.ok(metrics.controls.every(control => control.textOverflow === 'ellipsis'));
      assert.equal(metrics.providerFontSize, '12px');
      assert.equal(metrics.messageWhiteSpace, 'normal');
      assert.ok(metrics.messageLines > 1, JSON.stringify(metrics));
      console.log(`PASS ${viewport}px: ${JSON.stringify(metrics)}`);
      await page.close();
    }
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
