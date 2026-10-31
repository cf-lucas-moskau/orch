// Chat adapters for the idea bridge. mock: JSONL files under ideas/mock/ (inbox written by `orch idea fake`,
// outbox read by tests and people). discord: the discord.js gateway for incoming messages, REST for posting.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { MAX_MEDIA, mediaOk, serial, split, type Config, type Incoming } from './ideas.ts';

export interface Chat {
  onMessage(handler: (m: Incoming) => Promise<void>): void;
  // Connects and catches up on what was posted while the bridge was down.
  start(): Promise<void>;
  stop(): Promise<void>;
  // Opens a thread on a top-level post in the ideas channel and returns the thread's id.
  createThread(message: string, name: string): Promise<string>;
  // The thread already opened on a top-level post, if any.
  findThread(message: string): Promise<string | null>;
  // target is a thread or channel id; long text goes out as several messages, files with the last.
  // ping: the one user id a mention in the text may notify; without it nobody is pinged.
  // Resolves to the time the first message was posted, as the chat says.
  reply(target: string, text: string, o?: ReplyOptions): Promise<Posted>;
  react(target: string, message: string, emoji: string): Promise<void>;
}

// files: media already read and checked by the caller; the adapter never reads a path.
export type Attachment = { name: string; data: Buffer };
export type ReplyOptions = { files?: Attachment[]; ping?: string };
export type Posted = { ts?: string };
export type Outgoing =
  | { kind: 'thread'; message: string; thread: string; name: string }
  | { kind: 'reply'; target: string; text: string; files?: string[]; ping?: string }
  | { kind: 'react'; target: string; message: string; emoji: string };

export type OnError = (msg: string) => void;
const toConsole: OnError = msg => console.error(new Date().toISOString(), msg);
const why = (e: unknown) => e instanceof Error ? e.message : String(e);

// Readers never see a half-written file.
export function writeAtomic(file: string, text: string) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

const lines = (file: string) => existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];

export class MockChat implements Chat {
  private handler: (m: Incoming) => Promise<void> = async () => {};
  private timer?: NodeJS.Timeout;
  readonly dir: string;
  private channel: string;
  private onError: OnError;
  private now: () => string;
  constructor(root: string, channel: string, onError: OnError = toConsole, now = () => new Date().toISOString()) {
    this.channel = channel;
    this.onError = onError;
    this.now = now;
    this.dir = join(root, 'ideas', 'mock');
    mkdirSync(this.dir, { recursive: true });
  }
  private out(o: Outgoing) { const ts = this.now(); appendFileSync(join(this.dir, 'outbox.jsonl'), JSON.stringify({ ts, ...o }) + '\n'); return ts; }
  onMessage(handler: (m: Incoming) => Promise<void>) { this.handler = handler; }
  // Handles inbox lines not seen yet; the count seen survives restarts. A line that fails is reported and skipped.
  async poll() {
    const seenFile = join(this.dir, 'inbox.seen');
    const seen = Number(existsSync(seenFile) ? readFileSync(seenFile, 'utf8') : 0) || 0;
    const all = lines(join(this.dir, 'inbox.jsonl'));
    for (let i = seen; i < all.length; i++) {
      writeFileSync(seenFile, String(i + 1));
      try { await this.handler(JSON.parse(all[i])); }
      catch (e) { this.onError(`mock inbox line ${i + 1} failed: ${why(e)}: ${all[i].slice(0, 200)}`); }
    }
  }
  async start() {
    let busy = false;
    this.timer = setInterval(async () => {
      if (busy) return;
      busy = true;
      try { await this.poll(); } catch (e) { this.onError(`mock inbox poll failed: ${why(e)}`); } finally { busy = false; }
    }, 1000);
  }
  async stop() { clearInterval(this.timer); }
  async createThread(message: string, name: string) {
    const thread = `t-${message}`;
    this.out({ kind: 'thread', message, thread, name });
    return thread;
  }
  async findThread(message: string) {
    const t = this.outbox().find(o => o.kind === 'thread' && o.message === message);
    return t?.kind === 'thread' ? t.thread : null;
  }
  async reply(target: string, text: string, o: ReplyOptions = {}): Promise<Posted> {
    const parts = split(text);
    const ts = parts.map((t, n) => this.out({
      kind: 'reply', target, text: t,
      ...(o.files?.length && n === parts.length - 1 ? { files: o.files.map(f => f.name) } : {}),
      ...(o.ping ? { ping: o.ping } : {}),
    }));
    return { ts: ts[0] };
  }
  async react(target: string, message: string, emoji: string) { this.out({ kind: 'react', target, message, emoji }); }
  outbox(): (Outgoing & { ts: string })[] { return lines(join(this.dir, 'outbox.jsonl')).map(l => JSON.parse(l)); }
  // `orch idea fake`: post as someone, at the top level or inside an idea's thread. Mock user ids are their names.
  post(as: string, text: string, thread?: string, ts = new Date().toISOString()): Incoming {
    const file = join(this.dir, 'inbox.jsonl');
    const m: Incoming = { id: `m${lines(file).length + 1}`, channel: thread ?? this.channel, ...(thread ? { thread } : {}), author: { id: as, name: as }, text, ts };
    appendFileSync(file, JSON.stringify(m) + '\n');
    return m;
  }
}

// Mentions are never pinged, whatever the text says.
const NO_PINGS = { parse: [] };
// Discord API v10 paths, the same strings discord.js's Routes builds.
const route = {
  channel: (c: string) => `/channels/${c}`,
  messages: (c: string) => `/channels/${c}/messages`,
  message: (c: string, m: string) => `/channels/${c}/messages/${m}`,
  threads: (c: string, m: string) => `/channels/${c}/messages/${m}/threads`,
  reaction: (c: string, m: string, emoji: string) => `/channels/${c}/messages/${m}/reactions/${encodeURIComponent(emoji)}/@me`,
  activeThreads: (g: string) => `/guilds/${g}/threads/active`,
};
type Raw = { id: string; channel_id: string; author: { id: string; username: string; bot?: boolean }; content: string; timestamp?: string };
const byId = (a: { id: string }, b: { id: string }) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1);

export type DiscordOptions = { token: string; channel: string; cursorFile: string; onError?: OnError; lib?: any; retryMs?: number };

// Message ids grow over time, so the last handled id per channel and thread (the cursor) tells what came after.
export class DiscordChat implements Chat {
  private handler: (m: Incoming) => Promise<void> = async () => {};
  private client: any;
  private rest: any;
  private o: DiscordOptions & { onError: OnError };
  // Live messages held while a catch-up runs (from before the first one too), so a newer one never moves a cursor
  // past older ones. A channel or thread whose message failed is stalled: nothing after it is handled live, and the
  // next catch-up starts again from its cursor.
  private held: Incoming[] | null = [];
  private stalled = new Set<string>();
  private retry?: NodeJS.Timeout;
  constructor(o: DiscordOptions) { this.o = { onError: toConsole, ...o }; }
  // o.lib stands in for the discord.js module in tests.
  private async lib(): Promise<any> {
    if (this.o.lib) return this.o.lib;
    try { return await import('discord.js'); }
    catch { throw new Error('discord.js is not installed: run npm install in orch'); }
  }
  private async api() {
    if (!this.rest) {
      const { REST } = await this.lib();
      this.rest = new REST({ version: '10' }).setToken(this.o.token);
    }
    return this.rest;
  }
  private cursor(): Record<string, string> { try { return JSON.parse(readFileSync(this.o.cursorFile, 'utf8')); } catch { return {}; } }
  private move(key: string, id: string) { writeAtomic(this.o.cursorFile, JSON.stringify({ ...this.cursor(), [key]: id }) + '\n'); }
  onMessage(handler: (m: Incoming) => Promise<void>) { this.handler = handler; }

  // The cursor moves only past a message the handler took.
  private deliver = serial(async (m: Incoming) => {
    const key = m.thread ?? m.channel;
    if (this.stalled.has(key)) return;
    const last = this.cursor()[key];
    if (last && BigInt(m.id) <= BigInt(last)) return;
    try { await this.handler(m); }
    catch (e) {
      this.stalled.add(key);
      this.o.onError(`discord message ${m.id} failed, retried from there on the next catch-up: ${why(e)}`);
      this.retryLater();
      return;
    }
    this.move(key, m.id);
  });

  private retryLater() {
    if (this.retry) return;
    this.retry = setTimeout(() => { this.retry = undefined; void this.catchUp(); }, this.o.retryMs ?? 60_000);
    this.retry.unref?.();
  }

  private catchUp = serial(async () => {
    this.held ??= [];
    this.stalled.clear();
    try { await this.backfill(); }
    catch (e) { this.o.onError(`discord catch-up failed, retrying: ${why(e)}`); this.retryLater(); }
    finally { const held = this.held ?? []; this.held = null; for (const m of held.sort(byId)) void this.deliver(m); }
  });

  private incoming(r: Raw, thread: boolean): Incoming | null {
    if (r.author.bot) return null;
    return { id: r.id, channel: r.channel_id, ...(thread ? { thread: r.channel_id } : {}), author: { id: r.author.id, name: r.author.username }, text: r.content, ...(r.timestamp ? { ts: new Date(r.timestamp).toISOString() } : {}) };
  }

  // The channel from its cursor, and every active thread under it from its cursor or its start. On a first start the
  // channel's newest message becomes its cursor, so history is never replayed and a restart catches up from there.
  async backfill() {
    const rest = await this.api();
    const ch = await rest.get(route.channel(this.o.channel));
    if (!this.cursor()[this.o.channel]) this.move(this.o.channel, ch.last_message_id ?? this.o.channel);
    const cursor = this.cursor();
    const active = await rest.get(route.activeThreads(ch.guild_id));
    const targets = [
      { id: this.o.channel, thread: false, after: cursor[this.o.channel] },
      ...(active.threads ?? []).filter((t: any) => t.parent_id === this.o.channel).map((t: any) => ({ id: t.id, thread: true, after: cursor[t.id] ?? t.id })),
    ];
    for (const t of targets) {
      for (let after = t.after; ;) {
        const page: Raw[] = (await rest.get(route.messages(t.id), { query: new URLSearchParams({ after, limit: '100' }) })).sort(byId);
        for (const r of page) { const m = this.incoming(r, t.thread); if (m) await this.deliver(m); }
        if (page.length < 100 || this.stalled.has(t.id)) break;
        after = page.at(-1)!.id;
      }
    }
  }

  async start() {
    const lib = await this.lib();
    const { Client, GatewayIntentBits } = lib;
    this.client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
    this.client.on('error', (e: unknown) => this.o.onError(`discord client error: ${why(e)}`));
    this.client.on('shardError', (e: unknown) => this.o.onError(`discord shard error: ${why(e)}`));
    this.client.on('messageCreate', (m: any) => {
      const inThread = m.channel.isThread();
      if ((inThread ? m.channel.parentId : m.channelId) !== this.o.channel) return;
      const i = this.incoming({ id: m.id, channel_id: m.channelId, author: m.author, content: m.content, timestamp: m.createdTimestamp ? new Date(m.createdTimestamp).toISOString() : undefined }, inThread);
      if (!i) return;
      if (this.held) this.held.push(i); else void this.deliver(i);
    });
    // Every ready, the first and each new session after a lost connection, catches up on what was missed.
    for (const ev of [lib.Events?.ClientReady ?? 'ready', 'shardReady']) this.client.on(ev, () => void this.catchUp());
    await this.client.login(this.o.token);
  }
  async stop() { clearTimeout(this.retry); await this.client?.destroy(); }
  async createThread(message: string, name: string) {
    const t = await (await this.api()).post(route.threads(this.o.channel, message), { body: { name, auto_archive_duration: 10080 } });
    return t.id as string;
  }
  async findThread(message: string) {
    try { return (await (await this.api()).get(route.message(this.o.channel, message))).thread?.id ?? null; }
    catch (e: any) { if (e?.status === 404) return null; throw e; }
  }
  // An attachment over Discord's 8 MB limit, or not an allowed media type by its bytes, is left out with a log line;
  // the text still goes. The buffer checked is the buffer sent.
  async reply(target: string, text: string, o: ReplyOptions = {}): Promise<Posted> {
    const files = (o.files ?? []).filter(f => {
      if (f.data.length > MAX_MEDIA) { this.o.onError(`attachment ${f.name} left out: ${(f.data.length / 1048576).toFixed(1)} MB is over 8 MB`); return false; }
      if (!mediaOk(f.name, f.data)) { this.o.onError(`attachment ${f.name} left out: not a png, jpg, gif, mp4 or webm file`); return false; }
      return true;
    });
    const allowed_mentions = o.ping ? { parse: [], users: [o.ping] } : NO_PINGS;
    const parts = split(text);
    let ts: string | undefined;
    for (const [n, content] of parts.entries()) {
      const last = n === parts.length - 1 && files.length > 0;
      const sent = await (await this.api()).post(route.messages(target), {
        body: { content, allowed_mentions, ...(last ? { attachments: files.map((f, id) => ({ id, filename: f.name })) } : {}) },
        ...(last ? { files } : {}),
      });
      if (n === 0 && typeof sent?.timestamp === 'string') ts = new Date(sent.timestamp).toISOString();
    }
    return { ts };
  }
  async react(target: string, message: string, emoji: string) {
    await (await this.api()).put(route.reaction(target, message, emoji));
  }
}

export function chatFor(root: string, config: Config, onError?: OnError): Chat {
  if (config.adapter === 'mock') return new MockChat(root, config.channel, onError);
  const file = join(root, 'secrets', 'discord-token');
  if (!existsSync(file)) throw new Error('no secrets/discord-token; see docs/ideas.md');
  if (!/^\d+$/.test(config.channel)) throw new Error('ideas/config.json needs the Discord channel id in "channel"');
  return new DiscordChat({ token: readFileSync(file, 'utf8').trim(), channel: config.channel, cursorFile: join(root, 'ideas', 'discord-cursor.json'), onError });
}
