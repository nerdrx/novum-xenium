// Browser regression for workspace skin compatibility with user themes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

const repo = path.resolve(__dirname, '../..');
const screenshotDir = process.env.NX_SKIN_SCREENSHOT_DIR || '/tmp';
const sourceHtml = fs.readFileSync(path.join(repo, 'static/index.html'), 'utf8');
// Keep the real app shell and stylesheet, but do not run app/API modules.
const html = sourceHtml
  .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
  .replace(/<link\b[^>]*rel=["']modulepreload["'][^>]*>/gi, '');

const mime = {
  '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.json': 'application/json',
};
const server = http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://fixture').pathname);
  if (pathname.startsWith('/api/')) {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ value: null }));
    return;
  }
  if (pathname === '/') {
    res.setHeader('Content-Type', 'text/html');
    res.end(html);
    return;
  }
  const file = path.resolve(repo, `.${pathname}`);
  if (!file.startsWith(repo + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404); res.end(); return;
  }
  res.setHeader('Content-Type', mime[path.extname(file)] || 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
});

function noOverflow(metrics, label) {
  assert.ok(metrics.documentWidth <= metrics.viewportWidth, `${label} document overflow: ${JSON.stringify(metrics)}`);
  assert.ok(metrics.bodyWidth <= metrics.viewportWidth, `${label} body overflow: ${JSON.stringify(metrics)}`);
}

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.BROWSER_EXECUTABLE,
    args: ['--no-sandbox', '--disable-gpu'],
  });
  try {
    fs.mkdirSync(screenshotDir, { recursive: true });
    const origin = `http://127.0.0.1:${server.address().port}`;
    for (const viewport of [
      { name: 'desktop', width: 1440, height: 900 },
      { name: 'mobile', width: 390, height: 844 },
    ]) {
      const page = await browser.newPage({ viewport });
      const pageErrors = [];
      page.on('pageerror', error => pageErrors.push(String(error)));
      await page.goto(origin, { waitUntil: 'networkidle' });
      await page.evaluate(() => {
        document.getElementById('app-loader')?.remove();
        document.activeElement?.blur?.();
        const welcome = document.querySelector('#welcome-screen');
        welcome.style.animation = 'none';
        welcome.style.transition = 'none';
        welcome.style.setProperty('opacity', '1', 'important');
        if (innerWidth <= 768) document.querySelector('#sidebar')?.classList.add('hidden');
      });
      const theme = await page.evaluate(async () => {
        const module = await import('/static/js/theme.js');
        window.nxTheme = module.default;
        window.nxThemes = module.THEMES;
        return true;
      });
      assert.ok(theme);
      await page.evaluate(async () => document.fonts.ready);
      await page.evaluate(() => window.nxTheme.applyColors(window.nxThemes['novum-xenium']));
      const welcome = await page.evaluate(() => {
        const heading = document.querySelector('#welcome-screen .welcome-name');
        const logo = heading.querySelector('img');
        return {
          onlyLogo: [...heading.childNodes].every(node => node.nodeType !== Node.TEXT_NODE || !node.textContent.trim()) && heading.children.length === 1 && heading.children[0] === logo,
          alt: logo.getAttribute('alt'),
          ariaHidden: logo.getAttribute('aria-hidden'),
          display: getComputedStyle(document.querySelector('#welcome-screen')).display,
          opacity: getComputedStyle(document.querySelector('#welcome-screen')).opacity,
        };
      });
      assert.equal(welcome.onlyLogo, true, 'welcome heading contains only the brand logo');
      assert.equal(welcome.alt, 'Novum Xenium', 'welcome logo carries the accessible brand name');
      assert.equal(welcome.ariaHidden, null, 'welcome logo stays exposed to assistive technology');
      assert.equal(welcome.display, 'flex', 'welcome mark stays visible');
      assert.ok(Number(welcome.opacity) > 0, 'welcome mark is rendered');
      await page.screenshot({ path: path.join(screenshotDir, `nx-skin-welcome-${viewport.name}.png`), fullPage: true });
      await page.evaluate(() => {
        // Real chat rows arrive during hydration; use representative local DOM fixtures.
        document.querySelector('#chat-history').innerHTML = `
          <div class="msg msg-user"><div class="body">A sample user message</div></div>
          <div class="msg msg-ai tool-splash"><div class="body"><div class="agent-tool-output">Tool output preview</div></div></div>`;
        document.querySelector('#welcome-screen').classList.add('hidden');
      });

      const sheetState = await page.evaluate(() => ({
        linked: [...document.styleSheets].some(sheet => sheet.href?.includes('/static/nx-ui.css')),
        scoped: document.documentElement.classList.contains('nx-workspace'),
        shellControls: [...document.querySelectorAll('.sidebar .list-item')].length,
      }));
      assert.ok(sheetState.linked, 'workspace skin stylesheet must load after base stylesheet');
      assert.ok(sheetState.scoped, 'workspace skin scope is present on the document root');
      assert.ok(sheetState.shellControls > 0, 'real sidebar controls must be present');

      const baseline = await page.evaluate(() => {
        const item = document.querySelector('#tool-memory-btn');
        const chat = document.querySelector('#chat-container');
        const userMessage = document.querySelector('.msg-user');
        const toolOutput = document.querySelector('.agent-tool-output');
        const brandButton = document.querySelector('#sidebar-brand-btn');
        const brandLogo = document.querySelector('#sidebar-brand-btn .sidebar-brand-logo');
        const brandRect = brandLogo.getBoundingClientRect();
        const brandButtonStyle = getComputedStyle(brandButton);
        return {
          viewportWidth: innerWidth,
          documentWidth: document.documentElement.scrollWidth,
          bodyWidth: document.body.scrollWidth,
          sidebarItemMinHeight: parseFloat(getComputedStyle(item).minHeight),
          sidebarItemRadius: parseFloat(getComputedStyle(item).borderTopLeftRadius),
          chatDisplay: getComputedStyle(chat).display,
          messageRadius: parseFloat(getComputedStyle(userMessage).borderTopLeftRadius),
          toolRadius: parseFloat(getComputedStyle(toolOutput).borderTopLeftRadius),
          brandLabel: brandButton.getAttribute('aria-label'),
          hasSidebarBrandTitle: !!brandButton.querySelector('.sidebar-brand-title'),
          brandLogoWidth: brandRect.width,
          brandLogoHeight: brandRect.height,
          brandLogoFit: getComputedStyle(brandLogo).objectFit,
          brandLogoAlt: brandLogo.getAttribute('alt'),
          brandLogoHidden: brandLogo.getAttribute('aria-hidden'),
          brandButtonMinWidth: parseFloat(brandButtonStyle.minWidth),
          brandButtonMinHeight: parseFloat(brandButtonStyle.minHeight),
        };
      });
      noOverflow(baseline, viewport.name);
      assert.ok(baseline.sidebarItemMinHeight >= 32, 'sidebar controls keep usable minimum height');
      assert.ok(baseline.sidebarItemRadius > 0, 'skin applies a rounded control surface');
      assert.ok(baseline.messageRadius > 0, 'chat message surface receives workspace treatment');
      assert.ok(baseline.toolRadius > 0, 'tool output surface receives workspace treatment');
      assert.equal(baseline.brandLabel, 'New chat', 'logo-only sidebar button keeps its accessible action name');
      assert.equal(baseline.hasSidebarBrandTitle, false, 'sidebar brand displays logo without adjacent title text');
      assert.equal(baseline.brandLogoFit, 'contain', 'sidebar logo preserves its image ratio');
      assert.equal(baseline.brandLogoAlt, '', 'sidebar logo remains decorative');
      assert.equal(baseline.brandLogoHidden, 'true', 'sidebar logo stays hidden from assistive technology');
      assert.ok(baseline.brandButtonMinWidth >= 44 && baseline.brandButtonMinHeight >= 44, `sidebar logo keeps a comfortable pointer target: ${JSON.stringify(baseline)}`);
      assert.notEqual(baseline.chatDisplay, 'none', 'chat shell stays visible');

      const modelMenu = page.locator('#model-picker-menu');
      assert.equal(await modelMenu.isVisible(), false, 'model picker starts hidden');
      await modelMenu.evaluate(el => el.classList.remove('hidden'));
      assert.equal(await modelMenu.isVisible(), true, 'model picker opens');
      const modelRadius = await modelMenu.evaluate(el => parseFloat(getComputedStyle(el).borderTopLeftRadius));
      assert.ok(modelRadius > 0, 'model menu keeps its workspace panel treatment');
      await modelMenu.evaluate(el => el.classList.add('hidden'));
      assert.equal(await modelMenu.isVisible(), false, 'model picker closes');

      if (viewport.name === 'desktop') {
        await page.evaluate(() => document.activeElement?.blur?.());
        await page.locator('#sidebar-new-chat-btn').focus();
        await page.keyboard.press('Tab');
        const focus = await page.evaluate(() => {
          const el = document.activeElement;
          const style = getComputedStyle(el);
          return { id: el.id, visible: el.matches(':focus-visible'), outline: style.outlineStyle, shadow: style.boxShadow };
        });
        assert.equal(focus.id, 'sidebar-search-btn', 'keyboard focus advances through sidebar controls');
        assert.equal(focus.visible, true, 'keyboard focus remains visible');
        assert.ok(focus.outline !== 'none' || focus.shadow !== 'none', `focus indicator is rendered: ${JSON.stringify(focus)}`);
        await page.evaluate(() => document.activeElement?.blur?.());
      }

      // Exercise real theme.js functions with dark, light, and custom palettes.
      for (const palette of ['dark', 'light', 'custom']) {
        await page.evaluate(({ paletteName }) => {
          const colors = paletteName === 'custom'
            ? { ...window.nxThemes.dark, red: '#8b5cf6', advanced: { brandColor: '#8b5cf6', inputBg: '#22202a', bubbleBorder: '#4a5b6c' } }
            : window.nxThemes[paletteName];
          const custom = paletteName === 'custom';
          window.nxTheme.applyColors(colors);
          window.nxTheme.applyFontDensity(custom ? 'serif' : 'sans', custom ? 'compact' : 'comfortable');
        }, { paletteName: palette });
        // Public module API is installed on the page only for this fixture.
        const state = await page.evaluate(({ custom }) => {
          const rootStyle = getComputedStyle(document.documentElement);
          return {
            bg: rootStyle.getPropertyValue('--bg').trim(),
            red: rootStyle.getPropertyValue('--red').trim(),
            brand: rootStyle.getPropertyValue('--brand-color').trim(),
            input: rootStyle.getPropertyValue('--input-bg').trim(),
            font: rootStyle.getPropertyValue('--font-family').trim(),
            compact: document.documentElement.classList.contains('density-compact'),
            spacious: document.documentElement.classList.contains('density-spacious'),
            rowMinHeight: parseFloat(getComputedStyle(document.querySelector('#tool-memory-btn')).minHeight),
            sectionMinHeight: parseFloat(getComputedStyle(document.querySelector('.section-header-flex')).minHeight),
            bubbleBorder: rootStyle.getPropertyValue('--bubble-border').trim(),
            userMessageBorder: getComputedStyle(document.querySelector('.msg-user')).borderTopColor,
            aiMessageBorder: getComputedStyle(document.querySelector('.msg-ai')).borderTopColor,
            custom,
          };
        }, { custom: palette === 'custom' });
        const expected = await page.evaluate(name => name === 'custom' ? window.nxThemes.dark : window.nxThemes[name], palette);
        assert.equal(state.bg, expected.bg, `${palette} background remains theme-controlled`);
        assert.equal(state.red, palette === 'custom' ? '#8b5cf6' : expected.red, `${palette} accent remains theme-controlled`);
        if (palette === 'custom') {
          assert.equal(state.brand, '#8b5cf6', 'custom brand color survives skin');
          assert.equal(state.input, '#22202a', 'advanced input color survives skin');
          assert.equal(state.brand, '#8b5cf6', 'custom brand color remains available to other themed surfaces');
          assert.ok(state.font.includes('Georgia'), 'selected serif font survives skin');
          assert.equal(state.compact, true, 'selected compact density survives skin');
          assert.equal(state.rowMinHeight, 28, 'compact density keeps compact sidebar rows');
          assert.equal(state.sectionMinHeight, 28, 'compact density keeps compact section headers');
          assert.equal(state.bubbleBorder, '#4a5b6c', 'advanced bubble border remains theme-controlled');
          assert.equal(state.userMessageBorder, 'rgb(74, 91, 108)', 'custom bubble border reaches user messages');
          assert.equal(state.aiMessageBorder, 'rgb(74, 91, 108)', 'custom bubble border reaches assistant messages');

          await page.evaluate(() => window.nxTheme.applyFontDensity('serif', 'spacious'));
          const spacious = await page.evaluate(() => ({
            active: document.documentElement.classList.contains('density-spacious'),
            row: parseFloat(getComputedStyle(document.querySelector('#tool-memory-btn')).minHeight),
            section: parseFloat(getComputedStyle(document.querySelector('.section-header-flex')).minHeight),
          }));
          assert.deepEqual(spacious, { active: true, row: 40, section: 40 }, 'spacious density keeps roomy sidebar controls');
          await page.evaluate(() => window.nxTheme.applyFontDensity('serif', 'compact'));
        } else {
          assert.equal(state.compact, false, 'comfortable density remains the default');
          assert.equal(state.spacious, false, 'comfortable density does not inherit spacious layout');
          assert.equal(state.rowMinHeight, 32, `${palette} theme keeps comfortable sidebar rows: ${JSON.stringify(state)}`);
          assert.equal(state.sectionMinHeight, 32, `${palette} theme keeps comfortable section headers: ${JSON.stringify(state)}`);
        }
      }

      await page.evaluate(() => {
        window.nxTheme.applyBgPattern('dots');
        window.nxTheme.applyFrostedGlass(true);
      });
      const options = await page.evaluate(() => ({
        dots: document.body.classList.contains('bg-pattern-dots'),
        frosted: document.body.classList.contains('theme-frosted'),
        density: document.documentElement.classList.contains('density-compact'),
      }));
      assert.deepEqual(options, { dots: true, frosted: true, density: true }, 'background, frosted glass, and density choices stay active');

      const themedLayout = await page.evaluate(() => ({
        viewportWidth: innerWidth,
        documentWidth: document.documentElement.scrollWidth,
        bodyWidth: document.body.scrollWidth,
      }));
      noOverflow(themedLayout, `${viewport.name} customized theme`);

      const settings = page.locator('#settings-modal');
      assert.equal(await settings.isVisible(), false, 'settings modal starts hidden');
      await settings.evaluate(el => el.classList.remove('hidden'));
      assert.equal(await settings.isVisible(), true, 'settings modal opens');
      const settingsSurface = await settings.locator('.settings-modal-content').evaluate(el => ({
        radius: parseFloat(getComputedStyle(el).borderTopLeftRadius),
        sidebar: !!el.querySelector('.settings-sidebar'),
      }));
      assert.ok(settingsSurface.radius > 0 && settingsSurface.sidebar, 'settings surface and navigation stay styled');
      await settings.evaluate(el => Promise.all(el.getAnimations({ subtree: true })
        .filter(animation => animation.effect.getTiming().iterations !== Infinity)
        .map(animation => animation.finished.catch(() => {}))));
      const settingsControls = await settings.evaluate(el => ({
        navHeight: el.querySelector('.settings-nav-item').getBoundingClientRect().height,
        closeWidth: el.querySelector('.close-btn, .modal-close').getBoundingClientRect().width,
      }));
      assert.ok(settingsControls.navHeight >= (viewport.name === 'mobile' ? 44 : 32), `settings navigation stays comfortably clickable: ${viewport.name} ${JSON.stringify(settingsControls)}`);
      assert.ok(settingsControls.closeWidth >= (viewport.name === 'mobile' ? 44 : 32), 'window close control has a usable target');
      await settings.screenshot({ path: path.join(screenshotDir, `nx-skin-settings-${viewport.name}.png`) });
      await settings.evaluate(el => el.classList.add('hidden'));
      assert.equal(await settings.isVisible(), false, 'settings modal closes');

      const themeModal = page.locator('#theme-modal');
      assert.equal(await themeModal.isVisible(), false, 'theme editor starts hidden');
      await themeModal.evaluate(el => el.classList.remove('hidden'));
      assert.equal(await themeModal.isVisible(), true, 'theme editor opens');
      await themeModal.screenshot({ path: path.join(screenshotDir, `nx-skin-theme-modal-${viewport.name}.png`) });
      await themeModal.evaluate(el => el.classList.add('hidden'));
      assert.equal(await themeModal.isVisible(), false, 'theme editor closes');

      if (viewport.name === 'desktop') {
        await page.screenshot({ path: path.join(screenshotDir, 'nx-skin-custom.png'), fullPage: true });
      } else {
        await page.screenshot({ path: path.join(screenshotDir, 'nx-skin-mobile.png'), fullPage: true });
      }
      await page.locator('#message').focus();
      const composerField = await page.locator('#message').evaluate(el => ({
        appearance: getComputedStyle(el).appearance,
        background: getComputedStyle(el).backgroundColor,
        outline: getComputedStyle(el).outlineStyle,
        border: getComputedStyle(el.closest('.chat-input-bar')).borderColor,
      }));
      assert.equal(composerField.appearance, 'none', 'composer avoids native filled control styling');
      assert.equal(composerField.background, 'rgba(0, 0, 0, 0)', 'typing area stays transparent on focus');
      assert.equal(composerField.outline, 'none', 'composer uses its outer border for focus');
      assert.notEqual(composerField.border, 'rgba(0, 0, 0, 0)', 'outer focus indicator remains visible');
      // Exercise the actual effect module, including lifecycle under rapid changes.
      await page.evaluate(() => {
        window.nxTheme.applyBgPattern('none');
        const request = window.requestAnimationFrame.bind(window);
        const cancel = window.cancelAnimationFrame.bind(window);
        window.effectFrames = new Set();
        window.requestAnimationFrame = callback => {
          const id = request(now => { window.effectFrames.delete(id); callback(now); });
          if (callback.name === 'draw') window.effectFrames.add(id);
          return id;
        };
        window.cancelAnimationFrame = id => { window.effectFrames.delete(id); cancel(id); };
      });
      for (const pattern of ['snow', 'fireflies', 'orbits']) {
        assert.equal(await page.locator(`#theme-bg-pattern-select option[value="${pattern}"]`).count(), 1);
        await page.evaluate(pattern => {
          window.nxTheme.applyBgEffectSize(1);
          window.nxTheme.applyBgEffectColor('#ab89ef');
          window.nxTheme.applyBgEffectIntensity(0.65);
          window.nxTheme.applyBgPattern(pattern);
          window.nxTheme.applyBgPattern(pattern);
        }, pattern);
        const canvas = page.locator(`#${pattern}-canvas`);
        assert.equal(await canvas.count(), 1);
        assert.equal(await canvas.getAttribute('aria-hidden'), 'true');
        assert.equal(await canvas.evaluate(c => getComputedStyle(c).pointerEvents), 'none');
        assert.equal(await canvas.evaluate(c => getComputedStyle(c).opacity), '0.65');
        assert.equal(await page.evaluate(() => window.effectFrames.size), 1, 'one active effect loop after repeated selection: '+pattern);
        const before = await canvas.evaluate(c => c.toDataURL());
        await page.waitForTimeout(100);
        assert.ok(await canvas.evaluate(c => c.toDataURL()) !== before, 'effect moves');
        await page.screenshot({ path: path.join(screenshotDir, `nx-effect-${pattern}-${viewport.name}.png`) });
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await page.waitForTimeout(40);
        assert.equal(await page.evaluate(() => window.effectFrames.size), 0, 'reduced motion stops animation');
        const still = await canvas.evaluate(c => c.toDataURL());
        await page.waitForTimeout(60);
        assert.ok(await canvas.evaluate(c => c.toDataURL()) === still, 'reduced motion leaves a still background');
        await page.evaluate(() => window.nxTheme.applyBgEffectSize(2));
        assert.ok(await canvas.evaluate(c => c.toDataURL()) !== still, 'size control updates still background');
        await page.evaluate(() => window.nxTheme.applyBgEffectColor('#ff9999'));
        const resized = await canvas.evaluate(c => c.toDataURL());
        await page.evaluate(() => window.nxTheme.applyBgEffectColor('#55ff99'));
        assert.ok(await canvas.evaluate(c => c.toDataURL()) !== resized, 'colour control updates still background');
        await page.emulateMedia({ reducedMotion: 'no-preference' });
        await page.evaluate(() => {
          Object.defineProperty(document, 'hidden', { configurable: true, value: true });
          document.dispatchEvent(new Event('visibilitychange'));
        });
        assert.equal(await page.evaluate(() => window.effectFrames.size), 0, 'hidden tab stops animation');
        await page.evaluate(() => {
          delete document.hidden;
          document.dispatchEvent(new Event('visibilitychange'));
        });
        assert.equal(await page.evaluate(() => window.effectFrames.size), 1, 'visible tab resumes once');
        await page.evaluate(() => window.nxTheme.applyBgPattern('none'));
        assert.equal(await canvas.count(), 0, 'switching to Solid removes canvas');
        assert.equal(await page.evaluate(() => window.effectFrames.size), 0, 'switching cancels animation');
      }
      await page.evaluate(() => {
        window.nxTheme.applyBgPattern('rain');
        window.nxTheme.applyBgPattern('rain');
      });
      await page.waitForTimeout(50);
      assert.equal(await page.evaluate(() => window.effectFrames.size), 1, 'existing effect does not retain a detached animation loop');
      await page.evaluate(() => window.nxTheme.applyBgPattern('none'));
      await page.waitForTimeout(50);
      assert.equal(await page.evaluate(() => window.effectFrames.size), 0, 'existing effect stops after removal');
      assert.deepEqual(pageErrors, [], `browser runtime errors: ${pageErrors.join('\n')}`);
      await page.close();
    }
    console.log('PASS: NX workspace skin preserves themes, customization, hidden settings, and desktop/mobile layout');
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
