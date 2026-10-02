const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('@playwright/test');
(async () => {
  fs.mkdirSync('artifacts', { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  await context.route('**/googletagmanager.com/**', route => route.fulfill({ status: 200, body: '' }));
  await context.route('**/google-analytics.com/**', route => route.fulfill({ status: 204, body: '' }));
  const page = await context.newPage();
  const errors = [], checks = [];
  page.on('pageerror', error => errors.push(error.message));
  const base = 'http://127.0.0.1:4173';
  async function check(name, fn) { await fn(); checks.push(name); console.log('PASS', name); }
  async function fullImageFits() {
    const frame = await page.locator('#explorer-canvas').boundingBox();
    const image = await page.locator('#explorer-image').boundingBox();
    assert.ok(image.x >= frame.x - 1 && image.y >= frame.y - 1, 'Image top/left must not be cropped');
    assert.ok(image.x + image.width <= frame.x + frame.width + 1 && image.y + image.height <= frame.y + frame.height + 1, 'Image bottom/right must not be cropped');
  }
  await page.goto(base, { waitUntil: 'networkidle' });
  await check('The opening contains the only demo; Settings and the old lower controls are removed', async () => {
    assert.equal(await page.locator('[data-explorer]').count(), 1);
    assert.equal(await page.locator('.arena-hero #app-panel').count(), 1);
    assert.equal(await page.locator('#settings-tab, #settings-panel, #save-preset, #share-preset, .explorer-scenes, .explorer-viewbar, .product-hero-scene').count(), 0);
    for (const sport of ['Basketball', 'Football', 'Baseball', 'Hockey']) {
      const row = page.locator('.sport-list details').filter({ has: page.locator('strong', { hasText: sport }) });
      assert.equal(await row.locator('.availability').textContent(), 'SUPPORTED');
    }
    assert.equal(await page.locator('.sport-list details').last().locator('.availability').textContent(), 'PLANNED');
    assert.equal(await page.locator('.arena-selector').count(), 0);
    assert.equal(await page.locator('.value-band > li').count(), 4);
    assert.equal(await page.locator('.sport-feature img').getAttribute('src'), 'assets/newAssets/collage.webp');
    assert.equal(await page.locator('#opening-video').getAttribute('aria-hidden'), 'true');
  });
  await check('The panel sport buttons and both panel menus map all eight players to the original images and values', async () => {
    const samples = [
      ['basketball', 'devon', 'Devon Kier', 'Silverdale Phantoms', 'basketball1.webp', 'Points', '24.5', '+135'],
      ['basketball', 'kenji', 'Kenji Blake', 'Crown Heights Titans', 'basketball2.webp', 'Points', '26.5', '+140'],
      ['football', 'darius', 'Darius Knox', 'Harbor Point Outlaws', 'football1.webp', 'Rushing yards', '86.5', '+155'],
      ['football', 'isaiah', 'Isaiah Rowe', 'River State Thunder', 'football2.webp', 'Passing yards', '276.5', '+160'],
      ['baseball', 'malik', 'Malik Dorsey', 'Bayfront Admirals', 'baseball1.webp', 'Home runs', '0.5', '+230'],
      ['baseball', 'marcus', 'Marcus Hale', 'Golden Arrows', 'baseball2.webp', 'Home runs', '0.5', '+235'],
      ['hockey', 'marcus_hockey', 'Marcus Hale', 'Ironvale Phantoms', 'hockey1.webp', 'Shots on goal', '4.5', '+145'],
      ['hockey', 'luka', 'Luka Vasilev', 'Frost Guard', 'hockey2.webp', 'Shots on goal', '3.5', '+205']
    ];
    for (const [index, [sport, id, name, team, file, metric, line, odds]] of samples.entries()) {
      await page.locator(`.app-sports button[data-sport="${sport}"]`).click();
      await page.locator('#panel-player').selectOption(id);
      await page.locator('#explorer-image').evaluate(img => img.decode());
      assert.equal(await page.locator('#panel-player option').count(), 2);
      assert.equal(await page.locator('#scene-player').textContent(), name);
      assert.equal(await page.locator('#panel-team').textContent(), team);
      assert.equal(await page.locator('#panel-game').inputValue(), id);
      assert.equal(await page.locator('#explorer-image').getAttribute('src'), `assets/newAssets/${file}`);
      assert.equal(await page.locator('#badge-metric').textContent(), metric);
      assert.equal(await page.locator('#badge-line').textContent(), `O/U ${line}`);
      assert.equal(await page.locator('#badge-odds').textContent(), odds);
      assert.equal(await page.locator(`button[data-sport="${sport}"][aria-pressed=true]`).count(), 1);
      await fullImageFits();
      await page.locator('#panel-game').selectOption({ index: index % 2 ? 0 : 1 });
      assert.equal(await page.locator('#panel-game').inputValue(), await page.locator('#panel-player').inputValue());
      assert.notEqual(await page.locator('#scene-player').textContent(), name);
      await page.locator('#panel-game').selectOption(id);
      assert.equal(await page.locator('#scene-player').textContent(), name);
    }
  });
  await check('Focus controls zoom only the original image and stay synchronized', async () => {
    const src = await page.locator('#explorer-image').getAttribute('src');
    const before = await page.locator('#explorer-image').getAttribute('style');
    await page.locator('#focus-badge').click();
    assert.equal(await page.locator('#explorer-image').getAttribute('src'), src);
    assert.notEqual(await page.locator('#explorer-image').getAttribute('style'), before);
    for (const id of ['explorer-canvas', 'panel-inspect', 'focus-badge']) assert.equal(await page.locator('#' + id).getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('#focus-label').textContent(), 'Back to game');
    await page.locator('#panel-inspect').click();
    await fullImageFits();
  });
  await check('Keyboard controls select players and focus badges without motion when requested', async () => {
    await page.locator('.app-sports button[data-sport=basketball]').click();
    await page.locator('#explorer-canvas').focus();
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.locator('#panel-player').inputValue(), 'kenji');
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('[data-explorer]').getAttribute('data-detail'), 'badge');
    assert.equal(await page.locator('#explorer-image').evaluate(img => getComputedStyle(img).transitionDuration), '0s');
    assert.equal(await page.locator('#arena-window').evaluate(el => getComputedStyle(el).transform), 'none');
    await page.keyboard.press('Enter');
    await fullImageFits();
  });
  await check('Minimize and the hero panel action preserve selection and restore keyboard focus', async () => {
    await page.locator('#panel-collapse').click();
    assert.equal(await page.locator('#panel-content').isVisible(), false);
    await page.locator('#open-panel').click();
    assert.equal(await page.locator('#panel-content').isVisible(), true);
    assert.equal(await page.locator('#panel-player').inputValue(), 'kenji');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.sport), 'basketball');
  });
  await check('Quick tour closes, completes and restores focus', async () => {
    await page.locator('#guide-start').click();
    await page.locator('#guide-next').click(); await page.locator('#guide-next').click();
    assert.match(await page.locator('#guide-title').textContent(), /connection/);
    await page.locator('#guide-next').click();
    assert.equal(await page.locator('#walkthrough').isVisible(), false);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'explorer-canvas');
    await page.locator('#guide-start').click(); await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'guide-start');
  });
  await check('Desktop and mobile retain the complete artwork without horizontal overflow', async () => {
    for (const width of [320, 390, 768, 1024, 1440, 1920]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const player of ['devon', 'kenji']) {
        await page.locator('#panel-player').selectOption(player);
        await page.locator('#explorer-canvas').scrollIntoViewIfNeeded();
        await fullImageFits();
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `overflow at ${width}`);
    }
  });
  await check('Mobile panel and scene navigation remain connected and visible', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#open-panel').click();
    await page.locator('.app-sports button[data-sport=baseball]').click();
    await page.locator('#panel-player').selectOption('marcus');
    await page.locator('#panel-show-scene').click();
    assert.equal(await page.evaluate(() => document.activeElement.id), 'explorer-canvas');
    assert.equal(await page.locator('#panel-team').textContent(), 'Golden Arrows');
    const bounds = await page.locator('#explorer-canvas').boundingBox();
    assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= 844);
    await page.locator('.menu-toggle').click();
    assert.equal(await page.locator('#nav-links').isVisible(), true);
    await page.locator('#nav-links a[href="#sports"]').click();
    assert.equal(await page.locator('#nav-links').isVisible(), false);
  });
  await check('Legacy scene links work, malformed links fall back and no preference storage is needed', async () => {
    await page.goto(base + '/?view=2&player=luka&detail=badge&backdrop=slate');
    assert.equal(await page.locator('#panel-player').inputValue(), 'luka');
    assert.equal(await page.locator('#focus-badge').getAttribute('aria-pressed'), 'true');
    await page.goto(base + '/?view=2&player=__proto__&detail=invalid');
    assert.equal(await page.locator('#panel-player').inputValue(), 'devon');
    assert.equal(await page.locator('[data-explorer]').getAttribute('data-detail'), 'scene');
    const restricted = await browser.newContext();
    await restricted.route('**/googletagmanager.com/**', route => route.fulfill({ status: 200, body: '' }));
    await restricted.addInitScript(() => Object.defineProperty(window, 'localStorage', { get() { throw new Error('Blocked'); } }));
    const p = await restricted.newPage(); await p.goto(base);
    await p.locator('.app-sports button[data-sport=hockey]').click();
    assert.equal(await p.locator('#panel-player').inputValue(), 'marcus_hockey');
    await restricted.close();
  });
  await check('Pointer depth responds to movement and stops under reduced motion', async () => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.locator('#arena-window').scrollIntoViewIfNeeded();
    const bounds = await page.locator('#arena-window').boundingBox();
    await page.mouse.move(bounds.x + 50, bounds.y + 70);
    await page.waitForFunction(() => document.querySelector('#arena-window').style.getPropertyValue('--turn-x') !== '');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await page.locator('#arena-window').evaluate(el => getComputedStyle(el).transform), 'none');
  });

  await check('Early-access forms preserve failed requests and acknowledge accepted requests', async () => {
    await page.locator('#access-platform').selectOption('macOS');
    assert.equal(await page.locator('#platform-note').isVisible(), true);
    await page.locator('#access-sport').selectOption('Football');
    await page.locator('#access-form button[type=submit]').click();
    assert.equal(await page.locator('#access-email').evaluate(e => e.validity.valueMissing), true);
    await page.locator('#access-email').fill('test@example.com');
    await page.route('https://formspree.io/f/mpqorvvk', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }));
    await page.locator('#access-form button[type=submit]').click();
    await page.locator('.form-status[data-state=error]').waitFor();
    assert.equal(await page.locator('#access-email').inputValue(), 'test@example.com');
    await page.unroute('https://formspree.io/f/mpqorvvk');
    let body;
    await page.route('https://formspree.io/f/mpqorvvk', route => { body = route.request().postData(); return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }); });
    await page.locator('#access-form button[type=submit]').click();
    await page.locator('.form-status[data-state=success]').waitFor();
    assert.match(body, /Football/); assert.match(body, /early_access/);
    assert.equal(await page.locator('#access-email').inputValue(), '');
    await page.unroute('https://formspree.io/f/mpqorvvk');
  });
  await check('Partnership flow handles network failure and acceptance', async () => {
    await page.goto(base + '/partners.html');
    assert.equal(await page.locator('#partner-message').inputValue(), '');
    await page.locator('#partner-email').fill('partner@example.com');
    await page.locator('#partner-message').fill('This is a browser test intercepted locally.');
    await page.route('https://formspree.io/f/mpqorvvk', route => route.abort('failed'));
    await page.locator('button[type=submit]').click();
    await page.locator('.form-status[data-state=error]').waitFor();
    assert.equal(await page.locator('#partner-email').inputValue(), 'partner@example.com');
    await page.unroute('https://formspree.io/f/mpqorvvk');
    await page.route('https://formspree.io/f/mpqorvvk', route => route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }));
    await page.locator('button[type=submit]').click();
    await page.locator('.form-status[data-state=success]').waitFor();
    await page.unroute('https://formspree.io/f/mpqorvvk');
  });
  await check('Local links, assets and supporting pages remain usable', async () => {
    await page.goto(base);
    for (const href of await page.locator('a[href]').evaluateAll(items => [...new Set(items.map(a => a.getAttribute('href')))])) {
      if (href.startsWith('#')) assert.ok(await page.locator(href).count(), href);
      else if (!href.includes(':')) assert.ok((await context.request.get(base + '/' + href)).ok(), href);
    }
    await page.setViewportSize({ width: 320, height: 800 });
    for (const file of ['partners.html', 'privacy.html', 'terms.html', '404.html']) {
      await page.goto(base + '/' + file);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, file);
    }
    const noJS = await browser.newContext({ javaScriptEnabled: false });
    const plain = await noJS.newPage(); await plain.goto(base);
    assert.equal(await plain.locator('noscript').isVisible(), true);
    assert.equal(await plain.locator('#access-form').getAttribute('action'), 'https://formspree.io/f/mpqorvvk');
    await noJS.close();
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(base, { waitUntil: 'networkidle' });
  const cleanCapture = { animations: 'disabled', style: '.site-header, .skip-link { visibility: hidden !important; }' };
  await page.screenshot({ path: 'artifacts/opening-desktop.png' });
  await page.locator('.arena-hero').screenshot({ ...cleanCapture, path: 'artifacts/opening-full.png' });
  await page.locator('#app-panel').screenshot({ ...cleanCapture, path: 'artifacts/game-info-panel.png' });
  await page.locator('.app-sports button[data-sport=football]').click();
  await page.locator('#explorer-image').evaluate(img => img.decode());
  await page.locator('.arena-hero').screenshot({ ...cleanCapture, path: 'artifacts/opening-football.png' });
  await page.locator('.app-sports button[data-sport=hockey]').click();
  await page.locator('#panel-player').selectOption('luka');
  await page.locator('#focus-badge').click();
  await page.locator('#explorer-image').evaluate(img => img.decode());
  await page.locator('.arena-deck').screenshot({ ...cleanCapture, path: 'artifacts/opening-badge.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.app-sports button[data-sport=basketball]').click();
  await page.locator('#explorer-image').evaluate(img => img.decode());
  await page.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }));
  await page.screenshot({ path: 'artifacts/opening-mobile.png' });
  await page.locator('.arena-hero').screenshot({ ...cleanCapture, path: 'artifacts/opening-mobile-full.png' });
  await page.screenshot({ path: 'artifacts/site-mobile.png', fullPage: true });
  await check('No uncaught browser errors', async () => assert.deepEqual(errors, []));
  fs.writeFileSync('artifacts/verification.json', JSON.stringify({ passed: checks, uncaughtErrors: errors, formTests: 'Locally intercepted responses. No real submissions.' }, null, 2));
  await browser.close();
  console.log(`${checks.length} checks passed.`);
})().catch(error => { console.error(error); process.exit(1); });
