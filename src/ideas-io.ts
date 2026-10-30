// IO glue for the idea bridge: the ideas/ store, the daemon's message handler and `orch idea <sub>`.
// Ideas live in ideas/<id>.json, settings in ideas/config.json, the kill switch is the file ideas/off.
// The daemon and `orch idea` are separate processes: every read-modify-write of ideas/ runs under one lock (ideas/.lock),
// never across an await, and every write replaces its file atomically.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, normalize, sep } from 'node:path';
import { chatFor, MockChat, writeAtomic, type Chat } from './discord.ts';
import {
  advance, DEFAULT_CONFIG, ideaLine, nextId, planPost, route, sanitize, shipPost, startBlocker, startPost, tell, threadName, workerName, workerTask,
  type Config, type Idea, type Incoming, type Step, type Told,
} from './ideas.ts';

export type Deps = { root: string; log: (msg: string) => void; run: (args: string[]) => void; chat?: Chat; now?: () => string };

const dir = (root: string) => join(root, 'ideas');
// A config that exists but does not parse stops everything: guessing could mean the wrong adapter or allowlist.
export function loadConfig(root: string): Config {
  const f = join(dir(root), 'config.json');
  if (!existsSync(f)) return DEFAULT_CONFIG;
  let c: Config;
  try { c = { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(f, 'utf8')) }; }
  catch (e) { throw new Error(`ideas/config.json does not parse: ${e instanceof Error ? e.message : e}`); }
  if (!['mock', 'discord'].includes(c.adapter)) throw new Error(`ideas/config.json: adapter must be mock or discord, not ${JSON.stringify(c.adapter)}`);
  if (!Array.isArray(c.allowlist)) throw new Error('ideas/config.json: allowlist must be a list of user ids');
  return c;
}
export const loadIdeas = (root: string): Idea[] => existsSync(dir(root))
  ? readdirSync(dir(root)).filter(f => /^I-\d+\.json$/.test(f)).map(f => JSON.parse(readFileSync(join(dir(root), f), 'utf8')))
    .sort((a, b) => Number(a.id.slice(2)) - Number(b.id.slice(2)))
  : [];
const file = (root: string, id: string) => join(dir(root), `${id}.json`);
const save = (root: string, i: Idea) => writeAtomic(file(root, i.id), JSON.stringify(i, null, 2) + '\n');
const said = (by: string, text: string, ts: string) => (i: Idea): Idea => ({ ...i, messages: [...i.messages ?? [], { ts, by, text }] });
const loadTold = (root: string): Told => { try { return JSON.parse(readFileSync(join(dir(root), 'told.json'), 'utf8')); } catch { return { day: '', keys: [] }; } };
export const isOff = (root: string) => existsSync(join(dir(root), 'off'));

const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const alive = (pid: number) => { try { return pid > 0 && process.kill(pid, 0); } catch { return false; } };

// A lock is stale when its owner process is gone, or it has had no owner for a few seconds (a crash right after mkdir).
// It is taken over by renaming it away, which only one process can do; a process that renamed a lock that turned out
// to be fresh puts it back.
function takeStale(lock: string) {
  let owner = '';
  try { owner = readFileSync(join(lock, 'owner'), 'utf8'); }
  catch { try { if (Date.now() - statSync(lock).mtimeMs < 3000) return; } catch { return; } }
  if (owner && alive(Number(owner.split(' ')[0]))) return;
  const aside = `${lock}.stale-${process.pid}-${Math.random().toString(36).slice(2)}`;
  try { renameSync(lock, aside); } catch { return; }
  let taken = '';
  try { taken = readFileSync(join(aside, 'owner'), 'utf8'); } catch {}
  if (taken !== owner) { try { renameSync(aside, lock); } catch {} return; }
  rmSync(aside, { recursive: true, force: true });
}

export function locked<T>(root: string, f: () => T): T {
  mkdirSync(dir(root), { recursive: true });
  const lock = join(dir(root), '.lock');
  const until = Date.now() + 15_000;
  for (;;) {
    try {
      mkdirSync(lock);
      writeFileSync(join(lock, 'owner'), `${process.pid} ${Math.random().toString(36).slice(2)}`);
      break;
    } catch (e: any) { if (e.code !== 'EEXIST') throw e; }
    takeStale(lock);
    if (Date.now() > until) throw new Error(`ideas/ is locked by another process (${lock})`);
    pause(10);
  }
  try { return f(); } finally { rmSync(lock, { recursive: true, force: true }); }
}

// Re-reads the idea and writes it back, under the lock.
const update = (root: string, id: string, f: (i: Idea) => Idea): Idea =>
  locked(root, () => { const i = f(JSON.parse(readFileSync(file(root, id), 'utf8'))); save(root, i); return i; });

// The watcher tails the feed, so a feed line is how an idea message reaches orch.
function feed(root: string, line: string, now: string) {
  mkdirSync(join(root, 'feed'), { recursive: true });
  const e = { ts: now, sid: 'idea-bridge', event: 'Idea', cwd: root, prompt: '', msg: line };
  appendFileSync(join(root, 'feed', `${new Date(now).toLocaleDateString('sv-SE')}.jsonl`), JSON.stringify(e) + '\n');
}

export async function handle(d: Deps & { chat: Chat }, m: Incoming) {
  const now = (d.now ?? (() => new Date().toISOString()))();
  const config = loadConfig(d.root);
  const text = sanitize(m.text);
  // Decide and record under the lock; talk to Discord after it.
  const r = locked(d.root, () => {
    const told = loadTold(d.root);
    const r = route(m, { ideas: loadIdeas(d.root), config, off: isOff(d.root), now, told });
    if (r.kind === 'decline' && r.answer) writeAtomic(join(dir(d.root), 'told.json'), JSON.stringify(tell(told, `${r.reason}:${m.author.id}`, now)) + '\n');
    if (r.kind === 'new') {
      const id = nextId(loadIdeas(d.root).map(i => i.id));
      save(d.root, { id, thread: '', message: m.id, author: m.author, text: r.text, state: 'creating', created: now, updated: now, messages: [{ ts: now, by: m.author.name, text: r.text }] });
      return { ...r, id };
    }
    if (r.kind === 'answer' || r.kind === 'message' || r.kind === 'go') {
      const cur = said(m.author.name, text, now)(JSON.parse(readFileSync(file(d.root, r.idea!.id), 'utf8')));
      const next = r.kind === 'go' ? advance(cur, 'go', now) : cur;
      if (typeof next === 'string') { save(d.root, cur); return { kind: 'ignore' as const }; }
      save(d.root, r.kind === 'answer' ? next : { ...next, needsOrch: r.kind === 'go' ? 'go' as const : 'msg' as const, ...(r.kind === 'go' ? { goBy: m.author.id } : {}) });
    }
    return r;
  });
  const react = (emoji: string, id: string) => d.chat.react(m.channel, m.id, emoji)
    .catch(e => d.log(`idea ${id}: ${emoji} reaction failed: ${e instanceof Error ? e.message : e}`));
  if (r.kind === 'ignore') return;
  if (r.kind === 'decline') {
    if (r.answer) await d.chat.reply(m.thread ?? m.channel, r.text);
    d.log(`idea bridge declined ${m.author.name} (${m.author.id}, ${{ stranger: 'not allowlisted', paused: 'bridge paused', limit: 'over the daily limit' }[r.reason]}${r.answer ? '' : ', no reply'}): ${text.replace(/\s+/g, ' ').slice(0, 80)}`);
    return;
  }
  if (r.kind === 'new') {
    let thread: string;
    try { thread = await d.chat.createThread(m.id, threadName(r.text)); }
    catch (e) { locked(d.root, () => rmSync(file(d.root, r.id), { force: true })); throw e; }
    opened(d, r.id, thread, now);
    await react('👀', r.id);
    return;
  }
  const id = r.idea!.id;
  if (r.kind === 'answer') {
    await d.chat.reply(m.thread!, r.text);
    update(d.root, id, said('orch', r.text, now));
    d.log(`idea bridge answered ${m.author.name} in ${id}: ${r.text.slice(0, 80)}`);
    return;
  }
  if (r.kind === 'message') return feed(d.root, ideaLine(id, 'msg', m.author.name, r.text), now);
  feed(d.root, ideaLine(id, 'go', m.author.name, 'go'), now);
  d.log(`idea ${id}: go from ${m.author.name}`);
  await react('✅', id);
}

function opened(d: Deps, id: string, thread: string, now: string) {
  const i = update(d.root, id, i => ({ ...i, thread, state: 'talk', needsOrch: 'new' }));
  feed(d.root, ideaLine(id, 'new', i.author.name, i.text), now);
  d.log(`idea ${id} from ${i.author.name}: ${i.text.slice(0, 100)}`);
}

// On daemon start: an idea left in creating (the bridge died while opening its thread) gets the thread that was
// opened, or is dropped so the post is handled again.
export async function reconcile(d: Deps & { chat: Chat }) {
  const now = (d.now ?? (() => new Date().toISOString()))();
  for (const i of loadIdeas(d.root).filter(i => i.state === 'creating')) {
    const thread = await d.chat.findThread(i.message);
    if (thread) { opened(d, i.id, thread, now); continue; }
    locked(d.root, () => rmSync(file(d.root, i.id), { force: true }));
    d.log(`idea ${i.id} dropped: its thread was never opened (post ${i.message} by ${i.author.name})`);
  }
}

const runningWorker = (root: string, name: string) => {
  try { return JSON.parse(readFileSync(join(root, 'workers.json'), 'utf8')).some((w: any) => w.name === name && w.status === 'running'); }
  catch { return false; }
};

const USAGE = `usage: orch idea list | off | on
       orch idea fake "<text>" --as <user> [--in <id>]   (mock adapter only)
       orch idea say <id> <text|file> | plan <id> <file|text> | start <id> | ship <id> <changelog file|text> | close <id> [reason]`;

// A single argument naming a file under ideas/ (relative, no ..) is that file's text; anything else is the text itself,
// so a mistyped path can never post secrets/ or a file outside orch.
export function textOf(root: string, args: string[]): string {
  const a = args.length === 1 ? args[0] : '';
  const rel = a && !isAbsolute(a) ? normalize(a) : '';
  if (rel.startsWith(`ideas${sep}`) && !a.split(/[\\/]/).includes('..')) {
    const f = join(root, rel);
    try {
      if (statSync(f).isFile() && realpathSync(f).startsWith(realpathSync(dir(root)) + sep)) return readFileSync(f, 'utf8').trim();
    } catch {}
  }
  return args.join(' ').trim();
}

export async function idea(args: string[], d: Deps): Promise<string> {
  const [sub, id, ...rest] = args;
  const now = (d.now ?? (() => new Date().toISOString()))();
  const config = loadConfig(d.root);
  const chat = () => d.chat ?? chatFor(d.root, config, d.log);
  if (sub === 'list' || !sub) {
    const all = loadIdeas(d.root);
    return [`bridge ${isOff(d.root) ? 'off' : 'on'}, adapter ${config.adapter}`,
      ...all.map(i => `${i.id} [${i.state}${i.worker ? ` ${i.worker}` : ''}] ${i.author.name}: ${i.text.split('\n')[0].slice(0, 80)}${i.needsOrch ? ` (needs orch: ${i.needsOrch})` : ''}`)].join('\n');
  }
  if (sub === 'off' || sub === 'on') {
    mkdirSync(dir(d.root), { recursive: true });
    if (sub === 'off') writeFileSync(join(dir(d.root), 'off'), now + '\n'); else rmSync(join(dir(d.root), 'off'), { force: true });
    d.log(`idea bridge ${sub}`);
    return `idea bridge ${sub}`;
  }
  if (sub === 'fake') {
    const c = chat();
    if (!(c instanceof MockChat)) throw new Error('fake posts only work with the mock adapter');
    const all = [id, ...rest].filter(a => a !== undefined);
    const flag = (f: string) => all.includes(f) ? all[all.indexOf(f) + 1] : undefined;
    const as = flag('--as'), into = flag('--in');
    const text = all.filter((a, i) => !['--as', '--in'].includes(a) && !['--as', '--in'].includes(all[i - 1])).join(' ').trim();
    if (!as || !text) throw new Error(USAGE);
    const thread = into ? (loadIdeas(d.root).find(i => i.id === into) ?? fail(`no idea ${into}`)).thread : undefined;
    const m = c.post(as, text, thread);
    return `posted ${m.id} as ${as}${into ? ` in ${into}` : ''}`;
  }
  if (!id) throw new Error(USAGE);
  const cur = loadIdeas(d.root).find(i => i.id === id) ?? fail(`no idea ${id}`);
  const check = (s: Step, i = cur) => { const next = advance(i, s, now); return typeof next === 'string' ? fail(next) : next; };
  // orch answered, so the idea no longer waits on orch.
  const answered = (i: Idea, text: string): Idea => ({ ...said('orch', text, now)(i), needsOrch: undefined });
  // Checked before posting, and again under the lock after: the daemon may have moved the idea meanwhile.
  const post = async (s: Step, text: string, patch: Partial<Idea> = {}) => {
    check(s);
    await chat().reply(cur.thread, text);
    return update(d.root, id, i => {
      const next = advance(i, s, now);
      if (typeof next === 'string') fail(`posted, but not recorded: ${next}`);
      return answered({ ...(next as Idea), ...patch }, text);
    });
  };
  const text = textOf(d.root, rest);
  if (sub === 'say') {
    if (!text) throw new Error(USAGE);
    await post('say', text);
    d.log(`idea ${id} say: ${text.slice(0, 120)}`);
    return `posted in ${id}`;
  }
  if (sub === 'plan') {
    if (!text) throw new Error(USAGE);
    // The old plan and any go on it are withdrawn first; the new one is approvable once its post is up.
    update(d.root, id, i => { check('plan', i); return { ...i, state: 'talk', plan: undefined, goBy: undefined, updated: now }; });
    await chat().reply(cur.thread, planPost(text));
    update(d.root, id, i => answered({ ...check('plan', i), plan: text }, planPost(text)));
    d.log(`idea ${id} plan posted: ${text.split('\n')[0].slice(0, 100)}`);
    return `plan posted in ${id}; waiting for go`;
  }
  if (sub === 'start') {
    const name = workerName(id);
    // The building slot is taken under the lock, so two starts cannot both pass the limit.
    const building = locked(d.root, () => {
      const fresh = loadIdeas(d.root);
      const blocker = startBlocker(fresh.find(i => i.id === id)!, fresh, config, isOff(d.root));
      if (blocker) fail(`not started: ${blocker}`);
      const i: Idea = { ...check('start', fresh.find(i => i.id === id)), worker: name, needsOrch: undefined };
      save(d.root, i);
      return i;
    });
    try { d.run([config.repo, name, workerTask(building)]); }
    catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // run can fail after the worker exists (not ready, prompt stalled): the idea builds with that worker.
      if (!runningWorker(d.root, name)) {
        update(d.root, id, i => i.state === 'building' && i.worker === name ? { ...i, state: 'approved', worker: undefined, updated: now } : i);
        throw e;
      }
      d.log(`idea ${id} start: run reported "${msg.slice(0, 120)}", but worker ${name} exists; building with it`);
    }
    await chat().reply(cur.thread, startPost());
    update(d.root, id, i => answered(i, startPost()));
    d.log(`idea ${id} start: worker ${name} on ${config.repo}`);
    return `${id} building as worker ${name}`;
  }
  if (sub === 'ship') {
    if (!text) throw new Error(USAGE);
    await post('ship', shipPost(text, config.liveUrl));
    d.log(`idea ${id} shipped: ${text.split('\n')[0].slice(0, 100)}`);
    return `changelog posted in ${id}`;
  }
  if (sub === 'close') {
    const reason = text || 'done';
    await post('close', `Closing this idea: ${reason}`, { closed: reason });
    d.log(`idea ${id} closed: ${reason}`);
    return `${id} closed`;
  }
  throw new Error(USAGE);
}

const fail = (msg: string): never => { throw new Error(msg); };
