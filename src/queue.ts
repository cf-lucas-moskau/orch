// The decision queue: everything that waits on the user, ranked most urgent first, with the words each answer key
// hands orch. Pure; src/queue-run.ts reads the ledger and serves the page.
import { createHash } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import type { FeedEvent } from './board.ts';
import type { Worker } from './dispatch.ts';
import type { Idea } from './ideas.ts';
import { classify } from './triage.ts';
import { actions } from '../mod/hooks/core.ts';

export type Kind = 'decision' | 'blocked' | 'question' | 'idea' | 'merge' | 'deploy';
// Lower ranks first; inside a kind the older item first.
export const RANK: Record<Kind, number> = { decision: 0, blocked: 1, question: 2, idea: 3, merge: 4, deploy: 5 };
export type Link = { label: string; url: string };
// accept goes out as is; reject and edit are prefills the user finishes typing.
export type Answers = { accept: string; reject: string; edit: string };
// key: one occurrence (a decision, a worker's prompt at its feed ts, an idea's question at its askedAt).
// rev: a hash of everything else, so a changed item is a new version of the same occurrence.
export type Item = {
  key: string; rev: string; kind: Kind; title: string; who: string; since: string;
  recommendation: string; detail: string; links: Link[]; media: string[]; docs: string[]; answers: Answers;
};
type Draft = Omit<Item, 'rev'>;
export type Ledger = {
  root: string;
  decisions: { id: string; md: string }[];
  workers: Worker[];
  feed: FeedEvent[];
  ideas: Idea[];
  // Media files per idea id: its progress notes' media and the team's screenshots, oldest first.
  ideaFiles: Record<string, string[]>;
  log: string;
  // GitHub's state of each PR url (OPEN, MERGED, CLOSED); a PR merged outside orch never gets a merge line.
  prStates: Record<string, string>;
};

const MEDIA = /(?:^|[\s`'"(<])((?:\/|~\/|\.{0,2}\/?[\w.-]+\/)[^\s`'"()<>]*\.(?:png|jpe?g|gif|webp|mp4|webm|mov))(?=$|[\s`'")>.,;:])/gim;
const URL_RE = /https?:\/\/[^\s`'")<>\]]+/g;
const VIDEO = /\.(mp4|webm|mov)$/i;
export const isVideo = (p: string) => VIDEO.test(p);

// Image and clip paths a text names, absolute; relative ones are taken from orch's folder.
export function mediaPaths(text: string, root: string, home = ''): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(MEDIA)) {
    const p = m[1].replace(/[.,;:]+$/, '');
    out.add(p.startsWith('~/') ? join(home, p.slice(2)) : isAbsolute(p) ? p : join(root, p));
  }
  return [...out];
}

export function urls(text: string): Link[] {
  const seen = new Set<string>();
  const out: Link[] = [];
  for (const m of text.matchAll(URL_RE)) {
    const url = m[0].replace(/[.,;:]+$/, '');
    if (seen.has(url)) continue;
    seen.add(url);
    const pr = url.match(/github\.com\/[^/]+\/([^/]+)\/pull\/(\d+)/);
    out.push({ label: pr ? `${pr[1]} #${pr[2]}` : url.replace(/^https?:\/\//, ''), url });
  }
  return out;
}

const section = (md: string, name: string) => md.match(new RegExp(`^## ${name}\\s*\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm'))?.[1]?.trim() ?? '';
const field = (md: string, k: string) => md.match(new RegExp(`^- ${k}: (.*)$`, 'm'))?.[1]?.trim() ?? '';

function decisions(l: Ledger): Draft[] {
  return l.decisions.flatMap(({ id, md }) => {
    if ((field(md, 'Status').split(/\s/)[0] || 'open') !== 'open') return [];
    const d = { id, question: md.match(/^# D-\d+: (.*)$/m)?.[1]?.trim() ?? id, status: 'open', session: field(md, 'Session'), opened: field(md, 'Opened'), recommendation: '' };
    const stakes = field(md, 'Stakes'), gates = field(md, 'Gates');
    const detail = [
      stakes && `Stakes: ${stakes}`, gates && `Gates: ${gates}`,
      ...['Facts', 'Options'].map(s => section(md, s) && `${s}\n${section(md, s)}`),
    ].filter(Boolean).join('\n\n');
    return [{
      key: id, kind: 'decision' as const, title: `${id}: ${d.question}`, who: d.session, since: d.opened,
      recommendation: section(md, 'Recommendation'), detail, links: urls(md), media: mediaPaths(md, l.root),
      docs: [join(l.root, 'decisions', `${id}.md`)],
      answers: { accept: actions.accept(d), reject: actions.reject(d), edit: `${id}: ` },
    }];
  });
}

// A running worker whose latest event is a permission prompt, or a stop that ends on a question nobody answered yet.
// The key names the occurrence (the event's ts), so an answer to one prompt can never land on the next one.
// Codex panes have no session id in herdr, so their events are found by the worker's worktree, as the watcher does.
function workerAsks(l: Ledger): Draft[] {
  return l.workers.filter(w => w.status === 'running').flatMap(w => {
    const evs = l.feed.filter(e => (w.sid ? e.sid === w.sid : e.cwd === w.worktree && e.agent === 'codex')).sort((a, b) => a.ts.localeCompare(b.ts));
    const last = evs.at(-1);
    if (!last) return [];
    const k = classify(last);
    if (k !== 'blocked' && k !== 'question') return [];
    const said = k === 'blocked' ? last.msg : [last.msg, last.tail && !last.msg.endsWith(last.tail.slice(-40)) ? `…${last.tail}` : ''].filter(Boolean).join('\n');
    const steer = (t: string) => actions.steer(w.name, t);
    return [{
      key: `worker:${w.name}@${last.ts}`, kind: k, title: k === 'blocked' ? `${w.name} is blocked: ${last.msg}` : `${w.name} asks`,
      who: `${w.name} (${w.repo}, ${w.pane})`, since: last.ts, recommendation: '', detail: said,
      links: urls(said), media: mediaPaths(said, l.root),
      docs: [], answers: k === 'blocked'
        ? { accept: `${w.name} waits on a permission prompt: allow it.`, reject: `${w.name} waits on a permission prompt: deny it, `, edit: `${w.name} waits on a permission prompt: ` }
        : { accept: steer('yes, go with your recommendation.'), reject: steer('no, '), edit: steer('') },
    }];
  });
}

// An idea question still open: not answered, not timed out.
function ideaAsks(l: Ledger): Draft[] {
  return l.ideas.flatMap(i => {
    if (i.state === 'closed') return [];
    const q = (i.questions ?? []).filter(x => !x.answered && !x.timedOut).at(-1);
    if (!q) return [];
    const name = i.title?.title ?? i.text.split('\n')[0];
    const files = l.ideaFiles[i.id] ?? [];
    return [{
      key: `idea:${i.id}@${q.askedAt}`, kind: 'idea' as const, title: `${i.id} · ${name}`, who: `asks ${i.author.name}${q.wait ? ', no timeout' : ''}`,
      since: q.askedAt, recommendation: q.recommend ?? '', detail: q.text, links: urls(q.text),
      media: files.slice(-4), docs: [join(l.root, 'ideas', i.id, 'dossier.md')],
      answers: { accept: `${i.id}: answer the open question with your recommendation.`, reject: `${i.id}: not your recommendation, `, edit: `${i.id}: ` },
    }];
  });
}

// The newest review of a branch, from the log's `review <repo> <label>: ... -> reviews/<file>` lines. The label is the
// branch, or the branch, a dash and the reviewed paths for `--only`; a label that belongs to a longer branch of the
// same repo (idea-44-2 next to idea-44) is that branch's.
export function reviewFor(log: string, repo: string, branch: string, branches: string[]): string | undefined {
  const longer = branches.filter(b => b !== branch && b.startsWith(`${branch}-`));
  const mine = (label: string) => (label === branch || label.startsWith(`${branch}-`))
    && !longer.some(b => label === b || label.startsWith(`${b}-`));
  let file: string | undefined;
  for (const m of log.matchAll(/^- \S+ \S+ review (\S+) (\S+): .* -> reviews\/(\S+\.md)$/gm))
    if (m[1] === repo && mine(m[2])) file = m[3];
  return file;
}

export function openedPrs(log: string): Map<string, { ts: string; url: string; repo: string; pr: string }> {
  const opened = new Map<string, { ts: string; url: string; repo: string; pr: string }>();
  for (const m of log.matchAll(/^- (\S+ \S+) open-pr (\S+) \([^)]*\): (https:\/\/github\.com\/[^/]+\/([^/]+)\/pull\/(\d+))/gm))
    opened.set(m[2], { ts: m[1], url: m[3], repo: m[4], pr: m[5] });
  return opened;
}

// PRs orch opened for a running worker that are still open.
function merges(l: Ledger): Draft[] {
  const merged = new Set([...l.log.matchAll(/^- \S+ \S+ merge (\S+) #(\d+) \([^)]*\): squash-merged/gm)].map(m => `${m[1]}#${m[2]}`));
  const opened = openedPrs(l.log);
  return l.workers.filter(w => w.status === 'running').flatMap(w => {
    const o = opened.get(w.name);
    if (!o || merged.has(`${o.repo}#${o.pr}`) || ['MERGED', 'CLOSED'].includes(l.prStates[o.url] ?? '')) return [];
    const review = reviewFor(l.log, w.repo, w.prHead ?? w.branch, l.workers.filter(x => x.repo === w.repo).map(x => x.prHead ?? x.branch));
    return [{
      key: `merge:${o.repo}#${o.pr}`, kind: 'merge' as const, title: `Merge ${o.repo} #${o.pr} (${w.name})`, who: `${w.name} (${w.branch})`,
      since: o.ts, recommendation: '', detail: w.task, links: [{ label: `${o.repo} #${o.pr}`, url: o.url }],
      media: [], docs: review ? [join(l.root, 'reviews', review)] : [],
      answers: { accept: `Merge ${o.url} (${w.name}).`, reject: `Don't merge ${o.url} yet: `, edit: `${o.url}: ` },
    }];
  });
}

function deploys(l: Ledger): Draft[] {
  return l.ideas.filter(i => i.state === 'building' && i.stage === 'deploying').map(i => ({
    key: `deploy:${i.id}@${i.round ?? 1}`, kind: 'deploy' as const, title: `Deploy ${i.id} · ${i.title?.title ?? i.text.split('\n')[0]}`,
    who: i.worker ?? '', since: i.updated, recommendation: '', detail: i.plan ?? '', links: [],
    media: (l.ideaFiles[i.id] ?? []).slice(-4), docs: [join(l.root, 'ideas', i.id, 'dossier.md')],
    answers: { accept: `Deploy ${i.id} now.`, reject: `Hold the deploy of ${i.id}: `, edit: `${i.id} deploy: ` },
  }));
}

const when = (s: string) => { const t = Date.parse(s); return Number.isNaN(t) ? Infinity : t; };
// rev: a hash of everything the user saw, so an answer to an item that changed since it was opened is refused.
const revOf = (i: Draft) => createHash('sha256').update(JSON.stringify(i)).digest('hex').slice(0, 16);

export function buildQueue(l: Ledger): Item[] {
  return [...decisions(l), ...workerAsks(l), ...ideaAsks(l), ...merges(l), ...deploys(l)]
    .map(i => ({ ...i, rev: revOf(i) }))
    .sort((a, b) => RANK[a.kind] - RANK[b.kind] || when(a.since) - when(b.since) || a.key.localeCompare(b.key));
}

// An answer must start with one of the item's own answers, so the page can only say what a key offers.
export function validAnswer(item: Item, text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (t === item.answers.accept.trim()) return true;
  return [item.answers.reject, item.answers.edit].some(p => t.startsWith(p.trim()) && t.length > p.trim().length);
}

export type Answer = { key?: unknown; rev?: unknown; text?: unknown };
// What the server checks before anything goes to orch: the item opened is still there unchanged, nobody answered it
// already or is answering it now, and the text is one of its answers. The item to answer, or why not.
export function checkAnswer(items: Item[], a: Answer, busy: { sending: Set<string>; sent: Map<string, unknown> }):
  { item: Item; text: string } | { status: 400 | 409; error: string } {
  const item = items.find(i => i.key === a.key);
  if (!item) return { status: 409, error: `${String(a.key)} left the queue; nothing was sent` };
  if (item.rev !== a.rev) return { status: 409, error: `${item.key} changed since you opened it; look again` };
  if (busy.sending.has(item.key)) return { status: 409, error: `${item.key} is being answered right now` };
  if (busy.sent.has(item.key)) return { status: 409, error: `${item.key} was already answered` };
  const text = String(a.text ?? '').trim();
  if (!validAnswer(item, text)) return { status: 400, error: 'that answer does not match the item' };
  return { item, text };
}
