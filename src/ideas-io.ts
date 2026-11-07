// IO glue for the idea bridge: the ideas/ store, the daemon's message handler and `orch idea <sub>`.
// Ideas live in ideas/<id>.json, settings in ideas/config.json, the kill switch is the file ideas/off.
// The daemon and `orch idea` are separate processes: every read-modify-write of ideas/ runs under one lock (ideas/.lock),
// never across an await, and every write replaces its file atomically.
import { appendFileSync, closeSync, constants, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, normalize, sep } from 'node:path';
import { chatFor, MockChat, RearchiveFailed, writeAtomic, type Attachment, type Chat, type ReplyOptions } from './discord.ts';
import {
  advance, answer, askPost, imageOk, inboxOrder, inboxPicks, inboxUrlOk, withScreenshots, clears, DEFAULT_CONFIG, dossierText, dueGoReminder, dueQuestions, goReminderPost, entry, DECISION_ID, decisionStatus, isParked, parkBlocker, MAX_MEDIA, mediaOk, migrate, parseNotes, progress, roundOf, STAGES, STALE_DAYS, stale, timeoutPost, type Stage, ideaLine, keywordsPost, labelled, labelName, parseTitle, nextId, planPost, route, sanitize, shipPost, startBlocker, startPost, tell, threadName, visiblePlan, withRelated, workerName, workerTask,
  type Config, type Idea, type Incoming, type Question, type Step, type Title, type Told,
} from './ideas.ts';

// sleep: the pause between thread renames in `idea relabel`; tests pass a fast one.
// fetch: how attachments are downloaded; tests pass a stub.
export type Deps = { root: string; log: (msg: string) => void; run: (args: string[]) => void; chat?: Chat; now?: () => string; sleep?: (ms: number) => Promise<void>; fetch?: typeof fetch };
const RENAME_GAP_MS = 2000;

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
const ideaFiles = (root: string) => existsSync(dir(root)) ? readdirSync(dir(root)).filter(f => /^I-\d+\.json$/.test(f)) : [];
// An unreadable idea file is skipped and reported once per process; its id stays taken.
const reported = new Set<string>();
export function loadIdeas(root: string, log: (msg: string) => void = m => console.error(m)): Idea[] {
  return ideaFiles(root).flatMap(f => {
    try { return [migrate(JSON.parse(readFileSync(join(dir(root), f), 'utf8')))]; }
    catch (e) {
      if (!reported.has(join(dir(root), f))) { reported.add(join(dir(root), f)); log(`idea bridge: skipped ideas/${f}, unreadable: ${e instanceof Error ? e.message : e}`); }
      return [];
    }
  }).sort((a, b) => Number(a.id.slice(2)) - Number(b.id.slice(2)));
}
const file = (root: string, id: string) => join(dir(root), `${id}.json`);
const read = (root: string, id: string): Idea => migrate(JSON.parse(readFileSync(file(root, id), 'utf8')));
// The idea's dossier, ideas/<id>/dossier.md, is rendered on every save; the JSON stays the source.
export const dossierFile = (root: string, id: string) => join(dir(root), id, 'dossier.md');
function save(root: string, i: Idea) {
  writeAtomic(file(root, i.id), JSON.stringify(i, null, 2) + '\n');
  if (i.state === 'creating') return;
  mkdirSync(join(dir(root), i.id), { recursive: true });
  writeAtomic(dossierFile(root, i.id), dossierText(i));
}
// Ideas from before rounds get their round and dossier written; idempotent, so every start of the bridge and every
// `orch idea` runs it.
// The scan runs without the lock; only a store with something to migrate takes it, and checks again under it.
export function migrateAll(root: string, log: (msg: string) => void) {
  const due = (f: string) => {
    const raw = JSON.parse(readFileSync(join(dir(root), f), 'utf8'));
    return raw.round === undefined || !existsSync(dossierFile(root, raw.id)) ? raw as Idea : undefined;
  };
  const failed = (f: string, e: unknown) => log(`idea bridge: ideas/${f} not migrated: ${e instanceof Error ? e.message : e}`);
  const todo = ideaFiles(root).filter(f => { try { return !!due(f); } catch (e) { failed(f, e); return false; } });
  if (!todo.length) return;
  locked(root, () => {
    for (const f of todo) {
      try { const raw = due(f); if (raw) save(root, migrate(raw)); }
      catch (e) { failed(f, e); }
    }
  });
}
// One decision file's Status: undefined when there is no such file (or it went away while read), '' without a Status line.
function statusOf(root: string, id: string): string | undefined {
  if (!DECISION_ID.test(id)) return undefined;
  try { return decisionStatus(readFileSync(join(root, 'decisions', `${id}.md`), 'utf8')); } catch { return undefined; }
}
// The decisions the parked ideas wait on that are still open. Only their files are read, none when nothing is parked.
const openDecisions = (ideas: Idea[], root: string) =>
  new Set([...new Set(ideas.flatMap(i => i.parked ? [i.parked] : []))].filter(id => statusOf(root, id) === 'open'));
// A park whose decision is no longer open, or whose idea stopped building, is cleared. Every `orch idea` and every
// bridge tick runs it.
export function unparkSettled(root: string, log: (msg: string) => void) {
  const ideas = loadIdeas(root, log);
  if (!ideas.some(i => i.parked)) return;
  const open = openDecisions(ideas, root);
  const stale = (i: Idea) => !!i.parked && !isParked(i, open);
  for (const i of ideas.filter(stale)) {
    let cleared: Idea | undefined;
    update(root, i.id, x => stale(x) ? (cleared = x, { ...x, parked: undefined }) : x);
    if (cleared) log(`idea ${i.id} unparked: ${cleared.state === 'building' ? `${cleared.parked} is no longer open` : `it is ${cleared.state}`}`);
  }
}
const reopenedTalk = (i: Idea) => roundOf(i) > 1 && !(i.dossier ?? []).some(e => e.round === roundOf(i) && e.kind === 'plan');
const said = (by: string, text: string, ts: string, media?: string) => (i: Idea): Idea => ({ ...i, messages: [...i.messages ?? [], { ts, by, text, ...(media ? { media } : {}) }] });
// Where a building idea's worker leaves progress notes and their media.
export const progressDir = (root: string, id: string) => join(dir(root), 'progress', id);
const readNotes = (root: string, id: string) => { try { return parseNotes(readFileSync(join(progressDir(root, id), 'notes.jsonl'), 'utf8')); } catch { return []; } };

// A note's media, read once through one file descriptor, or why it stays out: the folder must resolve to exactly
// ideas/progress/<id>, the file opens without following a symlink, is regular, at most 8 MB, and a png, jpg, gif,
// mp4 or webm by extension and by its bytes. The bytes checked are the bytes sent.
export function mediaFile(root: string, id: string, name: string): { file: Attachment } | { refused: string } {
  let fd: number | undefined;
  try {
    const folder = realpathSync(progressDir(root, id));
    if (folder !== join(realpathSync(dir(root)), 'progress', id)) return { refused: 'outside its progress folder' };
    try { fd = openSync(join(folder, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (e: any) { return { refused: e?.code === 'ELOOP' ? 'not a regular file' : 'not found' }; }
    const st = fstatSync(fd);
    if (!st.isFile()) return { refused: 'not a regular file' };
    if (st.size > MAX_MEDIA) return { refused: `${(st.size / 1048576).toFixed(1)} MB is over 8 MB` };
    const data = Buffer.alloc(st.size);
    let got = 0;
    for (let n; got < data.length && (n = readSync(fd, data, got, data.length - got, got)) > 0;) got += n;
    if (got !== data.length) return { refused: 'changed while it was read' };
    return mediaOk(name, data) ? { file: { name, data } } : { refused: 'not a png, jpg, gif, mp4 or webm file' };
  } catch { return { refused: 'not found' }; }
  finally { if (fd !== undefined) closeSync(fd); }
}
import type { Download, InboxPick } from './ideas.ts';

// Images the team posted for an idea, kept for orch and its workers. Files land under their final name only once
// complete, so a half-written one is never listed.
export const inboxDir = (root: string, id: string) => join(dir(root), 'inbox', id);
const inboxNames = (root: string, id: string) => {
  try { return inboxOrder(readdirSync(inboxDir(root, id)).filter(f => /^\w+-\d+\.(png|jpg|gif|webp)$/.test(f))); }
  catch { return []; }
};
// The images of the idea's current round: a closed round's leftovers are never handed to a new worker.
const inboxFiles = (root: string, i: Idea) => {
  const old = new Set((i.leftovers ?? []).flatMap(l => l.files));
  return inboxNames(root, i.id).filter(f => !old.has(f)).map(f => join(inboxDir(root, i.id), f));
};
const REDIRECTS = 3;
const DOWNLOAD_MS = 30_000;
// One attachment's bytes, or why not. Every hop, redirects included, must be on Discord's CDN, and the body stops
// at 8 MB. The bytes are only ever compared against magic numbers, never parsed. All hops share one 30 s deadline.
export async function download(get: typeof fetch, url: string, signal = AbortSignal.timeout(DOWNLOAD_MS)): Promise<{ data: Buffer } | { refused: string }> {
  for (let hop = 0, u = url; hop <= REDIRECTS; hop++) {
    if (!inboxUrlOk(u)) return { refused: 'redirected off Discord\'s CDN' };
    let res: Response;
    try { res = await get(u, { redirect: 'manual', signal }); }
    catch (e) { return { refused: `download failed: ${e instanceof Error ? e.message : e}` }; }
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel();
      const to = res.headers.get('location');
      if (!to) return { refused: `HTTP ${res.status} without a location` };
      u = new URL(to, u).href;
      continue;
    }
    if (!res.ok) { await res.body?.cancel(); return { refused: `HTTP ${res.status}` }; }
    const over = { refused: 'over 8 MB' };
    if (Number(res.headers.get('content-length')) > MAX_MEDIA) { await res.body?.cancel(); return over; }
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const c of res.body ?? []) {
        size += c.length;
        if (size > MAX_MEDIA) return over;
        chunks.push(Buffer.from(c));
      }
    } catch (e) { return { refused: `download failed: ${e instanceof Error ? e.message : e}` }; }
    return { data: Buffer.concat(chunks) };
  }
  return { refused: 'too many redirects' };
}

// At most SLOTS images download at once across all messages, and each is on disk before its slot frees, so the
// bridge never holds more than SLOTS * 8 MB of image bytes.
export const SLOTS = 3;
let busy = 0;
const waiting: (() => void)[] = [];
async function slot<T>(f: () => Promise<T>): Promise<T> {
  if (busy < SLOTS) busy++; else await new Promise<void>(r => waiting.push(r));
  try { return await f(); }
  finally { const next = waiting.shift(); if (next) next(); else busy--; }
}

const owns = (i: Idea | undefined, msg: string) => i?.downloads?.find(x => x.msg === msg);
const readIf = (root: string, id: string) => existsSync(file(root, id)) ? read(root, id) : undefined;
// Fetches a recorded download beside the message queue: its images in parallel, each written under the lock only
// while the download is still on the idea (a close drops it, so a late image never lands in a closed round). Then the
// message gets its screenshots and the watcher its line, which goes out even when something on the way threw.
const inflight = new Map<string, Promise<void>>();
export async function settled() { while (inflight.size) await Promise.allSettled([...inflight.values()]); }
function fetchDownload(d: Deps, id: string, dl: Download) {
  const key = `${d.root} ${id} ${dl.msg}`;
  if (inflight.has(key)) return;
  const left = (what: string) => d.log(`idea bridge: attachment ${what} on message ${dl.msg} from ${dl.by} skipped`);
  const keep = async (p: InboxPick) => slot(async () => {
    // A job a close dropped gives its slot straight back; a file an earlier run saved before a crash counts as is.
    const now = readIf(d.root, id);
    if (!owns(now, dl.msg)) { left(`${p.from} arrived after the close`); return; }
    if (existsSync(join(inboxDir(d.root, id), p.name))) return p.name;
    const got = await download(d.fetch ?? fetch, p.url).catch(e => ({ refused: `download failed: ${e instanceof Error ? e.message : e}` }));
    if ('refused' in got) { left(`${p.from} ${got.refused}`); return; }
    if (!imageOk(p.ext, got.data)) { left(`${p.from} its bytes are not a ${p.ext}`); return; }
    try {
      return locked(d.root, () => {
        if (!owns(readIf(d.root, id), dl.msg)) { left(`${p.from} arrived after the close`); return; }
        writeAtomic(join(inboxDir(d.root, id), p.name), got.data);
        return p.name;
      });
    } catch (e) { left(`${p.from} not saved: ${e instanceof Error ? e.message : e}`); return; }
  });
  // The line goes out only once the message's screenshots are recorded. A failed record leaves the download on the
  // idea, and the next tick runs it again, so the line is neither lost nor sent twice.
  const job = (async () => {
    try {
      const names = (await Promise.all(dl.picks.map(keep))).filter((n): n is string => !!n);
      const kept = locked(d.root, () => {
        const i = readIf(d.root, id);
        if (!owns(i, dl.msg)) {
          if (names.length) d.log(`idea ${id}: ${names.length} image(s) from message ${dl.msg} arrived after the close, not kept`);
          return undefined;
        }
        const downloads = i!.downloads!.filter(x => x.msg !== dl.msg);
        save(d.root, withScreenshots({ ...i!, downloads: downloads.length ? downloads : undefined }, dl.msg, names, dl.ts, dl.by));
        return names;
      });
      if (kept && dl.line) feed(d.root, ideaLine(id, dl.line.kind, dl.by, dl.line.text, kept.length), (d.now ?? (() => new Date().toISOString()))());
    } catch (e) {
      d.log(`idea ${id}: images from message ${dl.msg} failed, retried on the next tick: ${e instanceof Error ? e.message : e}`);
    }
  })();
  inflight.set(key, job);
  void job.finally(() => inflight.delete(key));
}
// A message's images to fetch, or none; the attachments left out are logged.
function downloadOf(d: Deps, m: Incoming, ts: string, line?: Download['line']): Download | undefined {
  const { take, skip } = inboxPicks(m.id, m.attachments ?? []);
  skip.forEach(what => d.log(`idea bridge: attachment ${what} on message ${m.id} from ${m.author.name} skipped`));
  return take.length ? { msg: m.id, ts, by: m.author.name, picks: take, ...(line ? { line } : {}) } : undefined;
}
// Closing ends the round's inbox: its pending downloads go in the same write, and its files become leftovers, kept
// for the round's worker if it still runs. sweepInbox deletes them once the close is saved.
const closeInbox = (root: string, i: Idea): Idea => {
  const old = new Set((i.leftovers ?? []).flatMap(l => l.files));
  const files = inboxNames(root, i.id).filter(f => !old.has(f));
  const kept = files.length ? { leftovers: [...i.leftovers ?? [], { ...(running(root, i.worker) ? { worker: i.worker } : {}), files }] } : {};
  return { ...i, downloads: undefined, ...kept };
};
// Deletes the leftovers whose worker is gone, whatever state the idea is in now; idempotent.
function sweepInbox(root: string, id: string) {
  locked(root, () => {
    const i = readIf(root, id);
    const gone = (i?.leftovers ?? []).filter(l => !running(root, l.worker));
    if (!gone.length) return;
    for (const f of gone.flatMap(l => l.files)) rmSync(join(inboxDir(root, id), f), { force: true });
    const rest = i!.leftovers!.filter(l => !gone.includes(l));
    save(root, { ...i!, leftovers: rest.length ? rest : undefined });
    try { rmdirSync(inboxDir(root, id)); } catch {}
  });
}
const dropInbox = (root: string, id: string) => rmSync(inboxDir(root, id), { recursive: true, force: true });

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
  locked(root, () => { const i = f(read(root, id)); save(root, i); return i; });

// The watcher tails the feed, so a feed line is how an idea message reaches orch. event: Idea, or Team for team-general.
export function feed(root: string, line: string, now: string, event: 'Idea' | 'Team' = 'Idea') {
  mkdirSync(join(root, 'feed'), { recursive: true });
  const e = { ts: now, sid: 'idea-bridge', event, cwd: root, prompt: '', msg: line };
  appendFileSync(join(root, 'feed', `${new Date(now).toLocaleDateString('sv-SE')}.jsonl`), JSON.stringify(e) + '\n');
}

export async function handle(d: Deps & { chat: Chat }, m: Incoming) {
  const now = (d.now ?? (() => new Date().toISOString()))();
  const config = loadConfig(d.root);
  const text = sanitize(m.text);
  const ts = m.ts ?? now;
  // Decide and record under the lock, a message's images to fetch with it; talk to Discord after it.
  const r = locked(d.root, () => {
    const told = loadTold(d.root);
    const r = route(m, { ideas: loadIdeas(d.root, d.log), config, off: isOff(d.root), now, told });
    if (r.kind === 'decline' && r.answer) writeAtomic(join(dir(d.root), 'told.json'), JSON.stringify(tell(told, `${r.reason}:${m.author.id}`, now)) + '\n');
    if (r.kind === 'new') {
      const id = nextId(ideaFiles(d.root).map(f => f.slice(0, -5)));
      // An id given back after a failed thread is clean for the next idea.
      dropInbox(d.root, id);
      const dl = downloadOf(d, m, ts, { kind: 'new', text: r.text });
      save(d.root, { id, thread: '', message: m.id, author: m.author, text: r.text, state: 'creating', created: now, updated: now, messages: [{ ts: now, by: m.author.name, text: r.text, id: m.id }], round: 1, dossier: [], ...(dl ? { downloads: [dl] } : {}) });
      return { ...r, id };
    }
    if (r.kind === 'answer' || r.kind === 'message' || r.kind === 'go' || r.kind === 'feedback') {
      const fresh = read(d.root, r.idea!.id);
      // Any allowed reply in the thread answers orch's open questions.
      const cur: Idea = { ...answer(fresh, ts), messages: [...fresh.messages ?? [], { ts, by: m.author.name, text, plan: visiblePlan(fresh, ts), id: m.id }] };
      const step = r.kind === 'go' ? 'go' : r.kind === 'feedback' ? 'reopen' : undefined;
      const next = step ? advance(cur, step, now) : cur;
      if (typeof next === 'string') { save(d.root, cur); return { kind: 'ignore' as const }; }
      const dl = downloadOf(d, m, ts, r.kind === 'answer' ? undefined : { kind: r.kind === 'message' ? 'msg' : r.kind, text: r.kind === 'go' ? 'go' : r.text });
      const fetching = (i: Idea): Idea => dl ? { ...i, downloads: [...i.downloads ?? [], dl] } : i;
      if (r.kind === 'answer') save(d.root, fetching(next));
      // Talk in a reopened round before its plan is feedback too, every message of it.
      else if (r.kind === 'message') save(d.root, fetching({ ...(reopenedTalk(next) ? entry(next, 'feedback', text, ts, m.author.name, m.id) : next), needsOrch: 'msg', needsAt: now }));
      else if (r.kind === 'go') save(d.root, fetching({ ...entry(next, 'go', `on plan v${next.planVersion}`, now, m.author.name, m.id), needsOrch: 'go', needsAt: now, goBy: m.author.id }));
      else save(d.root, fetching({ ...entry(next, 'feedback', text, ts, m.author.name, m.id), needsOrch: 'feedback', needsAt: now }));
      return { ...r, dl, ...(r.kind === 'feedback' ? { round: roundOf(next) } : {}) };
    }
    return r;
  });
  // A message with images reaches the feed once they are in, with their count; one without, right away.
  const announce = (id: string, dl: Download | undefined, line: string) => dl ? fetchDownload(d, id, dl) : feed(d.root, line, now);
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
    try { thread = await d.chat.createThread(m.id, threadName(r.id, r.text)); }
    catch (e) { locked(d.root, () => rmSync(file(d.root, r.id), { force: true })); throw e; }
    // Images are fetched only once the thread exists, so a failed thread leaves none behind.
    opened(d, r.id, thread, now);
    await react('👀', r.id);
    return;
  }
  const id = r.idea!.id;
  if (r.kind === 'answer') {
    if (r.dl) fetchDownload(d, id, r.dl);
    await d.chat.reply(m.thread!, r.text);
    update(d.root, id, said('orch', r.text, now));
    d.log(`idea bridge answered ${m.author.name} in ${id}: ${r.text.slice(0, 80)}`);
    return;
  }
  if (r.kind === 'message') return announce(id, r.dl, ideaLine(id, 'msg', m.author.name, r.text));
  if (r.kind === 'feedback') {
    announce(id, r.dl, ideaLine(id, 'feedback', m.author.name, r.text));
    d.log(`idea ${id}: feedback from ${m.author.name} reopens it as round ${r.round}`);
    return react('👀', id);
  }
  announce(id, r.dl, ideaLine(id, 'go', m.author.name, 'go'));
  d.log(`idea ${id}: go from ${m.author.name}`);
  await react('✅', id);
}

// The new-idea watcher line goes out now, or with the post's images once they are in.
function opened(d: Deps, id: string, thread: string, now: string) {
  const i = update(d.root, id, i => ({ ...i, thread, state: 'talk', needsOrch: 'new', needsAt: now }));
  const dl = owns(i, i.message);
  if (dl) fetchDownload(d, id, dl);
  else feed(d.root, ideaLine(id, 'new', i.author.name, i.text), now);
  d.log(`idea ${id} from ${i.author.name}: ${i.text.slice(0, 100)}`);
  return i;
}

// On daemon start: an idea left in creating (the bridge died while opening its thread) gets the thread that was
// opened, or is dropped so the post is handled again. Then every download still on an idea runs again.
export async function reconcile(d: Deps & { chat: Chat }) {
  const now = (d.now ?? (() => new Date().toISOString()))();
  for (const i of loadIdeas(d.root, d.log).filter(i => i.state === 'creating')) {
    const thread = await d.chat.findThread(i.message);
    if (thread) { opened(d, i.id, thread, now); continue; }
    locked(d.root, () => rmSync(file(d.root, i.id), { force: true }));
    d.log(`idea ${i.id} dropped: its thread was never opened (post ${i.message} by ${i.author.name})`);
  }
  // Images a stopped bridge had not fetched yet.
  for (const i of loadIdeas(d.root, d.log).filter(i => i.state !== 'creating')) for (const dl of i.downloads ?? []) fetchDownload(d, i.id, dl);
}

// Everything orch posts in an idea's thread ends with links to the other ideas it names.
const postIn = (root: string, chat: Chat, i: Idea, text: string, o?: ReplyOptions) => chat.reply(i.thread, withRelated(text, loadIdeas(root), i.id), o);

// A rename whose re-archive failed is logged and counted as left unarchived; any other failure throws.
async function rename(d: Deps, chat: Chat, what: string, thread: string, from: string, to: string): Promise<'renamed' | 'unarchived'> {
  try { await chat.renameThread(thread, to); }
  catch (e) {
    if (!(e instanceof RearchiveFailed)) throw e;
    d.log(`${what}: "${from}" -> "${to}", renamed, re-archive failed: ${e.message}`);
    return 'unarchived';
  }
  d.log(`${what}: "${from}" -> "${to}"`);
  return 'renamed';
}

// `idea title` and `impl title`: one bot message in the thread says the keywords, edited when they change (posted
// again when it is gone), then the thread is renamed. Keywords go first: a post unarchives an archived thread, and
// the rename archives it again. keep: stores the title as soon as the keywords message exists, so a rerun after a
// failed rename edits that message instead of posting a second one.
export async function retitle(d: Deps, chat: Chat, what: string, thread: { id: string; name: string }, want: { title: string; keywords: string[]; name: string }, had: Title | undefined, keep: (t: Title) => void): Promise<string> {
  if (isOff(d.root)) fail('the idea bridge is off (ideas/off); orch posts nothing in Discord while it is');
  const text = keywordsPost(want.keywords);
  let msg = had?.msg;
  if (!msg || keywordsPost(had!.keywords) !== text) {
    if (!(msg && await chat.edit(thread.id, msg, text))) msg = (await chat.reply(thread.id, text)).ids[0];
    d.log(`${what}: ${text}`);
  }
  keep({ title: want.title, keywords: want.keywords, ...(msg ? { msg } : {}) });
  const done = `titled "${want.name}", ${text}`;
  if (thread.name === want.name) return done;
  try { return await rename(d, chat, what, thread.id, thread.name, want.name) === 'renamed' ? done : `${done}; renamed but left unarchived`; }
  catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    d.log(`${what} rename failed: ${why}`);
    return fail(`keywords posted, rename to "${want.name}" failed: ${why}`);
  }
}

// `idea relabel`: every idea thread named the old way gets its id in front, one rename at a time.
async function relabel(d: Deps, chat: Chat): Promise<string> {
  const sleep = d.sleep ?? (ms => new Promise(r => setTimeout(r, ms)));
  const counts = { renamed: 0, labelled: 0, unarchived: 0, failed: 0 };
  let tried = false;
  for (const i of loadIdeas(d.root, d.log).filter(i => i.thread)) {
    try {
      const t = await chat.getThread(i.thread);
      if (!t) { d.log(`idea ${i.id} relabel: thread ${i.thread} is gone`); counts.failed++; continue; }
      if (labelled(i.id, t.name)) { counts.labelled++; continue; }
      if (tried) await sleep(RENAME_GAP_MS);
      tried = true;
      counts[await rename(d, chat, `idea ${i.id} relabel`, i.thread, t.name, labelName(i.id, t.name))]++;
    } catch (e) {
      d.log(`idea ${i.id} relabel failed: ${e instanceof Error ? e.message : e}`);
      counts.failed++;
    }
  }
  return `relabel: ${counts.renamed} renamed, ${counts.unarchived} renamed but left unarchived, ${counts.labelled} already labelled, ${counts.failed} failed`;
}

const workers = (root: string): { name: string; status: string; branch?: string }[] => { try { return JSON.parse(readFileSync(join(root, 'workers.json'), 'utf8')); } catch { return []; } };
const running = (root: string, name?: string) => !!name && workers(root).some(w => w.name === name && w.status === 'running');

const USAGE = `usage: orch idea list | off | on | relabel
       orch idea fake "<text>" --as <user> [--in <id>]   (mock adapter only)
       orch idea say <id> <text|file> | ask <id> <question file|text> [--recommend <text>] [--wait] | plan <id> <file|text> | start <id> | stage <id> <building|checking|deploying|playtesting> | ship <id> <changelog file|text> | close <id> [reason] [--force]
       orch idea park <id> <D-NN> | unpark <id>   (a building idea parked on an open decision holds no build slot)
       orch idea record <id> <file|text>   (dossier only, nothing is posted)
       orch idea title <id> <title, at most 8 words> --keywords a,b,c   (thread named "<id> · <title>", keywords posted once and edited after)
       files are read only from ideas/drafts/`;

// The text of a file under ideas/drafts/ named by a relative path without .., or with vision, of ideas/vision.md;
// null for any other argument.
export function draftText(root: string, a: string, vision = false): string | null {
  const rel = a && !isAbsolute(a) ? normalize(a) : '';
  if (!rel || a.split(/[\\/]/).includes('..')) return null;
  const f = join(root, rel);
  try {
    if (!statSync(f).isFile()) return null;
    const real = realpathSync(f);
    if (rel.startsWith(join('ideas', 'drafts') + sep) && real.startsWith(realpathSync(join(dir(root), 'drafts')) + sep)) return readFileSync(f, 'utf8').trim();
    if (vision && rel === join('ideas', 'vision.md') && real === join(realpathSync(dir(root)), 'vision.md')) return readFileSync(f, 'utf8').trim();
  } catch {}
  return null;
}
// A single argument naming a file under ideas/drafts/ is that file's text; anything else is the text itself, so a
// mistyped path can never post the config, secrets/ or a file outside orch.
export const textOf = (root: string, args: string[]): string => (args.length === 1 ? draftText(root, args[0]) : null) ?? args.join(' ').trim();

export async function idea(args: string[], d: Deps): Promise<string> {
  const [sub, id, ...rest] = args;
  const now = (d.now ?? (() => new Date().toISOString()))();
  const config = loadConfig(d.root);
  const chat = () => d.chat ?? chatFor(d.root, config, d.log);
  migrateAll(d.root, d.log);
  unparkSettled(d.root, d.log);
  if (sub === 'list' || !sub) {
    const all = loadIdeas(d.root, d.log);
    // reopened: a round after the first that has not shipped yet.
    const round = (i: Idea) => roundOf(i) < 2 ? '' : ` round ${roundOf(i)}${['shipped', 'closed'].includes(i.state) ? '' : ', reopened'}`;
    return [`bridge ${isOff(d.root) ? 'off' : 'on'}, adapter ${config.adapter}`,
      ...all.map(i => `${i.id} [${i.state}${round(i)}${i.worker ? ` ${i.worker}` : ''}${i.parked ? `, parked on ${i.parked}` : ''}] ${i.author.name}: ${i.title?.title ?? i.text.split('\n')[0].slice(0, 80)}${i.needsOrch ? ` (needs orch: ${i.needsOrch})` : ''}`)].join('\n');
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
    const m = c.post(as, text, thread, now);
    return `posted ${m.id} as ${as}${into ? ` in ${into}` : ''}`;
  }
  if (sub === 'relabel') return relabel(d, chat());
  if (!id) throw new Error(USAGE);
  const cur = loadIdeas(d.root, d.log).find(i => i.id === id) ?? fail(`no idea ${id}`);
  const check = (s: Step, i = cur) => { const next = advance(i, s, now); return typeof next === 'string' ? fail(next) : next; };
  const clock = d.now ?? (() => new Date().toISOString());
  // orch answered what was flagged before the post went out; a message that came in meanwhile still waits.
  const answered = (i: Idea, text: string, sentAt: string): Idea =>
    ({ ...said('orch', text, now)(i), ...(clears(i, sentAt) ? { needsOrch: undefined, needsAt: undefined } : {}) });
  // Checked before posting, and again under the lock after: the daemon may have moved the idea meanwhile.
  // then: what else the step writes, in the same locked update as the state.
  const post = async (s: Step, text: string, then: (i: Idea) => Idea = i => i, files: Attachment[] = []) => {
    check(s);
    const sentAt = clock();
    await postIn(d.root, chat(), cur, text, files.length ? { files } : {});
    return update(d.root, id, i => {
      const next = advance(i, s, now);
      if (typeof next === 'string') fail(`posted, but not recorded: ${next}`);
      return answered(then(next as Idea), text, sentAt);
    });
  };
  if (sub === 'ask') {
    // --recommend takes every word after it up to the next flag; the question is what comes before the flags.
    const wait = rest.includes('--wait');
    const at = rest.indexOf('--recommend');
    const words = rest.filter((a, n) => a !== '--wait' && (at < 0 || n < at));
    const recommend = at < 0 ? undefined : rest.slice(at + 1).filter(a => a !== '--wait').join(' ').trim();
    const question = textOf(d.root, words);
    if (!question || recommend === '') throw new Error(USAGE);
    check('say');
    await flushNotes(d.root, chat(), d.log, id, now);
    const text = askPost(cur.author.id, question, recommend, wait);
    const sentAt = clock();
    // Replies carry Discord's timestamps, so the question's time is its post's, as Discord says.
    const askedAt = (await postIn(d.root, chat(), cur, text, { ping: cur.author.id })).ts ?? sentAt;
    update(d.root, id, i => {
      // A reply that came in while the question went out answers it.
      const early = (i.messages ?? []).find(m => m.by !== 'orch' && m.ts > askedAt);
      const asked = { ...answered(i, text, sentAt), questions: [...i.questions ?? [],
        { askedAt, text: question, ...(recommend ? { recommend } : {}), ...(wait ? { wait } : {}) }] };
      return early ? answer(asked, early.ts) : asked;
    });
    d.log(`idea ${id} ask${wait ? ' (wait)' : ''}: ${question.slice(0, 120)}`);
    return `asked ${cur.author.name} in ${id}${recommend && !wait ? `; going with the recommendation in 10 minutes without an answer` : ''}`;
  }
  if (sub === 'title') {
    const want = parseTitle(rest, id);
    if (typeof want === 'string') return fail(`${want}\n${USAGE}`);
    if (!cur.thread) fail(`${id} has no thread yet`);
    const c = chat();
    const t = await c.getThread(cur.thread) ?? fail(`${id}'s thread is gone`);
    return retitle(d, c, `idea ${id} title`, { id: cur.thread, name: t.name }, want, cur.title, title => update(d.root, id, i => ({ ...i, title })));
  }
  if (sub === 'record') {
    const text = textOf(d.root, rest);
    if (!text) throw new Error(USAGE);
    update(d.root, id, i => entry(i, 'record', text, now));
    d.log(`idea ${id} record: ${text.split('\n')[0].slice(0, 100)}`);
    return `recorded in ${id}'s dossier (round ${roundOf(cur)})`;
  }
  const force = rest.includes('--force');
  const text = textOf(d.root, rest.filter(a => a !== '--force'));
  if (sub === 'say') {
    if (!text) throw new Error(USAGE);
    await flushNotes(d.root, chat(), d.log, id, now);
    await post('say', text);
    d.log(`idea ${id} say: ${text.slice(0, 120)}`);
    return `posted in ${id}`;
  }
  if (sub === 'plan') {
    if (!text) throw new Error(USAGE);
    // The old plan and any go on it are withdrawn first; the new one is approvable once its post is up.
    // From shipped, check starts the next round.
    update(d.root, id, i => ({ ...check('plan', i), state: 'talk', plan: undefined, goBy: undefined }));
    const sentAt = clock();
    await postIn(d.root, chat(), cur, planPost(text, cur.author.id), { ping: cur.author.id });
    // A go counts only for the version that was on screen; planAt is taken once the post is up.
    update(d.root, id, i => answered(entry({ ...check('plan', i), plan: text, planVersion: (i.planVersion ?? 0) + 1, planAt: clock() }, 'plan', `v${(i.planVersion ?? 0) + 1}\n\n${text}`, now), planPost(text, cur.author.id), sentAt));
    d.log(`idea ${id} plan posted: ${text.split('\n')[0].slice(0, 100)}`);
    return `plan posted in ${id}; waiting for go`;
  }
  if (sub === 'start') {
    // The building slot is taken under the lock, so two starts cannot both pass the limit.
    const sentAt = clock();
    const building = locked(d.root, () => {
      const fresh = loadIdeas(d.root, d.log);
      const me = fresh.find(i => i.id === id)!;
      const blocker = startBlocker(me, fresh, config, isOff(d.root), new Set(workers(d.root).filter(w => w.status === 'running').map(w => w.name)), openDecisions(fresh, d.root));
      if (blocker) fail(`not started: ${blocker}`);
      // A fresh name every build: a rebuild after ship never lands on a worker or branch that exists.
      const name = workerName(id, [...workers(d.root).map(w => w.name), ...me.builds ?? []]);
      // Notes left from an earlier build stay handled; this build's start with the next line.
      const i: Idea = { ...check('start', me), worker: name, builds: [...me.builds ?? [], name], stage: 'building', startedAt: now, notesSeen: readNotes(d.root, id).map(n => n.key) };
      save(d.root, i);
      return i;
    });
    const name = building.worker!;
    mkdirSync(progressDir(d.root, id), { recursive: true });
    try { d.run([config.repo, name, workerTask(building, progressDir(d.root, id), inboxFiles(d.root, building))]); }
    catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // run can fail after it made the worker (not ready, prompt stalled): the idea builds with it. The name was free
      // before this start, so a running worker with it is this start's.
      if (!running(d.root, name)) {
        update(d.root, id, i => i.state === 'building' && i.worker === name
          ? { ...i, state: 'approved', worker: undefined, builds: (i.builds ?? []).filter(b => b !== name), updated: now } : i);
        throw e;
      }
      d.log(`idea ${id} start: run reported "${msg.slice(0, 120)}", but worker ${name} exists; building with it`);
    }
    const branch = workers(d.root).find(w => w.name === name)?.branch ?? `orch/${name}`;
    update(d.root, id, i => entry(i, 'start', `worker ${name}, branch ${branch}, on ${config.repo}`, now));
    await postIn(d.root, chat(), cur, startPost());
    update(d.root, id, i => answered(i, startPost(), sentAt));
    d.log(`idea ${id} start: worker ${name} on ${config.repo}`);
    return `${id} building as worker ${name}`;
  }
  if (sub === 'stage') {
    const stage = rest[0] as Stage;
    if (!(stage in STAGES)) fail(`stage is one of ${Object.keys(STAGES).join(', ')}`);
    if (cur.state !== 'building') fail(`${id} is ${cur.state}; stages are for building ideas`);
    update(d.root, id, i => ({ ...i, stage, updated: now }));
    return `${id} stage ${stage}`;
  }
  if (sub === 'park') {
    const decision = rest[0] ?? fail(USAGE);
    // The decision is read under the lock, so a file removed meanwhile cannot park the idea.
    update(d.root, id, i => {
      const blocker = parkBlocker(i, decision, statusOf(d.root, decision));
      return blocker ? fail(`not parked: ${blocker}`) : { ...i, parked: decision };
    });
    d.log(`idea ${id} parked on ${decision}; its build slot is free until ${decision} is decided`);
    return `${id} parked on ${decision}`;
  }
  if (sub === 'unpark') {
    let was: string | undefined;
    update(d.root, id, i => (was = i.parked, i.parked ? { ...i, parked: undefined } : i));
    if (!was) return `${id} is not parked`;
    d.log(`idea ${id} unparked from ${was}`);
    return `${id} unparked`;
  }
  if (sub === 'ship') {
    if (!text) throw new Error(USAGE);
    // The changelog carries the newest note's media that has not gone out yet (the bridge posts notes only while an
    // idea builds), and every note so far counts as posted.
    const notes = readNotes(d.root, id);
    const fresh = notes.filter(n => !(cur.notesSeen ?? []).includes(n.key));
    const last = fresh.filter(n => n.media).at(-1);
    const m = last?.media ? mediaFile(d.root, id, last.media) : undefined;
    if (m && 'refused' in m) d.log(`idea ${id}: ship media ${last!.media} left out, ${m.refused}`);
    await post('ship', shipPost(text, config.liveUrl), i => entry({ ...i, notesSeen: notes.map(n => n.key) }, 'ship', text, now), m && 'file' in m ? [m.file] : []);
    d.log(`idea ${id} shipped: ${text.split('\n')[0].slice(0, 100)}`);
    return `changelog posted in ${id}`;
  }
  if (sub === 'close') {
    // A building idea's worker is cleaned up first, or the close is forced.
    if (cur.state === 'building' && running(d.root, cur.worker) && !force)
      fail(`not closed: ${id} is building with worker ${cur.worker}; clean it up first (orch cleanup ${cur.worker}) or close with --force`);
    const reason = text || 'done';
    await post('close', `Closing this idea: ${reason}`, i => closeInbox(d.root, entry({ ...i, closed: reason }, 'close', reason, now)));
    sweepInbox(d.root, id);
    d.log(`idea ${id} closed: ${reason}`);
    return `${id} closed`;
  }
  throw new Error(USAGE);
}

const fail = (msg: string): never => { throw new Error(msg); };

// The bridge calls this every minute, one call at a time: building ideas get a progress note or a stage pulse, and
// open questions time out or nudge orch.
export async function tick(d: Deps & { chat: Chat }) {
  const now = (d.now ?? (() => new Date().toISOString()))();
  unparkSettled(d.root, d.log);
  for (const i of loadIdeas(d.root, d.log)) {
    if (stale(i, now)) {
      const reason = `no message in ${STALE_DAYS} days`;
      update(d.root, i.id, x => {
        if (!stale(x, now)) return x;
        const next = advance(x, 'close', now);
        // Nobody answers a closed idea, so nothing stays flagged; a new message flags it again.
        return typeof next === 'string' ? x : closeInbox(d.root, entry({ ...next, closed: reason, needsOrch: undefined, needsAt: undefined }, 'close', `${reason}; nothing posted, a new message reopens it`, now));
      });
      sweepInbox(d.root, i.id);
      d.log(`idea ${i.id} closed quietly: ${reason}`);
      continue;
    }
    for (const due of dueQuestions(i, now)) {
      const q = i.questions![due.index];
      const fresh = () => (loadIdeas(d.root, d.log).find(x => x.id === i.id)?.questions ?? [])[due.index];
      if (due.kind === 'nudge') {
        let claimed = false;
        update(d.root, i.id, x => {
          const y = x.questions?.[due.index];
          if (!y || y.answered || y.timedOut || y.nudged) return x;
          claimed = true;
          return { ...x, needsOrch: 'unanswered', needsAt: now, questions: x.questions!.map((z, n) => n === due.index ? { ...z, nudged: now } : z) };
        });
        if (claimed) feed(d.root, ideaLine(i.id, 'unanswered', i.author.name, q.text), now);
        continue;
      }
      // An answer wins, checked right before the post and under the lock after it. timedOut is set only once the post
      // is out: a failed post is retried on the next tick, and ticks never overlap, so it goes out once.
      const open = (y?: Question) => !!y && !y.answered && !y.timedOut;
      if (!open(locked(d.root, fresh))) continue;
      const text = timeoutPost(q.recommend!);
      await postIn(d.root, d.chat, i, text);
      let won = false;
      update(d.root, i.id, x => {
        const posted = said('orch', text, now)(x);
        if (!open(x.questions?.[due.index])) return posted;
        won = true;
        return { ...posted, needsOrch: 'timeout', needsAt: now, questions: x.questions!.map((z, n) => n === due.index ? { ...z, timedOut: now } : z) };
      });
      if (!won) { d.log(`idea ${i.id}: an answer came in while the timeout posted; the answer wins`); continue; }
      feed(d.root, ideaLine(i.id, 'timeout', i.author.name, q.recommend!), now);
      d.log(`idea ${i.id}: no answer in 10 minutes, going with: ${q.recommend!.slice(0, 100)}`);
    }
    if (dueGoReminder(i, now) && dueGoReminder(locked(d.root, () => loadIdeas(d.root, d.log).find(x => x.id === i.id)) ?? i, now)) {
      // Counted once the post is out: a failed post is retried on the next tick.
      const text = goReminderPost(i.author.id);
      await postIn(d.root, d.chat, i, text, { ping: i.author.id });
      update(d.root, i.id, x => {
        const n = x.goReminders?.v === x.planVersion ? x.goReminders.n : 0;
        return { ...said('orch', text, now)(x), goReminders: { v: x.planVersion!, n: n + 1 } };
      });
      d.log(`idea ${i.id}: plan v${i.planVersion} still waiting for a go, reminded ${i.author.name}`);
    }
    const p = progress(i, readNotes(d.root, i.id), now);
    if (!p) continue;
    const seen = p.seen ? { notesSeen: p.seen } : {};
    if (!p.post) { update(d.root, i.id, x => ({ ...x, ...seen })); continue; }
    await postNote(d.root, d.chat, d.log, i, p.post, seen, now);
  }
  // Leftovers whose worker is gone, even if the idea reopened since; downloads whose record failed, again.
  for (const i of loadIdeas(d.root, d.log)) {
    if (i.leftovers?.length) sweepInbox(d.root, i.id);
    if (i.state !== 'creating') for (const dl of i.downloads ?? []) fetchDownload(d, i.id, dl);
  }
}


// One progress note into its idea's thread, media checked as always. Recorded once the post is out: a failed post
// leaves the note new, and the next tick (or the next flush) tries again.
async function postNote(root: string, chat: Chat, log: (s: string) => void, i: Idea, post: { text: string; media?: string }, seen: { notesSeen?: string[] }, now: string): Promise<void> {
  let files: Attachment[] = [];
  if (post.media) {
    const m = mediaFile(root, i.id, post.media);
    if ('file' in m) files = [m.file];
    else log(`idea ${i.id}: note media ${post.media} left out, ${m.refused}; posting the text alone`);
  }
  await postIn(root, chat, i, post.text, { files });
  update(root, i.id, x => ({ ...said('orch', post.text, now, files.length ? post.media : undefined)(x), ...seen }));
}

// Every progress note a building idea has not posted yet, oldest first, before orch says, asks or plans there:
// a question must never land above the work it asks about (I-73, 2026-11-06: the concepts never went out because
// the ask came first and kept the thread busy).
async function flushNotes(root: string, chat: Chat, log: (s: string) => void, id: string, now: string): Promise<number> {
  let n = 0;
  for (;;) {
    const i = loadIdeas(root, log).find(x => x.id === id);
    if (!i || i.state !== 'building' || !Array.isArray(i.notesSeen)) return n;
    const next = readNotes(root, id).find(x => !i.notesSeen!.includes(x.key));
    if (!next) return n;
    await postNote(root, chat, log, i, { text: next.text, ...(next.media ? { media: next.media } : {}) }, { notesSeen: [...i.notesSeen, next.key] }, now);
    n++;
  }
}
