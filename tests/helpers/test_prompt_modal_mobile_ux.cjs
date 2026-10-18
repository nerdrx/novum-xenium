const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

const repo = path.resolve(__dirname, '../..');
const evidenceDir = process.env.EVIDENCE_DIR || require('node:os').tmpdir();

function extractModal(html) {
  const start = html.indexOf('<div id="custom-preset-modal"');
  const tags = /<\/?div\b[^>]*>/gi;
  tags.lastIndex = start;
  let depth = 0;
  for (let match; (match = tags.exec(html));) {
    if (/^<div\b/i.test(match[0])) depth++;
    else depth--;
    if (!depth) return html.slice(start, tags.lastIndex);
  }
  throw new Error('Could not extract actual Prompt modal shell');
}

async function main() {
  fs.mkdirSync(evidenceDir, { recursive: true });
  const { appCss } = await import(path.join(repo, 'tests/helpers/stylesheets.mjs'));
  const source = fs.readFileSync(path.join(repo, 'static/index.html'), 'utf8');
  const presetsSource = fs.readFileSync(path.join(repo, 'static/js/presets.js'), 'utf8');
  const modal = extractModal(source);
  const tabsStart = presetsSource.indexOf('function initCharTabs() {');
  const tabsEnd = presetsSource.indexOf('\nfunction initExpandButton()', tabsStart);
  assert.ok(tabsStart >= 0 && tabsEnd > tabsStart, 'Found production Prompt tab initializer');
  const tabInitializer = presetsSource.slice(tabsStart, tabsEnd);
  const focusMatch = presetsSource.match(/modal\.querySelector\('\.preset-tab\.active'\)\?\.focus\(\{ preventScroll: true \}\);/);
  assert.ok(focusMatch, 'Found production active-tab focus statement');
  const css = await appCss();
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.BROWSER_EXECUTABLE || '/opt/google/chrome/chrome',
  });
  const report = {
    scope: 'Actual Prompt modal markup and full stylesheet order; fake participant text only; no API, settings writes, chat, or model calls.',
    stylesheetCount: (source.match(/<link\b[^>]*rel="stylesheet"/g) || []).length,
    viewports: [],
  };

  try {
    for (const viewport of [
      { width: 320, height: 720 },
      { width: 390, height: 844 },
      { width: 600, height: 320 },
      { width: 1280, height: 900 },
    ]) {
      const page = await browser.newPage({ viewport });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.setContent(`<!doctype html><html class="nx-workspace" lang="en"><head><meta charset="utf-8"><style>${css}</style></head><body class="theme-novum-xenium"><button id="fixture-opener">Open Prompt</button>${modal}</body></html>`);
      await page.evaluate(() => document.fonts.ready);
      await page.addScriptTag({ content: `${tabInitializer}\ninitCharTabs();` });
      await page.evaluate(() => {
        const modalEl = document.getElementById('custom-preset-modal');
        const select = document.getElementById('char-template-select');
        select.innerHTML = '<option value="fake">Synthetic persona</option>';
        document.getElementById('fixture-opener').focus();
        modalEl.classList.remove('hidden');
        modalEl.querySelector('.preset-tab[data-chartab="character"]').click();
      });
      await page.evaluate(`const modal = document.getElementById('custom-preset-modal');\n${focusMatch[0]}`);
      await page.waitForTimeout(300);
      const persona = await page.evaluate(() => {
        const select = document.getElementById('char-template-select');
        const rect = select.getBoundingClientRect();
        return {
          selectName: [...select.labels].map(label => label.textContent.trim()).join(' '),
          focusedTab: document.activeElement?.dataset?.chartab || null,
          visible: rect.width > 0 && rect.height > 0,
        };
      });
      assert.equal(persona.selectName, 'Persona', `Persona select is labelled at ${viewport.width}px`);
      assert.equal(persona.focusedTab, 'character', `Open focuses active tab at ${viewport.width}px`);
      assert.equal(persona.visible, true, `Persona control visible at ${viewport.width}px`);

      await page.locator('.preset-tab[data-chartab="group"]').click();
      const group = await page.evaluate(() => {
        const modalEl = document.getElementById('custom-preset-modal');
        if (document.activeElement !== modalEl.querySelector('.preset-tab[data-chartab="group"]')) {
          throw new Error('Group tab click did not move focus to the selected tab');
        }
        const participants = document.getElementById('group-participants');
        participants.innerHTML = '';
        for (let index = 0; index < 3; index++) {
          const row = document.createElement('div');
          row.className = 'group-participant-entry';
          row.style.cssText = 'display:flex;align-items:center;gap:6px;padding:4px 6px;background:color-mix(in srgb, var(--fg) 3%, transparent);border-radius:6px;';
          row.innerHTML = `<span class="group-participant-copy"><span class="group-participant-title">Synthetic long participant ${index + 1} with an intentionally long descriptive persona title</span><span class="group-participant-provider">Large local model · Synthetic provider endpoint</span></span><button title="Remove">×</button>`;
          participants.appendChild(row);
        }
        document.getElementById('group-add-btn').style.opacity = '1';
        const box = element => {
          const rect = element.getBoundingClientRect();
          return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, top: rect.top, bottom: rect.bottom };
        };
        const rows = [...participants.querySelectorAll('.group-participant-entry')].map(row => {
          const copy = row.querySelector('.group-participant-copy');
          const remove = row.querySelector('button');
          return {
            row: box(row),
            scrollHeight: row.scrollHeight,
            clientHeight: row.clientHeight,
            copy: box(copy),
            remove: box(remove),
            copyRightBeforeRemove: copy.getBoundingClientRect().right <= remove.getBoundingClientRect().left,
          };
        });
        return {
          viewport: { width: innerWidth, height: innerHeight, scrollY },
          activeTab: modalEl.querySelector('.preset-tab.active')?.dataset.chartab || null,
          modalRect: box(modalEl.querySelector('.preset-modal-content')),
          modalStyle: {
            position: getComputedStyle(modalEl.querySelector('.preset-modal-content')).position,
            height: getComputedStyle(modalEl.querySelector('.preset-modal-content')).height,
            maxHeight: getComputedStyle(modalEl.querySelector('.preset-modal-content')).maxHeight,
          },
          mode: box(document.getElementById('group-mode-btn')),
          tabActive: modalEl.querySelector('.preset-tab[data-chartab="group"]').classList.contains('active'),
          add: box(document.getElementById('group-add-btn')),
          rows,
          participantContainer: {
            scrollHeight: participants.scrollHeight,
            clientHeight: participants.clientHeight,
            overflowY: getComputedStyle(participants).overflowY,
          },
          footer: ['save-custom-preset', 'cancel-custom-preset'].map(id => box(document.getElementById(id))),
          documentWidth: document.documentElement.scrollWidth,
          viewportWidth: innerWidth,
        };
      });
      assert.equal(group.documentWidth, viewport.width, `No horizontal overflow at ${viewport.width}x${viewport.height}`);
      assert.equal(group.activeTab, 'group', `The actual Group tab click selects its panel at ${viewport.width}px`);
      assert.equal(group.viewport.scrollY, 0, `Opening and selecting tabs does not shift the page at ${viewport.width}px`);
      assert.ok(group.modalRect.y >= 0 && group.modalRect.bottom <= viewport.height, `Settled modal stays within viewport at ${viewport.width}x${viewport.height}`);
      if (viewport.width <= 768) {
        assert.ok(group.mode.height >= 44, `Group mode is at least 44px high at ${viewport.width}px`);
        assert.ok(group.add.height >= 44, `Add is at least 44px high at ${viewport.width}px`);
      }
      for (let index = 0; index < group.rows.length; index++) {
        const row = group.rows[index];
        if (viewport.width <= 768) {
          assert.ok(row.row.height >= row.scrollHeight, `Participant row ${index + 1} contains its full copy at ${viewport.width}px`);
          assert.ok(row.copy.y >= row.row.y && row.copy.y + row.copy.height <= row.row.bottom, `Participant copy stays within row ${index + 1} at ${viewport.width}px`);
          assert.ok(row.copyRightBeforeRemove, `Participant copy does not collide with Remove ${index + 1} at ${viewport.width}px`);
          assert.ok(row.remove.width >= 44 && row.remove.height >= 44, `Remove ${index + 1} meets 44px target at ${viewport.width}px`);
        }
        if (index) assert.ok(group.rows[index - 1].row.bottom <= row.row.top, `Participant rows ${index} and ${index + 1} do not overlap at ${viewport.width}px`);
      }
      const pageErrors = [...errors];
      assert.deepEqual(pageErrors, [], `No browser page errors at ${viewport.width}px`);
      const screenshot = path.join(evidenceDir, `prompt-${viewport.width}x${viewport.height}.png`);
      await page.screenshot({ path: screenshot });
      const reachable = [];
      for (const selector of ['#group-mode-btn', '#group-participants .group-participant-entry:last-child button', '#group-add-btn', '#save-custom-preset']) {
        const locator = page.locator(selector);
        if (!await locator.isVisible()) continue;
        await locator.scrollIntoViewIfNeeded();
        const rect = await locator.boundingBox();
        const isReachable = rect && rect.x < viewport.width && rect.x + rect.width > 0 && rect.y < viewport.height && rect.y + rect.height > 0;
        assert.ok(isReachable, `${selector} can be scrolled into view at ${viewport.width}x${viewport.height}`);
        reachable.push({ selector, rect });
      }
      const bottomScreenshot = path.join(evidenceDir, `prompt-${viewport.width}x${viewport.height}-group-bottom.png`);
      await page.screenshot({ path: bottomScreenshot });
      report.viewports.push({ viewport, persona, group, reachable, pageErrors, screenshot, bottomScreenshot });
      await page.close();
    }
    report.notes = [
      'The mobile participant rows retain natural height so long synthetic titles/providers cannot compress into neighboring rows; the existing participant container remains scrollable.',
      'Desktop target sizing remains governed by existing desktop rules; the 1280px fixture records unchanged compact metrics for review.',
      'Screenshots are viewport-sized: the initial capture follows the 300ms sheet transition and has scrollY 0; the second capture follows deliberate scrollIntoViewIfNeeded calls for Group controls and Start.',
      'The fixture imports the actual initCharTabs function from presets.js and asserts the clicked Group tab is the only selected panel. It exercises the production open-focus statement after opening the Character tab.',
    ];
    fs.writeFileSync(path.join(evidenceDir, 'prompt-modal-ux-results.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
