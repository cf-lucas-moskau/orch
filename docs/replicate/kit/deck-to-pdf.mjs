// Renders a present-skill HTML deck (one .slide visible at a time) to a PDF with one 16:9 page per slide.
// Headless, so nothing opens on screen. Uses the installed Google Chrome through playwright-core.
// Install once: npm i --prefix ~/.local/share/deck-to-pdf playwright-core
// Usage: NODE_PATH=~/.local/share/deck-to-pdf/node_modules node deck-to-pdf.mjs deck.html [out.pdf]
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

const [input, output] = process.argv.slice(2);
if (!input) { console.error('usage: node deck-to-pdf.mjs deck.html [out.pdf]'); process.exit(2); }
const out = resolve(output ?? input.replace(/\.html?$/, '') + '.pdf');

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await page.goto(pathToFileURL(resolve(input)).href, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  const slides = await page.locator('.slide').count();
  if (!slides) throw new Error('no .slide elements; is this a present-skill deck?');
  // Stack every slide as its own full page instead of the one-at-a-time view.
  await page.addStyleTag({ content: `
    html, body, #deck { overflow: visible !important; height: auto !important; }
    .slide { position: relative !important; inset: auto !important; opacity: 1 !important;
             width: 1920px !important; height: 1080px !important; break-after: page; page-break-after: always; }
    .slide:last-of-type { break-after: auto; page-break-after: auto; }
    #counter, #progress, #nav-hint { display: none !important; }` });
  await page.emulateMedia({ media: 'screen' });
  await page.pdf({ path: out, width: '1920px', height: '1080px', printBackground: true, margin: { top: 0, right: 0, bottom: 0, left: 0 } });
  console.log(`${out} (${slides} slides)`);
} finally {
  await browser.close();
}
