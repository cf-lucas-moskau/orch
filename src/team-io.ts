// IO glue for team-general and implementers-discussions: finding their ids, the bridge's team-general handler and
// `orch team` / `orch impl`. team-general is kept in ideas/team/<date>.jsonl; only messages for orch and suggestions
// about the bridge reach the watcher.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chatFor, MockChat, PinRefused, writeAtomic, type Chat } from './discord.ts';
import { draftText, feed, isOff, loadConfig, loadIdeas, textOf, type Deps } from './ideas-io.ts';
import type { Incoming } from './ideas.ts';
import { backlogPage, CHANNELS, classify, outward, raisePost, teamLine, teamRecord, type Channel, type TeamRecord } from './team.ts';

const teamDir = (root: string) => join(root, 'ideas', 'team');
const BACKLOG = 200, BACKLOG_MAX = 1000;
const fail = (msg: string): never => { throw new Error(msg); };

// The channel's id from ideas/config.json, or found by its name and written there. A non-numeric id on the live
// adapter (a mock name left over) is looked up again.
export async function channelId(root: string, chat: Chat, which: Channel): Promise<string> {
  const config = loadConfig(root);
  const known = config[which];
  if (known && (config.adapter === 'mock' || /^\d+$/.test(known))) return known;
  const id = await chat.findChannel(CHANNELS[which]) ?? fail(`no text channel named ${CHANNELS[which]} in the ideas channel's server`);
  const f = join(root, 'ideas', 'config.json');
  const raw = existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : {};
  writeAtomic(f, JSON.stringify({ ...raw, [which]: id }, null, 2) + '\n');
  return id;
}

const day = (iso: string) => new Date(iso).toLocaleDateString('sv-SE');
const store = (root: string, r: TeamRecord) => {
  mkdirSync(teamDir(root), { recursive: true });
  appendFileSync(join(teamDir(root), `${day(r.ts)}.jsonl`), JSON.stringify(r) + '\n');
};

// The bridge's handler for a top-level post in team-general. me: the bot's user id.
export function teamMessage(d: Deps, m: Incoming, me: string) {
  const now = (d.now ?? (() => new Date().toISOString()))();
  const r = teamRecord(m, classify(m, { me, allowlist: loadConfig(d.root).allowlist, off: isOff(d.root) }), now);
  store(d.root, r);
  if (r.kind !== 'other') feed(d.root, teamLine(r), now, 'Team');
}

const TEAM_USAGE = `usage: orch team backlog [n] | say <text|file>
       orch team fake "<text>" --as <user> [--reply-to <user>]   (mock adapter only)
       files are read only from ideas/drafts/`;
const IMPL_USAGE = `usage: orch impl say <text|file> | raise <idea id> <text|file> | pin <file>
       pin takes ideas/vision.md or a file under ideas/drafts/; say and raise read files only from ideas/drafts/`;

const chatOf = (d: Deps) => d.chat ?? chatFor(d.root, loadConfig(d.root), d.log);
const now = (d: Deps) => (d.now ?? (() => new Date().toISOString()))();
// The kill switch silences orch in every channel.
const notOff = (d: Deps) => { if (isOff(d.root)) fail('the idea bridge is off (ideas/off); orch posts nothing in Discord while it is'); };
const nonEmpty = (text: string) => text || fail('nothing left to post once links, mentions, paths and tokens are taken out');

async function say(d: Deps, chat: Chat, which: Channel, text: string) {
  notOff(d);
  const id = await channelId(d.root, chat, which);
  const posted = await chat.reply(id, nonEmpty(text));
  d.log(`${which} say: ${text.replace(/\s+/g, ' ').slice(0, 120)}`);
  return { id, posted };
}

export async function team(args: string[], d: Deps): Promise<string> {
  const [sub, ...rest] = args;
  const chat = chatOf(d);
  if (sub === 'backlog') {
    const n = rest[0] === undefined ? BACKLOG : Number(rest[0]);
    if (!Number.isInteger(n) || n < 1 || n > BACKLOG_MAX) fail(`backlog takes a count from 1 to ${BACKLOG_MAX}`);
    const msgs = await chat.history(await channelId(d.root, chat, 'team'), n);
    writeAtomic(join(teamDir(d.root), 'backlog.md'), backlogPage(msgs, now(d)));
    return `wrote ideas/team/backlog.md (${msgs.length} messages)`;
  }
  if (sub === 'say') {
    const text = outward(textOf(d.root, rest));
    const { posted } = await say(d, chat, 'team', text);
    store(d.root, { id: posted.ids[0] ?? '', ts: posted.ts ?? now(d), author: { id: 'orch', name: 'orch' }, text, kind: 'sent' });
    return `posted in ${CHANNELS.team}`;
  }
  if (sub === 'fake') {
    if (!(chat instanceof MockChat)) fail('fake posts only work with the mock adapter');
    const flag = (f: string) => rest.includes(f) ? rest[rest.indexOf(f) + 1] : undefined;
    const as = flag('--as'), replyTo = flag('--reply-to');
    const text = rest.filter((a, i) => !['--as', '--reply-to'].includes(a) && !['--as', '--reply-to'].includes(rest[i - 1])).join(' ').trim();
    if (!as || !text) fail(TEAM_USAGE);
    const m = (chat as MockChat).post(as, text, undefined, now(d), [], { channel: await channelId(d.root, chat, 'team'), replyTo });
    return `posted ${m.id} as ${as} in ${CHANNELS.team}`;
  }
  return fail(TEAM_USAGE);
}

export async function impl(args: string[], d: Deps): Promise<string> {
  const [sub, ...rest] = args;
  const chat = chatOf(d);
  if (sub === 'say') {
    await say(d, chat, 'impl', outward(textOf(d.root, rest)));
    return `posted in ${CHANNELS.impl}`;
  }
  if (sub === 'raise') {
    const [ideaId, ...words] = rest;
    const ideas = loadIdeas(d.root, d.log);
    const idea = ideas.find(i => i.id === ideaId) ?? fail(ideaId ? `no idea ${ideaId}` : IMPL_USAGE);
    if (!idea.thread) fail(`${idea.id} has no thread yet`);
    const body = textOf(d.root, words);
    if (!body) fail(IMPL_USAGE);
    nonEmpty(outward(body));
    await say(d, chat, 'impl', raisePost(idea, body, ideas));
    return `raised ${idea.id} in ${CHANNELS.impl}`;
  }
  if (sub === 'pin') {
    if (rest.length !== 1) fail(IMPL_USAGE);
    const text = draftText(d.root, rest[0], true) ?? fail(`pin takes ideas/vision.md or a file under ideas/drafts/, not ${rest[0]}`);
    const { id, posted } = await say(d, chat, 'impl', outward(text));
    // Pinned last part first, so Discord's pin list, newest pin on top, reads in order.
    try { for (const m of [...posted.ids].reverse()) await chat.pin(id, m); }
    catch (e) {
      // A half-pinned post is taken back whatever went wrong, so a rerun starts clean.
      for (const m of posted.ids) await chat.remove(id, m).catch(err => d.log(`impl pin: could not take back message ${m}: ${err instanceof Error ? err.message : err}`));
      if (!(e instanceof PinRefused)) fail(`pin failed, the post was taken back: ${e instanceof Error ? e.message : e}`);
      fail(`the bot may not pin messages in ${CHANNELS.impl}: give its role the Pin Messages permission there (Server Settings, Roles, or the channel's permissions) and run impl pin again. The post was taken back.`);
    }
    d.log(`impl pin: ${rest[0]} posted and pinned (${posted.ids.length} message${posted.ids.length > 1 ? 's' : ''})`);
    return `posted ${rest[0]} in ${CHANNELS.impl} and pinned it`;
  }
  return fail(IMPL_USAGE);
}
