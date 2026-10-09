import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

const directory = dirname(fileURLToPath(import.meta.url));
const browser = await chromium.launch({ headless: true, ...(process.argv[2] ? { executablePath: resolve(process.argv[2]) } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, reducedMotion: 'reduce' });
  for (const style of ['technology', 'education', 'marketing']) {
    await page.goto(`${pathToFileURL(resolve(directory, 'index.html'))}?style=${style}`);
    await page.evaluate(() => document.fonts.ready);
    assert.equal(await page.locator('html').getAttribute('data-style'), style);
    assert.equal(await page.locator('[data-panel].active').count(), 1);
    const invalid = await page.evaluate(() => {
      const stage = document.querySelector('.artwork').getBoundingClientRect();
      const nodes = [...document.querySelectorAll('[data-panel].active .title,[data-panel].active .subtitle,[data-panel].active .presenter-label,[data-panel].active .kicker,[data-panel].active .tag')];
      return nodes.filter(node => {
        const rect = node.getBoundingClientRect();
        return rect.left < stage.left || rect.top < stage.top || rect.right > stage.right + 1 || rect.bottom > stage.bottom + 1 || node.scrollWidth > node.clientWidth + 1;
      }).map(node => node.className);
    });
    assert.deepEqual(invalid, [], `${style}: required text exceeds its layout`);
    const localFonts = await page.evaluate(() => [...document.fonts].filter(font => font.status === 'loaded').map(font => font.family));
    assert.ok(localFonts.includes('Noto Sans SC'), 'The local simplified Chinese fallback must load.');
    assert.ok(localFonts.includes({ technology: 'Noto Sans SC', education: 'Huninn', marketing: 'Smiley Sans' }[style]), `${style}: title font must load`);
    await page.locator('.artwork').screenshot({ path: resolve(directory, `${style}.png`) });
  }
  await page.goto(pathToFileURL(resolve(directory, 'index.html')).href);
  for (const style of ['education', 'marketing', 'technology']) {
    await page.locator(`button[data-style="${style}"]`).click();
    assert.equal(await page.locator(`button[data-style="${style}"]`).getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('[data-panel].active').getAttribute('data-panel'), style);
  }
  console.log('Three design frames generated; required text bounds, local fonts, and style buttons passed.');
} finally {
  await browser.close();
}
