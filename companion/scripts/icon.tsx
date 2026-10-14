// Renders the pet into build/icon.icns. Usage: npm run icon (needs Google Chrome for the raster step).
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { chromium } from 'playwright';
import { Pet } from '../src/Pet.tsx';

const root = process.cwd();
const tokens = readFileSync(join(root, 'src', 'styles.css'), 'utf8').match(/:root \{[^}]*\}/)![0];
const pet = renderToStaticMarkup(<Pet mood="idle" count={0} handing={false} />).replace(/width="120" height="120"/, 'width="760" height="760"');
const html = `<style>${tokens} body { margin: 0; }
.tile { width: 824px; height: 824px; margin: 100px; border-radius: 185px; display: grid; place-items: center;
  background: linear-gradient(160deg, #7aa7c7 0%, #a9c3a3 55%, #d9c79a 100%); box-shadow: inset 0 0 0 2px rgba(0,0,0,.08); }
.tile svg { margin-top: 40px; } .shadow { fill: rgba(0,0,0,.16); }</style><div class="tile">${pet}</div>`;

const build = join(root, 'build'), set = join(build, 'icon.iconset');
rmSync(set, { recursive: true, force: true });
mkdirSync(set, { recursive: true });
writeFileSync(join(build, 'icon.html'), html);
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } });
await page.goto('file://' + join(build, 'icon.html'));
await page.screenshot({ path: join(build, 'icon.png'), omitBackground: true });
await browser.close();
for (const s of [16, 32, 128, 256, 512]) {
  execFileSync('sips', ['-z', `${s}`, `${s}`, join(build, 'icon.png'), '--out', join(set, `icon_${s}x${s}.png`)], { stdio: 'ignore' });
  execFileSync('sips', ['-z', `${s * 2}`, `${s * 2}`, join(build, 'icon.png'), '--out', join(set, `icon_${s}x${s}@2x.png`)], { stdio: 'ignore' });
}
execFileSync('iconutil', ['-c', 'icns', set, '-o', join(build, 'icon.icns')]);
rmSync(set, { recursive: true });
rmSync(join(build, 'icon.html'));
console.log('build/icon.icns');
