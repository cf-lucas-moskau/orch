// IO glue for the idea bridge: the ideas/ store, the daemon's message handler and `orch idea <sub>`.
// Ideas live in ideas/<id>.json, settings in ideas/config.json, the kill switch is the file ideas/off.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chatFor, MockChat, type Chat } from './discord.ts';
import {
  advance, DEFAULT_CONFIG, refuse, sanitize, STRANGER, ideaLine, nextId, planPost, route, shipPost, startBlocker, startPost, threadName, workerName, workerTask,
  type Config, type Idea, type Incoming, type Refused, type Step,
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
const save = (root: string, i: Idea) => { mkdirSync(dir(root), { recursive: true }); writeFileSync(join(dir(root), `${i.id}.json`), JSON.stringify(i, null, 2) + '\n'); };
const loadRefused = (root: string): Refused => { try { return JSON.parse(readFileSync(join(dir(root), 'refused.json'), 'utf8')); } catch { return { day: '', ids: [] }; } };
export const isOff = (root: string) => existsSync(join(dir(root), 'off'));

// The watcher tails the feed, so a feed line is how an idea message reaches orch.
function feed(root: string, line: string, now: string) {
  mkdirSync(join(root, 'feed'), { recursive: true });
  const e = { ts: now, sid: 'idea-bridge', event: 'Idea', cwd: root, prompt: '', msg: line };
  appendFileSync(join(root, 'feed', `${new Date(now).toLocaleDateString('sv-SE')}.jsonl`), JSON.stringify(e) + '\n');
}

export async function handle(d: Deps & { chat: Chat }, m: Incoming) {
  const now = (d.now ?? (() => new Date().toISOString()))();
  const config = loadConfig(d.root);
  const refused = loadRefused(d.root);
  const r = route(m, { ideas: loadIdeas(d.root), config, off: isOff(d.root), now, refused });
  if (r.kind === 'ignore') return;
  if (r.kind === 'refuse') {
    if (r.answer) {
      await d.chat.reply(m.thread ?? m.channel, STRANGER);
      mkdirSync(dir(d.root), { recursive: true });
      writeFileSync(join(dir(d.root), 'refused.json'), JSON.stringify(refuse(refused, m.author.id, now)) + '\n');
    }
    d.log(`idea bridge refused ${m.author.name} (${m.author.id}, not allowlisted${r.answer ? '' : ', already told today, no reply'}): ${sanitize(m.text).replace(/\s+/g, ' ').slice(0, 80)}`);
    return;
  }
  if (r.kind === 'answer') {
    await d.chat.reply(m.thread ?? m.channel, r.text);
    d.log(`idea bridge answered ${m.author.name}${r.idea ? ` in ${r.idea.id}` : ''}: ${r.text.slice(0, 80)}`);
    return;
  }
  if (r.kind === 'new') {
    const id = nextId(loadIdeas(d.root).map(i => i.id));
    const thread = await d.chat.createThread(m.id, threadName(r.text));
    save(d.root, { id, thread, message: m.id, author: m.author, text: r.text, state: 'talk', created: now, updated: now });
    await d.chat.react(m.channel, m.id, '👀');
    feed(d.root, ideaLine(id, 'new', m.author.name, r.text), now);
    d.log(`idea ${id} from ${m.author.name}: ${r.text.slice(0, 100)}`);
    return;
  }
  if (r.kind === 'message') return feed(d.root, ideaLine(r.idea.id, 'msg', m.author.name, r.text), now);
  const next = advance(r.idea, 'go', now);
  if (typeof next === 'string') return;
  save(d.root, { ...next, goBy: m.author.id });
  await d.chat.react(m.channel, m.id, '✅');
  feed(d.root, ideaLine(r.idea.id, 'go', m.author.name, 'go'), now);
  d.log(`idea ${r.idea.id}: go from ${m.author.name}`);
}

const USAGE = `usage: orch idea list | off | on
       orch idea fake "<text>" --as <user> [--in <id>]   (mock adapter only)
       orch idea say <id> <text|file> | plan <id> <file|text> | start <id> | ship <id> <changelog file|text> | close <id> [reason]`;

// A single argument naming an existing file is that file's text.
const textOf = (root: string, args: string[]) => {
  const f = args.length === 1 ? resolve(root, args[0]) : '';
  return (f && existsSync(f) ? readFileSync(f, 'utf8') : args.join(' ')).trim();
};

export async function idea(args: string[], d: Deps): Promise<string> {
  const [sub, id, ...rest] = args;
  const now = (d.now ?? (() => new Date().toISOString()))();
  const config = loadConfig(d.root);
  const chat = () => d.chat ?? chatFor(d.root, config);
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
  const step = (s: Step, patch: Partial<Idea> = {}) => {
    const next = advance(cur, s, now);
    if (typeof next === 'string') fail(next);
    const i = { ...(next as Idea), ...patch };
    save(d.root, i);
    return i;
  };
  const text = textOf(d.root, rest);
  if (sub === 'say') {
    if (!text) throw new Error(USAGE);
    step('say');
    await chat().reply(cur.thread, text);
    d.log(`idea ${id} say: ${text.slice(0, 120)}`);
    return `posted in ${id}`;
  }
  if (sub === 'plan') {
    if (!text) throw new Error(USAGE);
    step('plan', { plan: text, goBy: undefined });
    await chat().reply(cur.thread, planPost(text));
    d.log(`idea ${id} plan posted: ${text.split('\n')[0].slice(0, 100)}`);
    return `plan posted in ${id}; waiting for go`;
  }
  if (sub === 'start') {
    const blocker = startBlocker(cur, loadIdeas(d.root), config, isOff(d.root));
    if (blocker) fail(`not started: ${blocker}`);
    const name = workerName(id);
    d.run([config.repo, name, workerTask(cur)]);
    step('start', { worker: name });
    await chat().reply(cur.thread, startPost());
    d.log(`idea ${id} start: worker ${name} on ${config.repo}`);
    return `${id} building as worker ${name}`;
  }
  if (sub === 'ship') {
    if (!text) throw new Error(USAGE);
    step('ship');
    await chat().reply(cur.thread, shipPost(text, config.liveUrl));
    d.log(`idea ${id} shipped: ${text.split('\n')[0].slice(0, 100)}`);
    return `changelog posted in ${id}`;
  }
  if (sub === 'close') {
    const reason = text || 'done';
    step('close', { closed: reason });
    await chat().reply(cur.thread, `Closing this idea: ${reason}`);
    d.log(`idea ${id} closed: ${reason}`);
    return `${id} closed`;
  }
  throw new Error(USAGE);
}

const fail = (msg: string): never => { throw new Error(msg); };
