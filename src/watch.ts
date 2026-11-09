// Tails today's feed and prints one line per event that might need the user. Run under Monitor.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { FeedEvent } from './board.ts';
import { classify, screenTail } from './triage.ts';
import { feedEvent, follow as followWorker, newWatch, type HerdrReply, type Watch } from './herdr-watch.ts';
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
    // Codex panes have no session id in herdr, so a worker is also found by its worktree.
    const w = json('workers.json', []).find((x: any) => x.status === 'running' && x.worktree === e.cwd);
    const s = names()[e.sid] ?? (w ? { name: `worker ${w.name}`, pane: w.pane } : { name: e.sid.slice(0, 8), pane: '?' });
    if (s.name.startsWith('worker ')) {
      const n = s.name.slice('worker '.length);
      const r = feedEvent(watchOf(n), e);
      saveWatch(n, r.w);
      if (!r.print) return;
    }
    const kind = classify(e);
    if (kind === 'skip') return;
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

// herdr's own view of each running worker, for the blocks and finishes the hook feed misses (a hook that failed,
// Codex, whose turn hooks herdr 0.9.5 dropped). watch-seen.json keeps each worker's last handled state across
// re-arms; without it (the first run) the states at start count as handled.
const seenFile = 'watch-seen.json';
const watches = new Map<string, Watch>();
let seeding = !existsSync(join(root, seenFile));
const handled = json(seenFile, {}) as Record<string, string>;
const watchOf = (name: string) => watches.get(name) ?? newWatch(handled[name]);
function saveWatch(name: string, w: Watch) {
  watches.set(name, w);
  if (w.handled === handled[name]) return;
  if (w.handled) handled[name] = w.handled;
  writeFileSync(join(root, seenFile), JSON.stringify(handled, null, 2) + '\n');
}
// Each follower's live herdr processes, killed when its worker stops running or the watcher exits.
const followers = new Map<string, Set<ChildProcess>>();
// Bounded, so a wait the watcher left behind when it died ends on its own; a timeout just starts the next round.
function herdrCall(name: string, args: string[]): Promise<HerdrReply> {
  return new Promise(resolve => {
    const c = spawn('herdr', args);
    const mine = followers.get(name);
    mine?.add(c);
    let out = '';
    c.stdout.on('data', d => { out += d; });
    c.on('error', () => resolve({ error: { code: 'spawn' } }));
    c.on('close', () => { mine?.delete(c); try { resolve(JSON.parse(out)); } catch { resolve({ error: { code: 'unparsed' } }); } });
  });
}
function watchWorker(w: { name: string; pane: string; sid?: string }, seed: boolean) {
  const procs = new Set<ChildProcess>();
  followers.set(w.name, procs);
  followWorker({
    get: () => herdrCall(w.name, ['agent', 'get', w.pane]),
    wait: until => herdrCall(w.name, ['agent', 'wait', w.pane, ...until.flatMap(u => ['--until', u]), '--timeout', String(30 * 60_000)]),
    sleep: ms => new Promise(r => setTimeout(r, ms)),
    later: (ms, f) => { setTimeout(f, ms); },
    watch: () => watchOf(w.name),
    save: x => saveWatch(w.name, x),
    emit: (kind, a) => {
      const screen = spawnSync('herdr', ['agent', 'read', w.pane, '--source', 'visible'], { encoding: 'utf8' }).stdout ?? '';
      console.log(`${kind.toUpperCase()} worker ${w.name} [${w.pane}] ${(w.sid || '-').slice(0, 8)}: (herdr: ${a.agent_status}) ${screenTail(screen)}`);
    },
  }, () => followers.get(w.name) === procs, seed).finally(() => { if (followers.get(w.name) === procs) followers.delete(w.name); });
}
function syncWorkers() {
  const running = json('workers.json', []).filter((w: any) => w.status === 'running' && w.pane);
  for (const w of running) if (!followers.has(w.name)) watchWorker(w, seeding);
  seeding = false;
  for (const [n, procs] of followers) if (!running.some((w: any) => w.name === n)) { followers.delete(n); for (const c of procs) c.kill(); }
}
syncWorkers();
setInterval(syncWorkers, 30_000);
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const)
  process.on(sig, () => { for (const procs of followers.values()) for (const c of procs) c.kill(); process.exit(0); });

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
