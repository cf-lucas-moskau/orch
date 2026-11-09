// The decision queue page: npm run -s queue. Serves on 127.0.0.1 and the tailnet address only (ORCH_QUEUE_PORT, default 7390).
// It only reads the ledger; an answer goes to orch's own pane through `orch steer`, which logs it to log.md.
import { execFile, spawnSync } from 'node:child_process';
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { networkInterfaces } from 'node:os';
import { extname, join } from 'node:path';
import type { FeedEvent } from './board.ts';
import type { Worker } from './dispatch.ts';
import type { Idea } from './ideas.ts';
import { buildQueue, openedPrs, validAnswer, type Item, type Ledger } from './queue.ts';
import { orchPane } from './routines.ts';

const root = process.env.ORCH_DIR ?? join(import.meta.dirname, '..');
const port = Number(process.env.ORCH_QUEUE_PORT ?? 7390);
const read = (p: string, fallback = '') => { try { return readFileSync(join(root, p), 'utf8'); } catch { return fallback; } };
const list = (dir: string) => { try { return readdirSync(join(root, dir)); } catch { return []; } };
const json = <T>(p: string, fallback: T): T => { try { return JSON.parse(read(p)) as T; } catch { return fallback; } };
const MEDIA_EXT = /\.(png|jpe?g|gif|webp|mp4|webm|mov)$/i;

function feed(): FeedEvent[] {
  const out: FeedEvent[] = [];
  for (const f of list('feed').filter(f => f.endsWith('.jsonl')).sort().slice(-2))
    for (const line of read(join('feed', f)).split('\n')) {
      try { const e = JSON.parse(line); if (e?.sid && e?.event) out.push({ ...e, msg: e.msg ?? '', prompt: e.prompt ?? '', cwd: e.cwd ?? '' }); } catch { /* partial line */ }
    }
  return out;
}

// Never loadIdeas: it migrates and writes. This page only reads.
function ideas(): { ideas: Idea[]; files: Record<string, string[]> } {
  const all = list('ideas').filter(f => /^I-\d+\.json$/.test(f)).map(f => json<Idea | null>(join('ideas', f), null)).filter((i): i is Idea => !!i?.id);
  const files: Record<string, string[]> = {};
  for (const i of all) {
    const found = ['progress', 'inbox'].flatMap(d => list(join('ideas', d, i.id)).filter(f => MEDIA_EXT.test(f)).map(f => join(root, 'ideas', d, i.id, f)));
    files[i.id] = found.map(p => ({ p, t: statSync(p).mtimeMs })).sort((a, b) => a.t - b.t).map(x => x.p);
  }
  return { ideas: all, files };
}

// gh pr view per open PR of a running worker; open ones are asked again after a minute, merged and closed never.
const prCache = new Map<string, { state: string; at: number }>();
function prStates(log: string, workers: Worker[]): Record<string, string> {
  const out: Record<string, string> = {};
  const opened = openedPrs(log);
  for (const w of workers.filter(w => w.status === 'running')) {
    const url = opened.get(w.name)?.url;
    if (!url) continue;
    const c = prCache.get(url);
    if (c && (['MERGED', 'CLOSED'].includes(c.state) || Date.now() - c.at < 60_000)) { out[url] = c.state; continue; }
    const r = spawnSync('gh', ['pr', 'view', url, '--json', 'state', '-q', '.state'], { encoding: 'utf8', timeout: 15_000 });
    // A failed lookup counts as unknown (shown) and is retried after the same minute.
    prCache.set(url, { state: r.status === 0 ? r.stdout.trim() : '', at: Date.now() });
    out[url] = prCache.get(url)!.state;
  }
  return out;
}

function queue(): Item[] {
  const id = ideas();
  const workers = json<Worker[]>('workers.json', []), log = read('log.md');
  const ledger: Ledger = {
    root,
    decisions: list('decisions').filter(f => /^D-\d+\.md$/.test(f)).map(f => ({ id: f.slice(0, -3), md: read(join('decisions', f)) })),
    workers, feed: feed(), ideas: id.ideas, ideaFiles: id.files, log, reviews: list('reviews'), prStates: prStates(log, workers),
  };
  return buildQueue(ledger).map(i => ({ ...i, media: i.media.filter(p => existsSync(p)), docs: i.docs.filter(p => existsSync(p)) }));
}

// What this server already sent, so a second device sees it and nobody answers twice. Cleared when the item leaves the queue.
const sent = new Map<string, { text: string; at: string }>();

const run = (cmd: string, args: string[], timeout: number) => new Promise<{ code: number; out: string }>(res =>
  execFile(cmd, args, { cwd: root, encoding: 'utf8', timeout, maxBuffer: 1 << 24 }, (err, stdout, stderr) =>
    res({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: `${stdout}${stderr}`.trim() })));

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
const hosts = ['127.0.0.1', ...tailnetIps()];
const magicDns = (() => {
  const r = spawnSync('tailscale', ['status', '--json'], { encoding: 'utf8', timeout: 5000 });
  try { return String(JSON.parse(r.stdout).Self?.DNSName ?? '').replace(/\.$/, ''); } catch { return ''; }
})();
// A Host header we serve; anything else is a rebinding attempt or a stray proxy.
const okHost = (h = '') => {
  const name = h.replace(/:\d+$/, '');
  return h.endsWith(`:${port}`) && (hosts.includes(name) || name === 'localhost' || (!!magicDns && (name === magicDns || name === magicDns.split('.')[0])));
};

const TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime' };

function sendFile(req: IncomingMessage, res: ServerResponse, path: string, type: string) {
  const size = statSync(path).size;
  const range = req.headers.range?.match(/^bytes=(\d*)-(\d*)$/);
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start > end || start >= size) { res.writeHead(416, { 'content-range': `bytes */${size}` }); return res.end(); }
    res.writeHead(206, { 'content-type': type, 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1 });
    return createReadStream(path, { start, end }).pipe(res);
  }
  res.writeHead(200, { 'content-type': type, 'accept-ranges': 'bytes', 'content-length': size });
  createReadStream(path).pipe(res);
}

const body = (req: IncomingMessage) => new Promise<string>((res, rej) => {
  let s = '';
  req.on('data', c => { s += c; if (s.length > 20_000) rej(new Error('too large')); });
  req.on('end', () => res(s));
  req.on('error', rej);
});
const reply = (res: ServerResponse, code: number, data: unknown) => {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
};

async function handle(req: IncomingMessage, res: ServerResponse) {
  if (!okHost(req.headers.host)) return reply(res, 421, { error: 'unknown host' });
  const url = new URL(req.url ?? '/', 'http://x');
  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(readFileSync(join(import.meta.dirname, 'queue.html')));
  }
  if (req.method === 'GET' && url.pathname === '/api/queue') {
    const items = queue();
    for (const k of sent.keys()) if (!items.some(i => i.key === k)) sent.delete(k);
    return reply(res, 200, { items: items.map(i => ({ ...i, sent: sent.get(i.key) })), at: new Date().toISOString() });
  }
  // Only files the queue itself names, so the page can't be turned into a file reader.
  if (req.method === 'GET' && (url.pathname === '/media' || url.pathname === '/doc')) {
    const p = url.searchParams.get('p') ?? '';
    const items = queue();
    const allowed = items.some(i => (url.pathname === '/media' ? i.media : i.docs).includes(p));
    if (!allowed || !existsSync(p)) return reply(res, 404, { error: 'not in the queue' });
    return url.pathname === '/media' ? sendFile(req, res, p, TYPES[extname(p).toLowerCase()] ?? 'application/octet-stream') : sendFile(req, res, p, 'text/plain; charset=utf-8');
  }
  if (req.method === 'POST' && url.pathname === '/api/answer') {
    // A custom header forces a CORS preflight this server never grants, so no other site can post here.
    if (req.headers['x-orch'] !== 'queue' || (req.headers.origin && !okHost(req.headers.origin.replace(/^https?:\/\//, ''))))
      return reply(res, 403, { error: 'forbidden' });
    let a: { key?: string; text?: string };
    try { a = JSON.parse(await body(req)); } catch { return reply(res, 400, { error: 'bad body' }); }
    const item = queue().find(i => i.key === a.key);
    if (!item) return reply(res, 404, { error: `${a.key} is no longer in the queue` });
    const text = String(a.text ?? '').trim();
    if (!validAnswer(item, text)) return reply(res, 400, { error: 'that answer does not match the item' });
    const r = await tellOrch(text);
    if (!r.ok) return reply(res, 502, { error: r.msg });
    sent.set(item.key, { text, at: new Date().toLocaleTimeString('sv-SE').slice(0, 5) });
    return reply(res, 200, { ok: true, msg: r.msg });
  }
  reply(res, 404, { error: 'not found' });
}

for (const h of hosts)
  createServer((req, res) => void handle(req, res).catch(e => reply(res, 500, { error: String(e?.message ?? e) })))
    .listen(port, h, () => console.log(`queue on http://${h}:${port}`));
