// Writes orch-state.json for orch companion every 3 s. Long-running; launchd/orch.state.plist keeps it up.
// Usage: npm run state [-- --once]   ORCH_STATE_FILE overrides the target (default ~/agent-bus/orch-state.json).
import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildState, feedReader, parseDecision, parseSnapshot } from './state.ts';

const root = process.env.ORCH_DIR ?? join(import.meta.dirname, '..');
const out = process.env.ORCH_STATE_FILE ?? join(homedir(), 'agent-bus', 'orch-state.json');
// Syncthing never syncs files named .syncthing.*.tmp, so the half-written file stays local.
const tmp = join(dirname(out), `.syncthing.${out.split('/').at(-1)}.tmp`);

const read = (f: string, fallback = '') => { try { return readFileSync(join(root, f), 'utf8'); } catch { return fallback; } };

// A feed file from offset on, cut after the last newline: a half-written line (or a split UTF-8 character)
// waits for the next tick, and the decoded text's byte length is exactly how far the offset moves.
const readFrom = (name: string, offset: number) => {
  let fd: number;
  try { fd = openSync(join(root, 'feed', `${name}.jsonl`), 'r'); } catch { return ''; }
  try {
    const chunks: Buffer[] = [];
    const buf = Buffer.alloc(1 << 16);
    for (let pos = offset, n; (n = readSync(fd, buf, 0, buf.length, pos)) > 0; pos += n) chunks.push(Buffer.from(buf.subarray(0, n)));
    const all = Buffer.concat(chunks);
    return all.subarray(0, all.lastIndexOf(10) + 1).toString('utf8');
  } finally { closeSync(fd); }
};
const feed = feedReader(readFrom);
const day = (ms: number) => new Date(ms).toLocaleDateString('sv-SE');

function tick() {
  const now = Date.now();
  let text = '';
  try { text = execFileSync('herdr', ['api', 'snapshot'], { encoding: 'utf8', timeout: 2000 }); } catch {}
  const snap = parseSnapshot(text);
  if (!snap) return null;
  const dir = join(root, 'decisions');
  const decisions = existsSync(dir)
    ? readdirSync(dir).filter(f => /^D-\d+\.md$/.test(f)).map(f => parseDecision(f.slice(0, -3), read(`decisions/${f}`)))
    : [];
  const state = buildState({ snap, feed: feed([day(now - 864e5), day(now)]), workers: JSON.parse(read('workers.json', '[]')), decisions, log: read('log.md'), now });
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(tmp, JSON.stringify(state, null, 1) + '\n');
  renameSync(tmp, out);
  return state;
}

if (process.argv.includes('--once')) process.stdout.write(JSON.stringify(tick() ?? 'herdr snapshot failed, nothing written', null, 2) + '\n');
else {
  const safe = () => { try { tick(); } catch (e) { console.error(new Date().toISOString(), e); } };
  safe();
  setInterval(safe, 3000);
}
