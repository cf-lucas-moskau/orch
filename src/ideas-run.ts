// The idea bridge daemon: moves Discord (or mock) messages into ideas/ and the feed. orch does all the thinking.
// Usage: node --experimental-strip-types src/ideas-run.ts [--once]   --once handles the mock inbox once and exits.
// launchd/orch.ideas.plist keeps it up; docs/ideas.md has the setup.
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { chatFor, MockChat } from './discord.ts';
import { handle, isOff, loadConfig, migrateAll, reconcile, settled, tick } from './ideas-io.ts';
import { serial } from './ideas.ts';
import { channelId, teamMessage } from './team-io.ts';

const root = process.env.ORCH_DIR ?? join(import.meta.dirname, '..');
const log = (msg: string) => appendFileSync(join(root, 'log.md'), `- ${new Date().toLocaleString('sv-SE').slice(0, 16)} ${msg}\n`);
const config = loadConfig(root);
const chat = chatFor(root, config, msg => log(`idea bridge: ${msg}`));
const deps = { root, log, run: () => { throw new Error('the bridge never dispatches'); }, chat };
// team-general's top-level posts go to their own handler; without the channel the idea bridge runs on alone.
let team: { id: string; me: string } | undefined;
try { team = { id: await channelId(root, chat, 'team'), me: await chat.me() }; chat.watch(team.id); }
catch (e) { log(`idea bridge: team-general not watched: ${e instanceof Error ? e.message : e}`); }
chat.onMessage(serial(async m => team && m.channel === team.id && !m.thread ? teamMessage(deps, m, team.me) : handle(deps, m)));
migrateAll(root, log);
await reconcile(deps);

if (process.argv.includes('--once')) {
  if (!(chat instanceof MockChat)) throw new Error('--once is for the mock adapter');
  await chat.poll();
  await settled();
} else {
  await chat.start();
  console.log(`${new Date().toISOString()} idea bridge up, adapter ${config.adapter}, channel ${config.channel}`);
  // Progress notes, stage pulses and question timeouts; off while the kill switch is on.
  // One tick at a time: a slow one makes the next wait instead of running beside it.
  const tickOnce = serial(() => tick(deps));
  setInterval(() => { if (!isOff(root)) tickOnce().catch(e => log(`idea bridge: tick failed: ${e instanceof Error ? e.message : e}`)); }, 60_000);
  // Images still downloading get a few seconds to land before the bridge goes; the rest stay on their idea and are
  // fetched on the next start.
  const down = async () => { await chat.stop(); await Promise.race([settled(), new Promise(r => setTimeout(r, 10_000))]); process.exit(0); };
  process.on('SIGTERM', down);
  process.on('SIGINT', down);
}
