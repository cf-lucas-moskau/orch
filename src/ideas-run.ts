// The idea bridge daemon: moves Discord (or mock) messages into ideas/ and the feed. orch does all the thinking.
// Usage: node --experimental-strip-types src/ideas-run.ts [--once]   --once handles the mock inbox once and exits.
// launchd/orch.ideas.plist keeps it up; docs/ideas.md has the setup.
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { chatFor, MockChat } from './discord.ts';
import { handle, loadConfig, serial } from './ideas-io.ts';

const root = process.env.ORCH_DIR ?? join(import.meta.dirname, '..');
const log = (msg: string) => appendFileSync(join(root, 'log.md'), `- ${new Date().toLocaleString('sv-SE').slice(0, 16)} ${msg}\n`);
const config = loadConfig(root);
const chat = chatFor(root, config, msg => log(`idea bridge: ${msg}`));
chat.onMessage(serial(m => handle({ root, log, run: () => { throw new Error('the bridge never dispatches'); }, chat }, m)));

if (process.argv.includes('--once')) {
  if (!(chat instanceof MockChat)) throw new Error('--once is for the mock adapter');
  await chat.poll();
} else {
  await chat.start();
  console.log(`${new Date().toISOString()} idea bridge up, adapter ${config.adapter}, channel ${config.channel}`);
  const down = async () => { await chat.stop(); process.exit(0); };
  process.on('SIGTERM', down);
  process.on('SIGINT', down);
}
