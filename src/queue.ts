// The decision queue: everything that waits on the user, ranked most urgent first, with the words each answer key
// hands orch. Pure; src/queue-run.ts reads the ledger and serves the page.
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
export type Item = {
  key: string; kind: Kind; title: string; who: string; since: string;
  recommendation: string; detail: string; links: Link[]; media: string[]; docs: string[]; answers: Answers;
};
export type Ledger = {
  root: string;
  decisions: { id: string; md: string }[];
  workers: Worker[];
  feed: FeedEvent[];
  ideas: Idea[];
  // Media files per idea id: its progress notes' media and the team's screenshots, oldest first.
  ideaFiles: Record<string, string[]>;
  log: string;
  reviews: string[];
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

function decisions(l: Ledger): Item[] {
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
function workerAsks(l: Ledger): Item[] {
  return l.workers.filter(w => w.status === 'running' && w.sid).flatMap(w => {
    const evs = l.feed.filter(e => e.sid === w.sid).sort((a, b) => a.ts.localeCompare(b.ts));
    const last = evs.at(-1);
    if (!last) return [];
    const k = classify(last);
    if (k !== 'blocked' && k !== 'question') return [];
    const said = k === 'blocked' ? last.msg : [last.msg, last.tail && !last.msg.endsWith(last.tail.slice(-40)) ? `…${last.tail}` : ''].filter(Boolean).join('\n');
    const steer = (t: string) => actions.steer(w.name, t);
    return [{
      key: `worker:${w.name}`, kind: k, title: k === 'blocked' ? `${w.name} is blocked: ${last.msg}` : `${w.name} asks`,
      who: `${w.name} (${w.repo}, ${w.pane})`, since: last.ts, recommendation: '', detail: said,
      links: urls(said), media: mediaPaths(said, l.root),
      docs: [], answers: k === 'blocked'
        ? { accept: `${w.name} waits on a permission prompt: allow it.`, reject: `${w.name} waits on a permission prompt: deny it, `, edit: `${w.name} waits on a permission prompt: ` }
        : { accept: steer('yes, go with your recommendation.'), reject: steer('no, '), edit: steer('') },
    }];
  });
}

// An idea question still open: not answered, not timed out.
function ideaAsks(l: Ledger): Item[] {
  return l.ideas.flatMap(i => {
    if (i.state === 'closed') return [];
    const q = (i.questions ?? []).filter(x => !x.answered && !x.timedOut).at(-1);
    if (!q) return [];
    const name = i.title?.title ?? i.text.split('\n')[0];
    const files = l.ideaFiles[i.id] ?? [];
    return [{
      key: `idea:${i.id}`, kind: 'idea' as const, title: `${i.id} · ${name}`, who: `asks ${i.author.name}${q.wait ? ', no timeout' : ''}`,
      since: q.askedAt, recommendation: q.recommend ?? '', detail: q.text, links: urls(q.text),
      media: files.slice(-4), docs: [join(l.root, 'ideas', i.id, 'dossier.md')],
      answers: { accept: `${i.id}: answer the open question with your recommendation.`, reject: `${i.id}: not your recommendation, `, edit: `${i.id}: ` },
    }];
  });
}

// The newest review of a branch; review files are named <date>-<repo>-<label stripped to [a-z0-9-], 30 chars>.md.
export function reviewFor(files: string[], repo: string, branch: string): string | undefined {
  const label = branch.replace(/[^a-z0-9-]+/gi, '').slice(0, 20);
  return files.filter(f => f.includes(`-${repo}-${label}`) && !f.endsWith('-judge.md')).sort().at(-1);
}

export function openedPrs(log: string): Map<string, { ts: string; url: string; repo: string; pr: string }> {
  const opened = new Map<string, { ts: string; url: string; repo: string; pr: string }>();
  for (const m of log.matchAll(/^- (\S+ \S+) open-pr (\S+) \([^)]*\): (https:\/\/github\.com\/[^/]+\/([^/]+)\/pull\/(\d+))/gm))
    opened.set(m[2], { ts: m[1], url: m[3], repo: m[4], pr: m[5] });
  return opened;
}

// PRs orch opened for a running worker that are still open.
function merges(l: Ledger): Item[] {
  const merged = new Set([...l.log.matchAll(/^- \S+ \S+ merge (\S+) #(\d+) \([^)]*\): squash-merged/gm)].map(m => `${m[1]}#${m[2]}`));
  const opened = openedPrs(l.log);
  return l.workers.filter(w => w.status === 'running').flatMap(w => {
    const o = opened.get(w.name);
    if (!o || merged.has(`${o.repo}#${o.pr}`) || ['MERGED', 'CLOSED'].includes(l.prStates[o.url] ?? '')) return [];
    const review = reviewFor(l.reviews, w.repo, w.prHead ?? w.branch);
    return [{
      key: `merge:${o.repo}#${o.pr}`, kind: 'merge' as const, title: `Merge ${o.repo} #${o.pr} (${w.name})`, who: `${w.name} (${w.branch})`,
      since: o.ts, recommendation: '', detail: w.task, links: [{ label: `${o.repo} #${o.pr}`, url: o.url }],
      media: [], docs: review ? [join(l.root, 'reviews', review)] : [],
      answers: { accept: `Merge ${o.url} (${w.name}).`, reject: `Don't merge ${o.url} yet: `, edit: `${o.url}: ` },
    }];
  });
}

function deploys(l: Ledger): Item[] {
  return l.ideas.filter(i => i.state === 'building' && i.stage === 'deploying').map(i => ({
    key: `deploy:${i.id}`, kind: 'deploy' as const, title: `Deploy ${i.id} · ${i.title?.title ?? i.text.split('\n')[0]}`,
    who: i.worker ?? '', since: i.updated, recommendation: '', detail: i.plan ?? '', links: [],
    media: (l.ideaFiles[i.id] ?? []).slice(-4), docs: [join(l.root, 'ideas', i.id, 'dossier.md')],
    answers: { accept: `Deploy ${i.id} now.`, reject: `Hold the deploy of ${i.id}: `, edit: `${i.id} deploy: ` },
  }));
}

const when = (s: string) => { const t = Date.parse(s); return Number.isNaN(t) ? Infinity : t; };

export function buildQueue(l: Ledger): Item[] {
  return [...decisions(l), ...workerAsks(l), ...ideaAsks(l), ...merges(l), ...deploys(l)]
    .sort((a, b) => RANK[a.kind] - RANK[b.kind] || when(a.since) - when(b.since) || a.key.localeCompare(b.key));
}

// An answer must start with one of the item's own answers, so the page can only say what a key offers.
export function validAnswer(item: Item, text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (t === item.answers.accept.trim()) return true;
  return [item.answers.reject, item.answers.edit].some(p => t.startsWith(p.trim()) && t.length > p.trim().length);
}
