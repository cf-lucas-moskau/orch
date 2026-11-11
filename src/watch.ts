// Tails today's feed and prints one line per event that might need the user. Run under Monitor.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { FeedEvent } from './board.ts';
import { classify, screenTail } from './triage.ts';
import { follow as followWorker, herdrFollowed, type Followed, type HerdrReply } from './herdr-watch.ts';
import { loadConfig, loadIdeas } from './ideas-io.ts';
import { bridgeShouldStart, pendingLines } from './ideas.ts';
import { LEADS, leadAgent, leadNotice, leadUp, ownerOf, shows } from './lead.ts';
import { post, prune, read, readBeat } from './lead-inbox.ts';
import { replay as replayStalls, stallLine, step as stepStall, tick as tickStalls, type Stall } from './stall.ts';

const root = process.env.ORCH_DIR ?? join(import.meta.dirname, '..');
const self = process.env.ORCH_SID ?? '';
const day = () => new Date().toLocaleDateString('sv-SE');

const json = (f: string, fallback: any) => { try { return JSON.parse(readFileSync(join(root, f), 'utf8')); } catch { return fallback; } };

// ORCH_LEAD=<name>: this watcher runs for that lead (src/lead.ts) and prints only its lines. Unset: orch's own watcher.
const me = process.env.ORCH_LEAD || undefined;
if (me && !LEADS[me]) { console.log(`LEAD error: ORCH_LEAD=${me} is no lead (${Object.keys(LEADS).join(', ')})`); process.exit(1); }
const leadPath = (name: string, ext: string) => join(root, 'leads', `${name}.${ext}`);
const record = (name: string) => json(`leads/${name}.json`, undefined);
const up = (name: string) => leadUp(readBeat(root, name), record(name), Date.now());
const workerRepo = (name: string) => json('workers.json', []).find((w: any) => w.status === 'running' && w.name === name)?.repo;
// orch's watcher makes every line, a lead's included, and never drops one: a line of a lead that is up goes to that
// lead's inbox, which only its watcher prints. A lead's watcher prints only its own lines.
function say(line: string) {
  const owner = ownerOf(line, workerRepo);
  if (shows(owner, me, up)) return console.log(line);
  if (me) return;
  // An inbox that cannot be written must not lose the line: orch prints it itself.
  try { post(root, owner, line); } catch (e) { inboxError(e); console.log(line); }
}
// Inbox errors never stop a watcher; each different one is said once.
let lastInboxError = '';
function inboxError(e: unknown) {
  const msg = `LEAD error: inbox: ${e instanceof Error ? e.message : e}`;
  if (msg !== lastInboxError) console.log(msg);
  lastInboxError = msg;
}
const safeRead = (name: string, emit: (l: string) => void) => { try { read(root, name, emit); } catch (e) { inboxError(e); } };
// Sessions that are leads: their turns end all day and they escalate through decisions/, so orch skips their DONE lines.
const leadSids = () => new Set(Object.keys(LEADS).flatMap(n => json(`leads/${n}.json`, null)?.sid ?? []));
// Workers orch dispatched are tagged so a DONE line triggers their gates check.
const names = (): Record<string, { name: string; pane: string }> => {
  const out = json('sessions.json', {});
  for (const w of json('workers.json', [])) if (w.status === 'running' && w.sid) out[w.sid] = { name: `worker ${w.name}`, pane: w.pane };
  return out;
};

// Every tail this watcher runs, killed when it exits so no tail outlives it.
const tails = new Set<ChildProcess>();
function tailF(file: string) {
  const t = spawn('tail', ['-n0', '-F', file]);
  tails.add(t);
  t.on('exit', () => tails.delete(t));
  return t;
}

function follow(d: string) {
  const file = join(root, 'feed', `${d}.jsonl`);
  if (!existsSync(file)) writeFileSync(file, '', { flag: 'a' });
  const tail = tailF(file);
  createInterface({ input: tail.stdout }).on('line', line => {
    let e: FeedEvent; try { e = JSON.parse(line); } catch { return; }
    if (!e.sid || e.sid === self) return;
    // The idea bridge writes its watcher lines ready-made: IDEA <id> <kind> <author>: <text>, TEAM <kind> <author>: <text>.
    if (e.event === 'Idea' || e.event === 'Team') return say(e.msg);
    sayStalls(stepStall(stalls, e));
    if (e.cwd && !hooked.has(e.cwd)) { hooked.add(e.cwd); syncFollowers(); }
    const kind = classify(e);
    if (kind === 'skip' || (kind === 'done' && leadSids().has(e.sid))) return;
    // Codex panes have no session id in herdr, so a worker is also found by its worktree.
    const w = json('workers.json', []).find((x: any) => x.status === 'running' && x.worktree === e.cwd);
    const s = names()[e.sid] ?? (w ? { name: `worker ${w.name}`, pane: w.pane } : { name: e.sid.slice(0, 8), pane: '?' });
    const text = (kind === 'done' ? e.msg.slice(0, 160) : (e.tail || e.msg).slice(-200)).replace(/\s+/g, ' ');
    // Workers' helper subagents end with an empty DONE from a session orch doesn't know; nothing to act on.
    if (kind === 'done' && !text.trim() && s.pane === '?') return;
    say(`${kind.toUpperCase()} ${s.name} [${s.pane}] ${e.sid.slice(0, 8)}: ${text}`);
  });
  // Switch files at midnight; if tail dies for any other reason, follow again so the watcher never goes deaf.
  let switching = false;
  const t = setInterval(() => { if (day() !== d) { switching = true; clearInterval(t); tail.kill(); follow(day()); } }, 60_000);
  tail.on('exit', () => { if (!switching) { clearInterval(t); setTimeout(() => follow(day()), 1000); } });
}

// herdr follows the workers that send no hook events (herdrFollowed), one follower per pane. hooked holds every
// folder a hook event came from, today's and yesterday's feed at start, then each new line.
// Stalled workers (src/stall.ts) are rebuilt from the same two days of feed on every arm; only the stalls still current
// after the whole replay are said. stalled.json holds the turns already said, so a re-arm says each stall once; entries
// older than three days are dropped.
const hooked = new Set<string>();
const { stalls, current: startStalls } = (() => {
  const feed: FeedEvent[] = [];
  for (const d of [new Date(Date.now() - 864e5).toLocaleDateString('sv-SE'), day()]) {
    let text = '';
    try { text = readFileSync(join(root, 'feed', `${d}.jsonl`), 'utf8'); } catch {}
    for (const line of text.split('\n')) {
      try { const e = JSON.parse(line); if (e.event !== 'Idea' && e.event !== 'Team') { if (e.sid !== self) feed.push(e); if (e.cwd) hooked.add(e.cwd); } } catch {}
    }
  }
  return replayStalls(feed, Date.now());
})();
// A worker with a known session id matches by it alone; its folder only when it has none (Codex).
const workerOf = (st: Stall) => json('workers.json', []).find((x: any) => x.status === 'running'
  && (x.sid ? x.sid === st.sid : !!x.worktree && (st.cwd === x.worktree || st.cwd.startsWith(x.worktree + '/'))));
function sayStalls(found: Stall[]) {
  for (const st of found) {
    const w = workerOf(st);
    if (!w) continue;
    const said: Record<string, number> = json('stalled.json', {});
    if (said[st.key]) continue;
    const now = Date.now();
    for (const k of Object.keys(said)) if (now - said[k] > 3 * 864e5) delete said[k];
    said[st.key] = now;
    writeFileSync(join(root, 'stalled.json'), JSON.stringify(said, null, 2) + '\n');
    say(stallLine(w.name, w.pane, st));
  }
}
// Each follower's live herdr processes, by pane, killed when its worker is no longer followed or the watcher exits.
const followers = new Map<string, Set<ChildProcess>>();
// Bounded, so a wait the watcher left behind when it died ends on its own; a timeout just starts the next round.
function herdrCall(procs: Set<ChildProcess>, args: string[]): Promise<HerdrReply> {
  return new Promise(resolve => {
    const c = spawn('herdr', args);
    procs.add(c);
    let out = '';
    c.stdout.on('data', d => { out += d; });
    c.on('error', () => resolve({ error: { code: 'spawn' } }));
    c.on('close', () => { procs.delete(c); try { resolve(JSON.parse(out)); } catch { resolve({ error: { code: 'unparsed' } }); } });
  });
}
function followPane(w: Followed, seed: boolean) {
  const procs = new Set<ChildProcess>();
  followers.set(w.pane, procs);
  followWorker({
    get: () => herdrCall(procs, ['agent', 'get', w.pane]),
    wait: until => herdrCall(procs, ['agent', 'wait', w.pane, ...until.flatMap(u => ['--until', u]), '--timeout', String(30 * 60_000)]),
    sleep: ms => new Promise(r => setTimeout(r, ms)),
    emit: (kind, a) => {
      const screen = spawnSync('herdr', ['agent', 'read', w.pane, '--source', 'visible'], { encoding: 'utf8' }).stdout ?? '';
      say(`${kind.toUpperCase()} worker ${w.name} [${w.pane}] -: (herdr: ${a.agent_status}) ${screenTail(screen)}`);
    },
  }, () => followers.get(w.pane) === procs, seed).finally(() => { if (followers.get(w.pane) === procs) followers.delete(w.pane); });
}
// At start the followed panes' states are known already: a watcher re-arm must not report them again.
let seeding = true;
function syncFollowers() {
  const want = herdrFollowed(json('workers.json', []) as Followed[], hooked);
  for (const w of want) if (!followers.has(w.pane)) followPane(w, seeding);
  seeding = false;
  for (const [pane, procs] of followers) if (!want.some(w => w.pane === pane)) { followers.delete(pane); for (const c of procs) c.kill(); }
}
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const)
  process.on(sig, () => { for (const c of [...tails, ...[...followers.values()].flatMap(p => [...p])]) c.kill(); process.exit(0); });

// Ideas still waiting on orch or a lead, replayed on every arm so nothing posted while the watcher was down is missed,
// each by the watcher whose it is.
const pending = (owner?: string) => {
  try { return pendingLines(loadIdeas(root)).filter(l => owner === undefined || ownerOf(l, workerRepo) === owner); }
  catch (e) { return [`IDEA - error: ideas/ could not be read: ${e instanceof Error ? e.message : e}`]; }
};

// A lead's watcher: a heartbeat with its session id every minute and its inbox, read on arm and every second.
// Feed, herdr followers, bridge, queue page, overlap and board stay with orch's watcher alone, so nothing runs twice.
function startLeadSide(name: string) {
  mkdirSync(join(root, 'leads'), { recursive: true });
  try { prune(root, name); } catch (e) { inboxError(e); }
  const touch = () => writeFileSync(leadPath(name, 'beat'), self + '\n');
  touch();
  setInterval(touch, 60_000);
  const replayed = new Set(pending(name));
  for (const l of replayed) console.log(l);
  safeRead(name, l => { if (!replayed.has(l)) console.log(l); });
  setInterval(() => safeRead(name, l => console.log(l)), 1000);
}

// orch's side: says once when a started lead goes down or comes back, and prints what a lead that is not up left in its
// inbox. Taking over, it replays that lead's waiting ideas too, once: an inbox line the replay already showed is skipped.
// A running lead whose record has no session id yet (lead start gave up waiting) gets it from herdr, so its beat can match.
function syncLeadSid(name: string) {
  const rec = record(name);
  if (rec?.status !== 'running' || rec.sid) return;
  const r = spawnSync('herdr', ['agent', 'get', leadAgent(name)], { encoding: 'utf8', timeout: 10_000 });
  let sid = '';
  try { sid = JSON.parse(r.stdout).result?.agent?.agent_session?.value ?? ''; } catch {}
  if (sid) writeFileSync(leadPath(name, 'json'), JSON.stringify({ ...rec, sid }, null, 2) + '\n');
}

function checkLeads(starting = false) {
  for (const lead of Object.values(LEADS)) {
    syncLeadSid(lead.name);
    const marker = leadPath(lead.name, 'down'), was = existsSync(marker), isUp = up(lead.name);
    const n = leadNotice(lead, isUp, json(`leads/${lead.name}.json`, null)?.status === 'running', was);
    if (n.down && !was) writeFileSync(marker, '');
    if (!n.down && was) rmSync(marker, { force: true });
    if (n.line) console.log(n.line);
    if (isUp) continue;
    // Starting, the watcher has just replayed every idea it owns, this lead's included.
    const replay = !!n.line && !starting;
    const shown = new Set(replay || starting ? pending(lead.name) : []);
    if (replay) for (const l of shown) console.log(l);
    safeRead(lead.name, l => { if (!shown.has(l)) console.log(l); });
  }
}

function startOrchSide() {
  for (const l of pending()) { const o = ownerOf(l, workerRepo); if (o === 'orch' || !up(o)) console.log(l); }
  checkLeads(true);
  setInterval(() => { try { checkLeads(); } catch (e) { inboxError(e); } }, Number(process.env.ORCH_LEAD_CHECK_MS ?? 60_000));
  syncFollowers();
  setInterval(syncFollowers, 30_000);
  sayStalls(startStalls);
  setInterval(() => sayStalls(tickStalls(stalls, Date.now())), Number(process.env.ORCH_STALL_CHECK_MS ?? 60_000));
  follow(day());
  refresh();
  setInterval(refresh, 10 * 60_000);
  checkOverlap();
  setInterval(checkOverlap, 10 * 60_000);
  ensureBridge();
  setInterval(ensureBridge, 60_000);
  void ensureQueue();
  setInterval(() => void ensureQueue(), 60_000);
}

// Keep board.md and sessions.json fresh so new sessions get names (the plan's 10-minute refresh).
const refresh = () => spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', join(import.meta.dirname, 'cli.ts')], { stdio: 'ignore' })
  .on('error', () => {});

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
    for (const l of out.split('\n')) if (l.startsWith('OVERLAP ')) say(l);
    // A crash prints a stack; its Error: line says what went wrong. orch's own refusals are one line.
    const lines = err.trim().split('\n');
    const why = (lines.find(l => /\w*Error: /.test(l)) ?? lines.at(-1) ?? '').trim().slice(0, 200);
    if (code !== 0) console.log(`OVERLAP error: check ${signal ? `killed (${signal}, over 5 minutes)` : `exited ${code}`}: ${why}`);
  });
  c.on('error', e => { overlapRunning = false; console.log(`OVERLAP error: check did not start: ${e.message}`); });
}

// The idea bridge must always run while it is live: start it when it is down, check every minute.
// Detached, so re-arming the watcher never takes it down; launchd's copy counts as running too.
function ensureBridge() {
  let adapter: 'mock' | 'discord';
  try { adapter = loadConfig(root).adapter; } catch (e) { say(`BRIDGE error: ideas/config.json: ${e instanceof Error ? e.message : e}`); return; }
  const running = spawnSync('pgrep', ['-f', 'src/ideas-run.ts'], { encoding: 'utf8' }).stdout.trim() !== '';
  if (!bridgeShouldStart(adapter, existsSync(join(root, 'ideas', 'off')), running)) return;
  // Double fork through sh, so the bridge's parent is launchd and stopping the watcher's process tree leaves it running.
  const log = join(homedir(), 'Library', 'Logs', 'orch.ideas.log');
  const r = spawnSync('/bin/sh', ['-c', `nohup npm run -s ideas >> '${log}' 2>&1 < /dev/null &`], { cwd: root, encoding: 'utf8' });
  say(r.status === 0 ? 'BRIDGE started (it was down)' : `BRIDGE error: could not start: ${r.stderr.trim()}`);
}

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
if (me) startLeadSide(me); else startOrchSide();
