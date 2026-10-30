// Chat adapters for the idea bridge. mock: JSONL files under ideas/mock/ (inbox written by `orch idea fake`,
// outbox read by tests and people). discord: the discord.js gateway for incoming messages, REST for posting.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { split, type Config, type Incoming } from './ideas.ts';

export interface Chat {
  onMessage(handler: (m: Incoming) => Promise<void>): void;
  start(): Promise<void>;
  stop(): Promise<void>;
  // Opens a thread on a top-level post in the ideas channel and returns the thread's id.
  createThread(message: string, name: string): Promise<string>;
  // target is a thread or channel id; long text goes out as several messages.
  reply(target: string, text: string): Promise<void>;
  react(target: string, message: string, emoji: string): Promise<void>;
}

export type Outgoing =
  | { kind: 'thread'; message: string; thread: string; name: string }
  | { kind: 'reply'; target: string; text: string }
  | { kind: 'react'; target: string; message: string; emoji: string };

export type OnError = (msg: string) => void;
const toConsole: OnError = msg => console.error(new Date().toISOString(), msg);
const why = (e: unknown) => e instanceof Error ? e.message : String(e);

const lines = (file: string) => existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];

export class MockChat implements Chat {
  private handler: (m: Incoming) => Promise<void> = async () => {};
  private timer?: NodeJS.Timeout;
  readonly dir: string;
  private channel: string;
  private onError: OnError;
  constructor(root: string, channel: string, onError: OnError = toConsole) {
    this.channel = channel;
    this.onError = onError;
    this.dir = join(root, 'ideas', 'mock');
    mkdirSync(this.dir, { recursive: true });
  }
  private out(o: Outgoing) { appendFileSync(join(this.dir, 'outbox.jsonl'), JSON.stringify({ ts: new Date().toISOString(), ...o }) + '\n'); }
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
  async reply(target: string, text: string) { for (const t of split(text)) this.out({ kind: 'reply', target, text: t }); }
  async react(target: string, message: string, emoji: string) { this.out({ kind: 'react', target, message, emoji }); }
  outbox(): (Outgoing & { ts: string })[] { return lines(join(this.dir, 'outbox.jsonl')).map(l => JSON.parse(l)); }
  // `orch idea fake`: post as someone, at the top level or inside an idea's thread. Mock user ids are their names.
  post(as: string, text: string, thread?: string): Incoming {
    const file = join(this.dir, 'inbox.jsonl');
    const m: Incoming = { id: `m${lines(file).length + 1}`, channel: thread ?? this.channel, ...(thread ? { thread } : {}), author: { id: as, name: as }, text };
    appendFileSync(file, JSON.stringify(m) + '\n');
    return m;
  }
}

// Mentions are never pinged, whatever the text says.
const NO_PINGS = { parse: [] };

export class DiscordChat implements Chat {
  private handler: (m: Incoming) => Promise<void> = async () => {};
  private client: any;
  private rest: any;
  private token: string;
  private channel: string;
  private onError: OnError;
  private stub?: any;
  // stub stands in for the discord.js module in tests.
  constructor(token: string, channel: string, onError: OnError = toConsole, stub?: any) {
    this.token = token;
    this.channel = channel;
    this.onError = onError;
    this.stub = stub;
  }
  private async lib(): Promise<any> {
    if (this.stub) return this.stub;
    try { return await import('discord.js'); }
    catch { throw new Error('discord.js is not installed: run npm install in orch'); }
  }
  private async api() {
    if (!this.rest) {
      const { REST } = await this.lib();
      this.rest = new REST({ version: '10' }).setToken(this.token);
    }
    return this.rest;
  }
  onMessage(handler: (m: Incoming) => Promise<void>) { this.handler = handler; }
  async start() {
    const { Client, GatewayIntentBits } = await this.lib();
    this.client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
    this.client.on('messageCreate', (m: any) => {
      if (m.author.bot) return;
      const inThread = m.channel.isThread();
      if ((inThread ? m.channel.parentId : m.channelId) !== this.channel) return;
      this.handler({ id: m.id, channel: m.channelId, ...(inThread ? { thread: m.channelId } : {}), author: { id: m.author.id, name: m.author.username }, text: m.content })
        .catch(e => this.onError(`discord message ${m.id} failed: ${why(e)}`));
    });
    await this.client.login(this.token);
  }
  async stop() { await this.client?.destroy(); }
  async createThread(message: string, name: string) {
    const { Routes } = await this.lib();
    const t = await (await this.api()).post(Routes.threads(this.channel, message), { body: { name, auto_archive_duration: 10080 } });
    return t.id as string;
  }
  async reply(target: string, text: string) {
    const { Routes } = await this.lib();
    for (const content of split(text)) await (await this.api()).post(Routes.channelMessages(target), { body: { content, allowed_mentions: NO_PINGS } });
  }
  async react(target: string, message: string, emoji: string) {
    const { Routes } = await this.lib();
    await (await this.api()).put(Routes.channelMessageOwnReaction(target, message, encodeURIComponent(emoji)));
  }
}

export function chatFor(root: string, config: Config, onError?: OnError): Chat {
  if (config.adapter === 'mock') return new MockChat(root, config.channel, onError);
  const file = join(root, 'secrets', 'discord-token');
  if (!existsSync(file)) throw new Error('no secrets/discord-token; see docs/ideas.md');
  if (!/^\d+$/.test(config.channel)) throw new Error('ideas/config.json needs the Discord channel id in "channel"');
  return new DiscordChat(readFileSync(file, 'utf8').trim(), config.channel, onError);
}
