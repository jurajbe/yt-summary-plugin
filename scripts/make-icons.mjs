// Renders src/icons/icon.svg to the PNG sizes the manifest needs.
// Usage: node scripts/make-icons.mjs  (needs Playwright + Chromium)
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
import { readFile } from 'node:fs/promises';

const svg = await readFile('src/icons/icon.svg', 'utf8');
const browser = await chromium.launch();
const page = await browser.newPage();
for (const size of [16, 32, 48, 128]) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<style>html,body{margin:0;background:transparent}svg{width:${size}px;height:${size}px;display:block}</style>${svg}`,
  );
  await page.screenshot({ path: `src/icons/icon${size}.png`, omitBackground: true });
}
await browser.close();
console.log('icons written');
