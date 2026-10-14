// Drives the real Electron app through every scene by writing fixture state files, and screenshots each.
// Usage: npm run build && npm run shoot   (PNGs land in shots/)
import { _electron } from 'playwright';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { scenes } from '../src/demo.ts';

const dir = join(import.meta.dirname, '..', 'shots');
mkdirSync(dir, { recursive: true });
const stateFile = join(dir, 'orch-state.json');
const write = (id: string) => {
  writeFileSync(stateFile + '.tmp', JSON.stringify(scenes.find(s => s.id === id)!.state(Date.now())));
  renameSync(stateFile + '.tmp', stateFile);
};
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

write('working');
const app = await _electron.launch({
  executablePath: createRequire(import.meta.url)('electron') as unknown as string,
  args: [join(import.meta.dirname, '..')],
  env: { ...process.env, ORCH_STATE_FILE: stateFile },
});
const page = await app.firstWindow();
await page.waitForSelector('.pet');
const shot = async (name: string) => { await page.screenshot({ path: join(dir, `${name}.png`), omitBackground: true }); console.log(name); };

for (const id of ['idle', 'thinking', 'working', 'waiting', 'blocked', 'asleep']) {
  write(id);
  await wait(2000);
  await shot(id);
}

write('working'); await wait(2500);
const frames = async (name: string, at: number[]) => {
  let t = 0;
  for (const [i, ms] of at.entries()) { await wait(ms - t); t = ms; await shot(`${name}-${i + 1}`); }
};
write('handover'); await frames('handover', [250, 500, 800, 1800]);
write('cheer'); await frames('cheer', [150, 420, 2600]);
write('walkoff'); await frames('walkoff', [300, 800, 1300, 2200]);

write('waiting'); await wait(1500);
await page.hover('.slot:nth-of-type(2)'); await wait(200); await shot('tooltip');
await page.mouse.move(5, 5);
await page.click('.pet-hit'); await wait(400); await shot('panel');
await page.click('.pet-hit'); await wait(200);

await page.emulateMedia({ reducedMotion: 'reduce' });
write('working'); await wait(500); await shot('reduced-motion-working');

const interactive = await app.evaluate(({ BrowserWindow }) => {
  const w = BrowserWindow.getAllWindows()[0];
  return { alwaysOnTop: w.isAlwaysOnTop(), bounds: w.getBounds() };
});
console.log(JSON.stringify(interactive));
await app.close();
