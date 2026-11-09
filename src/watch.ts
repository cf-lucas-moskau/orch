// Tails today's feed and prints one line per event that might need the user. Run under Monitor.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { FeedEvent } from './board.ts';
import { classify } from './triage.ts';
import { loadConfig, loadIdeas } from './ideas-io.ts';
import { bridgeShouldStart, pendingLines } from './ideas.ts';

const root = process.env.ORCH_DIR ?? join(import.meta.dirname, '..');
const self = process.env.ORCH_SID ?? '';
const day = () => new Date().toLocaleDateString('sv-SE');

const json = (f: string, fallback: any) => { try { return JSON.parse(readFileSync(join(root, f), 'utf8')); } catch { return fallback; } };
// Workers orch dispatched are tagged so a DONE line triggers their gates check.
const names = (): Record<string, { name: string; pane: string }> => {
  const out = json('sessions.json', {});
  for (const w of json('workers.json', [])) if (w.status === 'running' && w.sid) out[w.sid] = { name: `worker ${w.name}`, pane: w.pane };
  return out;
};

function follow(d: string) {
  const file = join(root, 'feed', `${d}.jsonl`);
  if (!existsSync(file)) writeFileSync(file, '', { flag: 'a' });
  const tail = spawn('tail', ['-n0', '-F', file]);
  createInterface({ input: tail.stdout }).on('line', line => {
    let e: FeedEvent; try { e = JSON.parse(line); } catch { return; }
    if (!e.sid || e.sid === self) return;
    // The idea bridge writes its watcher lines ready-made: IDEA <id> <kind> <author>: <text>, TEAM <kind> <author>: <text>.
    if (e.event === 'Idea' || e.event === 'Team') return console.log(e.msg);
    const kind = classify(e);
    if (kind === 'skip') return;
    // Codex panes have no session id in herdr, so a worker is also found by its worktree.
    const w = json('workers.json', []).find((x: any) => x.status === 'running' && x.worktree === e.cwd);
    const s = names()[e.sid] ?? (w ? { name: `worker ${w.name}`, pane: w.pane } : { name: e.sid.slice(0, 8), pane: '?' });
    const text = (kind === 'done' ? e.msg.slice(0, 160) : (e.tail || e.msg).slice(-200)).replace(/\s+/g, ' ');
    // Workers' helper subagents end with an empty DONE from a session orch doesn't know; nothing to act on.
    if (kind === 'done' && !text.trim() && s.pane === '?') return;
    console.log(`${kind.toUpperCase()} ${s.name} [${s.pane}] ${e.sid.slice(0, 8)}: ${text}`);
  });
  // Switch files at midnight; if tail dies for any other reason, follow again so the watcher never goes deaf.
  let switching = false;
  const t = setInterval(() => { if (day() !== d) { switching = true; clearInterval(t); tail.kill(); follow(day()); } }, 60_000);
  tail.on('exit', () => { if (!switching) { clearInterval(t); setTimeout(() => follow(day()), 1000); } });
}

// Ideas still waiting on orch, so nothing posted while orch was down is missed.
try { for (const l of pendingLines(loadIdeas(root))) console.log(l); }
catch (e) { console.log(`IDEA - error: ideas/ could not be read: ${e instanceof Error ? e.message : e}`); }
follow(day());

// Keep board.md and sessions.json fresh so new sessions get names (the plan's 10-minute refresh).
const refresh = () => spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', join(import.meta.dirname, 'cli.ts')], { stdio: 'ignore' })
  .on('error', () => {});
refresh();
setInterval(refresh, 10 * 60_000);

// Workers on one repo that change the same files, reported once per pair (again when files join), so the later one merges the default branch in early.
// One run at a time: a slow fetch must not stack runs that race on overlap.json. A hung one is killed after 5 minutes.
let overlapRunning = false;
function checkOverlap() {
  if (overlapRunning) return;
  overlapRunning = true;
  let out = '', err = '';
  const c = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', join(import.meta.dirname, 'orch.ts'), 'overlap', '--new'],
    { cwd: root, timeout: 5 * 60_000, killSignal: 'SIGKILL' });
  c.stdout.on('data', d => { out += d; });
  c.stderr.on('data', d => { err += d; });
  c.on('close', (code, signal) => {
    overlapRunning = false;
    for (const l of out.split('\n')) if (l.startsWith('OVERLAP ')) console.log(l);
    // A crash prints a stack; its Error: line says what went wrong. orch's own refusals are one line.
    const lines = err.trim().split('\n');
    const why = (lines.find(l => /\w*Error: /.test(l)) ?? lines.at(-1) ?? '').trim().slice(0, 200);
    if (code !== 0) console.log(`OVERLAP error: check ${signal ? `killed (${signal}, over 5 minutes)` : `exited ${code}`}: ${why}`);
  });
  c.on('error', e => { overlapRunning = false; console.log(`OVERLAP error: check did not start: ${e.message}`); });
}
checkOverlap();
setInterval(checkOverlap, 10 * 60_000);

// The idea bridge must always run while it is live: start it when it is down, check every minute.
// Detached, so re-arming the watcher never takes it down; launchd's copy counts as running too.
function ensureBridge() {
  let adapter: 'mock' | 'discord';
  try { adapter = loadConfig(root).adapter; } catch (e) { console.log(`BRIDGE error: ideas/config.json: ${e instanceof Error ? e.message : e}`); return; }
  const running = spawnSync('pgrep', ['-f', 'src/ideas-run.ts'], { encoding: 'utf8' }).stdout.trim() !== '';
  if (!bridgeShouldStart(adapter, existsSync(join(root, 'ideas', 'off')), running)) return;
  // Double fork through sh, so the bridge's parent is launchd and stopping the watcher's process tree leaves it running.
  const log = join(homedir(), 'Library', 'Logs', 'orch.ideas.log');
  const r = spawnSync('/bin/sh', ['-c', `nohup npm run -s ideas >> '${log}' 2>&1 < /dev/null &`], { cwd: root, encoding: 'utf8' });
  console.log(r.status === 0 ? 'BRIDGE started (it was down)' : `BRIDGE error: could not start: ${r.stderr.trim()}`);
}
ensureBridge();
setInterval(ensureBridge, 60_000);

// The decision queue page (src/queue-run.ts) the same way, checked every minute. Its port answering counts as running,
// not a process match: workers run their own copies on other ports. A repeated error is printed once until it changes.
const queuePort = Number(process.env.ORCH_QUEUE_PORT ?? 7390);
const queueUp = () => fetch(`http://127.0.0.1:${queuePort}/api/queue`, { signal: AbortSignal.timeout(20_000) })
  .then(r => r.ok, () => false);
let queueBusy = false, queueError = '';
async function ensureQueue() {
  // ORCH_QUEUE=off: tests and second copies of the watcher must not start a page that outlives them.
  if (queueBusy || process.env.ORCH_QUEUE === 'off') return;
  queueBusy = true;
  try {
    if (await queueUp()) { queueError = ''; return; }
    const log = join(homedir(), 'Library', 'Logs', 'orch.queue.log');
    const script = join(import.meta.dirname, 'queue-run.ts');
    const r = spawnSync('/bin/sh', ['-c', `nohup '${process.execPath}' --experimental-strip-types --no-warnings '${script}' >> '${log}' 2>&1 < /dev/null &`], { cwd: root, encoding: 'utf8' });
    let up = false;
    for (let i = 0; i < 10 && !up && r.status === 0; i++) { await new Promise(res => setTimeout(res, 500)); up = await queueUp(); }
    // A crash ends with node's version banner; its Error: line says what went wrong.
    const tail = () => {
      try { const ls = readFileSync(log, 'utf8').trim().split('\n').slice(-30); return (ls.findLast(l => /\w*Error: /.test(l)) ?? ls.at(-1) ?? '').trim().slice(0, 200); }
      catch { return ''; }
    };
    const msg = up ? '' : r.status !== 0 ? `could not start: ${r.stderr.trim()}` : `did not come up on port ${queuePort}: ${tail()}`;
    // The page prints a one-time tailnet login link on start; orch relays it to the user's phone.
    const login = () => { try { return [...readFileSync(log, 'utf8').matchAll(/^queue login link \(one use\): (\S+)$/gm)].at(-1)?.[1] ?? ''; } catch { return ''; } };
    if (up) console.log(`QUEUE started on http://127.0.0.1:${queuePort} (it was down)${login() ? `; tailnet login link (one use): ${login()}` : ''}`);
    else if (msg !== queueError) console.log(`QUEUE error: ${msg}`);
    queueError = msg;
  } finally { queueBusy = false; }
}
void ensureQueue();
setInterval(() => void ensureQueue(), 60_000);
