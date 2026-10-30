// IO glue for the idea bridge: the ideas/ store, the daemon's message handler and `orch idea <sub>`.
// Ideas live in ideas/<id>.json, settings in ideas/config.json, the kill switch is the file ideas/off.
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { isAbsolute, join, normalize, sep } from 'node:path';
import { chatFor, MockChat, type Chat } from './discord.ts';
import {
  advance, DEFAULT_CONFIG, ideaLine, nextId, PAUSED, planPost, route, sanitize, shipPost, startBlocker, startPost, STRANGER, tell, threadName, workerName, workerTask,
  type Config, type Idea, type Incoming, type Step, type Told,
} from './ideas.ts';

export type Deps = { root: string; log: (msg: string) => void; run: (args: string[]) => void; chat?: Chat; now?: () => string };

const dir = (root: string) => join(root, 'ideas');
export const loadConfig = (root: string): Config => {
  try { return { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(join(dir(root), 'config.json'), 'utf8')) }; } catch { return DEFAULT_CONFIG; }
};
export const loadIdeas = (root: string): Idea[] => existsSync(dir(root))
  ? readdirSync(dir(root)).filter(f => /^I-\d+\.json$/.test(f)).map(f => JSON.parse(readFileSync(join(dir(root), f), 'utf8')))
    .sort((a, b) => Number(a.id.slice(2)) - Number(b.id.slice(2)))
  : [];
const file = (root: string, id: string) => join(dir(root), `${id}.json`);
const save = (root: string, i: Idea) => { mkdirSync(dir(root), { recursive: true }); writeFileSync(file(root, i.id), JSON.stringify(i, null, 2) + '\n'); };
// The bridge and `orch idea` both write ideas: re-read right before each write, with no await in between.
function update(root: string, id: string, f: (i: Idea) => Idea): Idea {
  const i = f(JSON.parse(readFileSync(file(root, id), 'utf8')));
  save(root, i);
  return i;
}
const said = (by: string, text: string, ts: string) => (i: Idea): Idea => ({ ...i, messages: [...i.messages ?? [], { ts, by, text }] });
const loadTold = (root: string): Told => { try { return JSON.parse(readFileSync(join(dir(root), 'told.json'), 'utf8')); } catch { return { day: '', keys: [] }; } };
export const isOff = (root: string) => existsSync(join(dir(root), 'off'));

// The watcher tails the feed, so a feed line is how an idea message reaches orch.
function feed(root: string, line: string, now: string) {
  mkdirSync(join(root, 'feed'), { recursive: true });
  const e = { ts: now, sid: 'idea-bridge', event: 'Idea', cwd: root, prompt: '', msg: line };
  appendFileSync(join(root, 'feed', `${new Date(now).toLocaleDateString('sv-SE')}.jsonl`), JSON.stringify(e) + '\n');
}

// One message at a time: Discord delivers messages concurrently, and two new ideas must not race for an id.
export function serial<T>(f: (x: T) => Promise<void>): (x: T) => Promise<void> {
  let tail: Promise<void> = Promise.resolve();
  return x => {
    const p = tail.then(() => f(x));
    tail = p.catch(() => {});
    return p;
  };
}

export async function handle(d: Deps & { chat: Chat }, m: Incoming) {
  const now = (d.now ?? (() => new Date().toISOString()))();
  const told = loadTold(d.root);
  const r = route(m, { ideas: loadIdeas(d.root), config: loadConfig(d.root), off: isOff(d.root), now, told });
  const react = (emoji: string, id: string) => d.chat.react(m.channel, m.id, emoji)
    .catch(e => d.log(`idea ${id}: ${emoji} reaction failed: ${e instanceof Error ? e.message : e}`));
  if (r.kind === 'ignore') return;
  if (r.kind === 'decline') {
    if (r.answer) {
      await d.chat.reply(m.thread ?? m.channel, r.reason === 'paused' ? PAUSED : STRANGER);
      mkdirSync(dir(d.root), { recursive: true });
      writeFileSync(join(dir(d.root), 'told.json'), JSON.stringify(tell(told, `${r.reason}:${m.author.id}`, now)) + '\n');
    }
    d.log(`idea bridge declined ${m.author.name} (${m.author.id}, ${r.reason === 'paused' ? 'bridge paused' : 'not allowlisted'}${r.answer ? '' : ', no reply'}): ${sanitize(m.text).replace(/\s+/g, ' ').slice(0, 80)}`);
    return;
  }
  if (r.kind === 'new') {
    // The id is taken on disk before the first await.
    const id = nextId(loadIdeas(d.root).map(i => i.id));
    save(d.root, { id, thread: '', message: m.id, author: m.author, text: r.text, state: 'talk', created: now, updated: now, messages: [{ ts: now, by: m.author.name, text: r.text }] });
    let thread: string;
    try { thread = await d.chat.createThread(m.id, threadName(r.text)); }
    catch (e) { rmSync(file(d.root, id), { force: true }); throw e; }
    update(d.root, id, i => ({ ...i, thread }));
    feed(d.root, ideaLine(id, 'new', m.author.name, r.text), now);
    d.log(`idea ${id} from ${m.author.name}: ${r.text.slice(0, 100)}`);
    await react('👀', id);
    return;
  }
  if (r.kind === 'answer' && !r.idea) {
    await d.chat.reply(m.channel, r.text);
    d.log(`idea bridge answered ${m.author.name}: ${r.text.slice(0, 80)}`);
    return;
  }
  const id = r.idea!.id;
  update(d.root, id, said(m.author.name, sanitize(m.text), now));
  if (r.kind === 'answer') {
    await d.chat.reply(m.thread!, r.text);
    update(d.root, id, said('orch', r.text, now));
    d.log(`idea bridge answered ${m.author.name} in ${id}: ${r.text.slice(0, 80)}`);
    return;
  }
  if (r.kind === 'message') return feed(d.root, ideaLine(id, 'msg', m.author.name, r.text), now);
  let went = false;
  update(d.root, id, i => {
    const next = advance(i, 'go', now);
    if (typeof next === 'string') return i;
    went = true;
    return { ...next, goBy: m.author.id };
  });
  if (!went) return;
  feed(d.root, ideaLine(id, 'go', m.author.name, 'go'), now);
  d.log(`idea ${id}: go from ${m.author.name}`);
  await react('✅', id);
}

// Held from the building check through the dispatch, so two starts cannot both pass the limit.
// A lock whose process is gone is stale and taken over.
async function withLock<T>(lock: string, f: () => Promise<T>): Promise<T> {
  let fd: number | undefined;
  for (let tries = 0; fd === undefined; tries++) {
    try { fd = openSync(lock, 'wx'); }
    catch (e: any) {
      if (e.code !== 'EEXIST' || tries) throw e.code === 'EEXIST' ? new Error(`another idea start is running (${lock})`) : e;
      const pid = Number(readFileSync(lock, 'utf8'));
      let alive = false;
      try { alive = !!pid && process.kill(pid, 0); } catch {}
      if (alive) throw new Error(`another idea start is running (pid ${pid}, ${lock})`);
      rmSync(lock, { force: true });
    }
  }
  writeSync(fd, String(process.pid));
  closeSync(fd);
  try { return await f(); } finally { rmSync(lock, { force: true }); }
}

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
      ...all.map(i => `${i.id} [${i.state}${i.worker ? ` ${i.worker}` : ''}] ${i.author.name}: ${i.text.split('\n')[0].slice(0, 80)}`)].join('\n');
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
  // Posts first, records after: a failed post changes nothing.
  const post = async (s: Step, text: string, patch: Partial<Idea> = {}) => {
    check(s);
    await chat().reply(cur.thread, text);
    return update(d.root, id, i => said('orch', text, now)({ ...check(s, i), ...patch }));
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
    check('plan');
    // The old plan and any go on it are withdrawn first; the new one is approvable once its post is up.
    update(d.root, id, i => ({ ...i, state: 'talk', plan: undefined, goBy: undefined, updated: now }));
    await chat().reply(cur.thread, planPost(text));
    update(d.root, id, i => said('orch', planPost(text), now)({ ...check('plan', i), plan: text }));
    d.log(`idea ${id} plan posted: ${text.split('\n')[0].slice(0, 100)}`);
    return `plan posted in ${id}; waiting for go`;
  }
  if (sub === 'start') {
    const name = workerName(id);
    await withLock(join(dir(d.root), 'start.lock'), async () => {
      const fresh = loadIdeas(d.root);
      const blocker = startBlocker(fresh.find(i => i.id === id)!, fresh, config, isOff(d.root));
      if (blocker) fail(`not started: ${blocker}`);
      const building = update(d.root, id, i => ({ ...check('start', i), worker: name }));
      try { d.run([config.repo, name, workerTask(building)]); }
      catch (e) { update(d.root, id, i => ({ ...i, state: 'approved', worker: undefined, updated: now })); throw e; }
    });
    await chat().reply(cur.thread, startPost());
    update(d.root, id, said('orch', startPost(), now));
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
