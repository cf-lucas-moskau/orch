// The decision queue page: npm run -s queue. Serves on 127.0.0.1 and the tailnet address only (ORCH_QUEUE_PORT, default 7390).
// It only reads the ledger; an answer goes to orch's own pane through `orch steer`, which logs it to log.md.
// Tailnet requests need a token cookie (secrets/queue-token), set by a one-time login link printed to stdout; localhost needs none.
import { execFile, spawnSync } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { networkInterfaces } from 'node:os';
import { extname, join } from 'node:path';
import type { FeedEvent } from './board.ts';
import type { Worker } from './dispatch.ts';
import type { Idea } from './ideas.ts';
import { buildQueue, checkAnswer, openedPrs, type Item, type Ledger } from './queue.ts';
import { orchPane } from './routines.ts';

const root = process.env.ORCH_DIR ?? join(import.meta.dirname, '..');
const port = Number(process.env.ORCH_QUEUE_PORT ?? 7390);
const read = (p: string, fallback = '') => { try { return readFileSync(join(root, p), 'utf8'); } catch { return fallback; } };
const list = (dir: string) => { try { return readdirSync(join(root, dir)); } catch { return []; } };
const json = <T>(p: string, fallback: T): T => { try { return JSON.parse(read(p)) as T; } catch { return fallback; } };
const mtime = (p: string) => { try { return statSync(p).mtimeMs; } catch { return null; } };
const MEDIA_EXT = /\.(png|jpe?g|gif|webp|mp4|webm|mov)$/i;

// The last two days, and every day since the oldest running worker started, so a question left unanswered for days stays.
// Only running workers' events are kept: they are all the queue reads from the feed.
function feed(workers: Worker[]): FeedEvent[] {
  const running = workers.filter(w => w.status === 'running');
  const sids = new Set(running.map(w => w.sid).filter(Boolean)), trees = new Set(running.map(w => w.worktree));
  const files = list('feed').filter(f => /^\d{4}-\d\d-\d\d\.jsonl$/.test(f)).sort();
  const since = running.map(w => (w.started ?? '').slice(0, 10)).filter(Boolean).sort()[0] ?? '9999';
  const out: FeedEvent[] = [];
  for (const f of files.filter((f, i) => i >= files.length - 2 || f.slice(0, 10) >= since))
    for (const line of read(join('feed', f)).split('\n')) {
      try {
        const e = JSON.parse(line);
        if (e?.sid && e?.event && (sids.has(e.sid) || trees.has(e.cwd))) out.push({ ...e, msg: e.msg ?? '', prompt: e.prompt ?? '', cwd: e.cwd ?? '' });
      } catch { /* partial line */ }
    }
  return out;
}

// Never loadIdeas: it migrates and writes. This page only reads.
function ideas(): { ideas: Idea[]; files: Record<string, string[]> } {
  const all = list('ideas').filter(f => /^I-\d+\.json$/.test(f)).map(f => json<Idea | null>(join('ideas', f), null)).filter((i): i is Idea => !!i?.id);
  const files: Record<string, string[]> = {};
  for (const i of all) {
    const found = ['progress', 'inbox'].flatMap(d => list(join('ideas', d, i.id)).filter(f => MEDIA_EXT.test(f)).map(f => join(root, 'ideas', d, i.id, f)));
    // A file can vanish between the listing and the stat (an idea closing deletes its inbox).
    files[i.id] = found.map(p => ({ p, t: mtime(p) })).filter((x): x is { p: string; t: number } => x.t !== null).sort((a, b) => a.t - b.t).map(x => x.p);
  }
  return { ideas: all, files };
}

// GitHub's PR states, refreshed in the background every minute and never asked for in a request.
const prStates: Record<string, string> = {};
let prRefreshing = false;
async function refreshPrs() {
  if (prRefreshing) return;
  prRefreshing = true;
  try {
    const opened = openedPrs(read('log.md'));
    const urls = json<Worker[]>('workers.json', []).filter(w => w.status === 'running').map(w => opened.get(w.name)?.url).filter((u): u is string => !!u);
    await Promise.all(urls.filter(u => !['MERGED', 'CLOSED'].includes(prStates[u] ?? '')).map(async u => {
      const r = await run('gh', ['pr', 'view', u, '--json', 'state', '-q', '.state'], 15_000);
      // A failed lookup leaves the state unknown, which shows the PR.
      prStates[u] = r.code === 0 ? r.out.trim() : prStates[u] ?? '';
    }));
  } finally { prRefreshing = false; }
}

// The files the last queue named; /media and /doc serve only these.
let allowed: { media: Set<string>; docs: Set<string> } | null = null;
function queue(): Item[] {
  const id = ideas();
  const workers = json<Worker[]>('workers.json', []);
  const ledger: Ledger = {
    root,
    decisions: list('decisions').filter(f => /^D-\d+\.md$/.test(f)).map(f => ({ id: f.slice(0, -3), md: read(join('decisions', f)) })),
    workers, feed: feed(workers), ideas: id.ideas, ideaFiles: id.files, log: read('log.md'), prStates,
  };
  const items = buildQueue(ledger).map(i => ({ ...i, media: i.media.filter(p => existsSync(p)), docs: i.docs.filter(p => existsSync(p)) }));
  allowed = { media: new Set(items.flatMap(i => i.media)), docs: new Set(items.flatMap(i => i.docs)) };
  return items;
}

// What this server sent, so a second device sees it and nobody answers twice; cleared once the item leaves the queue.
// sending: answers on their way, so two at once for one item are refused.
const sent = new Map<string, { text: string; at: string }>();
const sending = new Set<string>();

function run(cmd: string, args: string[], timeout: number) {
  return new Promise<{ code: number; out: string }>(res =>
    execFile(cmd, args, { cwd: root, encoding: 'utf8', timeout, maxBuffer: 1 << 24 }, (err, stdout, stderr) =>
      res({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: `${stdout}${stderr}`.trim() })));
}

// The same path the deck's keys take: the text lands in orch's pane as the user's own words. `orch steer` refuses
// while the user has a draft in that pane and logs every send to log.md.
async function tellOrch(text: string): Promise<{ ok: boolean; msg: string }> {
  const l = await run('herdr', ['agent', 'list'], 10_000);
  let agents = [];
  try { agents = JSON.parse(l.out).result?.agents ?? []; } catch { return { ok: false, msg: `herdr agent list failed: ${l.out.slice(0, 200)}` }; }
  const o = orchPane(agents, root);
  if (!o) return { ok: false, msg: 'orch is not running' };
  const r = await run(process.execPath, [...process.execArgv, join(import.meta.dirname, 'orch.ts'), 'steer', o.pane_id, text.replace(/\s*\n\s*/g, ' ')], 120_000);
  return { ok: r.code === 0, msg: r.out };
}

function tailnetIps(): string[] {
  return Object.values(networkInterfaces()).flat()
    .filter(a => a && a.family === 'IPv4' && /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a.address))
    .map(a => a!.address);
}
const LOCAL = '127.0.0.1';
const hosts = [LOCAL, ...tailnetIps()];
const magicDns = (() => {
  const r = spawnSync('tailscale', ['status', '--json'], { encoding: 'utf8', timeout: 5000 });
  try { return String(JSON.parse(r.stdout).Self?.DNSName ?? '').replace(/\.$/, ''); } catch { return ''; }
})();
// A Host header we serve; anything else is a rebinding attempt or a stray proxy.
const okHost = (h = '') => {
  const name = h.replace(/:\d+$/, '');
  return h.endsWith(`:${port}`) && (hosts.includes(name) || name === 'localhost' || (!!magicDns && (name === magicDns || name === magicDns.split('.')[0])));
};

// The tailnet token: random, kept in secrets/ (gitignored), the same across restarts so a set cookie keeps working.
const token = (() => {
  const file = join(root, 'secrets', 'queue-token');
  const have = (() => { try { return readFileSync(file, 'utf8').trim(); } catch { return ''; } })();
  if (/^[0-9a-f]{64}$/.test(have)) return have;
  const t = randomBytes(32).toString('hex');
  mkdirSync(join(root, 'secrets'), { recursive: true });
  writeFileSync(file, `${t}\n`, { mode: 0o600 });
  return t;
})();
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const COOKIE = 'orch_queue';
const cookieOf = (req: IncomingMessage) => req.headers.cookie?.split(/;\s*/).find(c => c.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1) ?? '';
// One login code at a time; used once, then a new one is printed for the next device.
let loginCode = '';
function newLoginLink() {
  loginCode = randomBytes(16).toString('hex');
  const host = magicDns || hosts.find(h => h !== LOCAL);
  if (host) console.log(`queue login link (one use): http://${host}:${port}/login?code=${loginCode}`);
}

const TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime' };

function sendFile(req: IncomingMessage, res: ServerResponse, path: string, type: string) {
  let size: number;
  try { size = statSync(path).size; } catch { return reply(res, 404, { error: 'gone' }); }
  const range = req.headers.range?.match(/^bytes=(\d*)-(\d*)$/);
  let start = 0, end = size - 1, code = 200;
  if (range && (range[1] || range[2])) {
    start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start > end || start >= size) { res.writeHead(416, { 'content-range': `bytes */${size}` }); return res.end(); }
    code = 206;
  }
  const stream = createReadStream(path, size ? { start, end } : {});
  stream.on('error', () => res.headersSent ? res.destroy() : reply(res, 404, { error: 'gone' }));
  res.on('close', () => stream.destroy());
  stream.once('open', () => {
    res.writeHead(code, { 'content-type': type, 'accept-ranges': 'bytes', 'content-length': size ? end - start + 1 : 0, ...(code === 206 ? { 'content-range': `bytes ${start}-${end}/${size}` } : {}) });
    stream.pipe(res);
  });
}

const body = (req: IncomingMessage) => new Promise<string>((res, rej) => {
  let s = '';
  req.on('data', c => { s += c; if (s.length > 20_000) { rej(new Error('too large')); req.destroy(); } });
  req.on('end', () => res(s));
  req.on('error', rej);
});
function reply(res: ServerResponse, code: number, data: unknown) {
  if (res.headersSent) return res.destroy();
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}

async function handle(local: boolean, req: IncomingMessage, res: ServerResponse) {
  if (!okHost(req.headers.host)) return reply(res, 421, { error: 'unknown host' });
  const url = new URL(req.url ?? '/', 'http://x');
  if (req.method === 'GET' && url.pathname === '/login') {
    const code = url.searchParams.get('code') ?? '';
    if (!loginCode || !same(code, loginCode)) return reply(res, 403, { error: 'that login link was used already or is old; ask orch for the new one in ~/Library/Logs/orch.queue.log' });
    newLoginLink();
    res.writeHead(303, { location: '/', 'set-cookie': `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000` });
    return res.end();
  }
  // Tailnet requests carry the token; localhost needs none.
  if (!local && !same(cookieOf(req), token)) return reply(res, 401, { error: 'open the one-time login link from ~/Library/Logs/orch.queue.log first' });
  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(readFileSync(join(import.meta.dirname, 'queue.html')));
  }
  if (req.method === 'GET' && url.pathname === '/api/queue') {
    const items = queue();
    for (const k of sent.keys()) if (!items.some(i => i.key === k)) sent.delete(k);
    return reply(res, 200, { items: items.map(i => ({ ...i, sent: sent.get(i.key) })), at: new Date().toISOString() });
  }
  // Only files the queue named the last time it was built, so the page can't be turned into a file reader.
  if (req.method === 'GET' && (url.pathname === '/media' || url.pathname === '/doc')) {
    const p = url.searchParams.get('p') ?? '';
    const a = allowed ?? (queue(), allowed!);
    if (!(url.pathname === '/media' ? a.media : a.docs).has(p)) return reply(res, 404, { error: 'not in the queue' });
    return sendFile(req, res, p, url.pathname === '/media' ? TYPES[extname(p).toLowerCase()] ?? 'application/octet-stream' : 'text/plain; charset=utf-8');
  }
  if (req.method === 'POST' && url.pathname === '/api/answer') {
    // A custom header forces a CORS preflight this server never grants, so no other site can post here.
    if (req.headers['x-orch'] !== 'queue' || (req.headers.origin && !okHost(req.headers.origin.replace(/^https?:\/\//, ''))))
      return reply(res, 403, { error: 'forbidden' });
    let a: { key?: string; rev?: string; text?: string };
    try { a = JSON.parse(await body(req)); } catch { return reply(res, 400, { error: 'bad body' }); }
    const c = checkAnswer(queue(), a, { sending, sent });
    if ('error' in c) return reply(res, c.status, { error: c.error });
    sending.add(c.item.key);
    try {
      const r = await tellOrch(c.text);
      if (!r.ok) return reply(res, 502, { error: r.msg });
      sent.set(c.item.key, { text: c.text, at: new Date().toLocaleTimeString('sv-SE').slice(0, 5) });
      return reply(res, 200, { ok: true, msg: r.msg });
    } finally { sending.delete(c.item.key); }
  }
  reply(res, 404, { error: 'not found' });
}

for (const h of hosts) {
  const server = createServer((req, res) => void handle(h === LOCAL, req, res).catch(e => reply(res, 500, { error: String(e?.message ?? e) })));
  // Without localhost the page is useless and the watcher must see it down; a tailnet address that fails is logged and skipped.
  server.on('error', e => {
    console.error(`Error: queue cannot listen on ${h}:${port}: ${e.message}`);
    if (h === LOCAL) process.exit(1);
  });
  server.listen(port, h, () => console.log(`queue on http://${h}:${port}`));
}
newLoginLink();
void refreshPrs();
setInterval(() => void refreshPrs(), 60_000);
